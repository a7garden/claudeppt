// 담당 — 덱 하나를 여러 Claude Code 세션이 나눠 고칠 때, 세션 하나가 「담당」 하나를 맡는다 (화면 · 안내에는 「1번 담당」).
//
//   정의     .claudeppt/seats.json      번호 · 이름 · 색 · 맡은 범위(쪽 · 테마 · 쪽 구성 · 덱 관리). 앱의 「담당」 창에서 사용자가 정한다
//   맡음     .claudeppt/presence.json   담당 번호 → 맡은 세션(CLAUDE_CODE_SESSION_ID) · 맡은 때 · 마지막 명령 때 · 지금 하는 일
//   기록     .claudeppt/activity.jsonl  담당마다 한 일 한 줄씩 — 앱의 「담당」 창이 읽는다
//
// 세션은 join 으로 한 번 맡으면 그 뒤 명령마다 환경 변수(CLAUDE_CODE_SESSION_ID)로 담당을 찾는다 — 명령마다 --seat 를 붙이지 않아도 된다.
// 범위는 판을 남길 때 지킨다 — commit 이 맡은 파일만 담고, 쪽 구성 · 되돌리기 · 릴리즈는 그 권한이 없으면 거절한다.
// 파일 고치기 자체는 막지 못한다. Claude Code 의 Edit 를 CLI 가 가로챌 수 없어서, 맡지 않은 파일이 바뀌면 판에서 빼고 앱이 알린다.
// 앱 상태 폴더(.claudeppt)라 판에 들어가지 않는다 — 같은 PC 의 세션끼리 나눈다 (Remote Control 로 붙은 세션도 이 PC 에서 돈다).

use serde_json::{Value, json};
use std::io::Write;
use std::path::Path;

type R<T> = Result<T, String>;

/// 마지막 명령 뒤 이 시간이 지나면 「비어 있음」으로 본다 — 다른 세션이 번호를 대고 맡을 수 있다.
/// 2026.11.25 : 30분. Claude Code 세션은 사용자 답을 기다리며 몇십 분 쉬기도 해서 짧게 잡으면 일하는 중에 빼앗긴다
pub const STALE_MS: i64 = 30 * 60 * 1000;
/// 담당 색 — 주홍(--accent)은 핀의 색이라 쓰지 않는다. src/lib/seats.ts PALETTE 와 같은 차례
const PALETTE: &[&str] = &["#4f8cff", "#3fb68b", "#b58cff", "#e0a83a", "#35b8c8", "#ff7eb6"];

pub fn now() -> i64 {
	chrono::Utc::now().timestamp_millis()
}

fn state(dir: &Path) -> std::path::PathBuf {
	dir.join(".claudeppt")
}

fn read(dir: &Path, name: &str) -> Option<Value> {
	serde_json::from_str(&std::fs::read_to_string(state(dir).join(name)).ok()?).ok()
}

/// 앱과 CLI 가 같은 파일을 쓴다 — 반쯤 쓴 파일을 읽지 않게 임시 파일에 쓰고 바꿔 단다
fn write(dir: &Path, name: &str, v: &Value) -> R<()> {
	let d = state(dir);
	std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
	let tmp = d.join(format!("{name}.{}.tmp", std::process::id()));
	std::fs::write(&tmp, serde_json::to_string_pretty(v).map_err(|e| e.to_string())? + "\n").map_err(|e| e.to_string())?;
	std::fs::rename(&tmp, d.join(name)).map_err(|e| e.to_string())
}

/// 담당 파일 잠금 — 세션마다 CLI 프로세스가 따로 돌며 presence.json 을 읽고 고쳐 쓴다.
/// 잠그지 않으면 두 세션이 같은 때 쓴 것 가운데 하나가 사라진다 (한 세션의 「지금 하는 일」이 지워지는 식으로).
/// 기다려도 안 풀리면 그냥 간다 — 담당 파일은 보이려고 두는 것이라 명령을 막을 만큼 중하지 않다
struct Lock(Option<std::path::PathBuf>);

impl Drop for Lock {
	fn drop(&mut self) {
		if let Some(p) = &self.0 {
			let _ = std::fs::remove_file(p);
		}
	}
}

fn lock(dir: &Path) -> Lock {
	let _ = std::fs::create_dir_all(state(dir));
	let p = state(dir).join("seats.lock");
	let t0 = std::time::Instant::now();
	while t0.elapsed() < std::time::Duration::from_secs(5) {
		if std::fs::OpenOptions::new().write(true).create_new(true).open(&p).is_ok() {
			return Lock(Some(p));
		}
		// 죽은 프로세스가 남긴 잠금
		if p.metadata().and_then(|m| m.modified()).ok().and_then(|m| m.elapsed().ok()).is_some_and(|e| e.as_secs() > 30) {
			let _ = std::fs::remove_file(&p);
			continue;
		}
		std::thread::sleep(std::time::Duration::from_millis(20));
	}
	Lock(None)
}

pub fn list(dir: &Path) -> Vec<Value> {
	read(dir, "seats.json").and_then(|v| v["seats"].as_array().cloned()).unwrap_or_default()
}

fn save(dir: &Path, seats: &[Value]) -> R<()> {
	write(dir, "seats.json", &json!({ "seats": seats }))
}

/// 담당 번호(문자열) → { session, since, seen, doing? }
pub fn presence(dir: &Path) -> serde_json::Map<String, Value> {
	read(dir, "presence.json").and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

fn save_presence(dir: &Path, p: &serde_json::Map<String, Value>) -> R<()> {
	write(dir, "presence.json", &Value::Object(p.clone()))
}

/// 한 일 한 줄 — 실패해도 명령은 그대로 간다 (기록은 보이려고 남기는 것이다)
pub fn log(dir: &Path, seat: u64, cmd: &str, text: &str) {
	let line = json!({ "at": now(), "seat": seat, "cmd": cmd, "text": text });
	let _ = std::fs::create_dir_all(state(dir));
	if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(state(dir).join("activity.jsonl")) {
		let _ = writeln!(f, "{line}");
	}
}

/// 이 명령을 부른 세션 — --session · Claude Code 가 Bash 에 주는 CLAUDE_CODE_SESSION_ID · CPPT_SESSION 순서
pub fn session(given: Option<&str>) -> Option<String> {
	given
		.map(String::from)
		.or_else(|| std::env::var("CLAUDE_CODE_SESSION_ID").ok())
		.or_else(|| std::env::var("CPPT_SESSION").ok())
		.filter(|x| !x.trim().is_empty())
}

pub fn no(seat: &Value) -> u64 {
	seat["no"].as_u64().unwrap_or(0)
}

pub fn label(seat: &Value) -> String {
	let name = seat["name"].as_str().unwrap_or("").trim();
	if name.is_empty() { format!("{}번 담당", no(seat)) } else { format!("{}번 담당 · {name}", no(seat)) }
}

/// 번호 또는 이름으로
pub fn find(seats: &[Value], key: &str) -> Option<Value> {
	let k = key.trim().trim_end_matches("번");
	seats.iter().find(|s| k.parse::<u64>().ok() == Some(no(s)) || s["name"].as_str().is_some_and(|n| n.trim().eq_ignore_ascii_case(key.trim()))).cloned()
}

fn fresh(p: &Value) -> bool {
	now() - p["seen"].as_i64().unwrap_or(0) < STALE_MS
}

/// 이 세션이 맡은 담당
pub fn mine(dir: &Path, sid: &str) -> Option<Value> {
	let p = presence(dir);
	let (k, _) = p.iter().find(|(_, v)| v["session"].as_str() == Some(sid))?;
	find(&list(dir), k)
}

/// 담당이 이 파일(덱 폴더 기준 상대 경로)을 판에 넣을 수 있는지
pub fn allows(seat: &Value, deck: &Value, rel: &str) -> bool {
	let rel = rel.replace('\\', "/");
	if let Some(file) = rel.strip_prefix("slides/") {
		let id = file.trim_end_matches(".html");
		// 목차에 없는 쪽 파일 — 막 더한 쪽이거나 뺀 쪽이다. 쪽 구성 권한이 있어야 한다
		let listed = deck["slides"].as_array().is_some_and(|v| v.iter().any(|x| x["id"].as_str() == Some(id)));
		return match &seat["slides"] {
			Value::String(x) if x == "all" => true,
			Value::Array(ids) => ids.iter().any(|x| x.as_str() == Some(id)) || (!listed && flag(seat, "order")),
			_ => false,
		};
	}
	if rel == "theme.css" {
		return flag(seat, "theme");
	}
	if rel == "deck.json" {
		return flag(seat, "order");
	}
	// 그림 · 글꼴은 여러 쪽이 함께 쓰고 새 파일만 생기는 일이 대부분이다 — 쪽을 맡았으면 넣는다
	if rel.starts_with("assets/") {
		return true;
	}
	flag(seat, "manage")
}

pub fn flag(seat: &Value, k: &str) -> bool {
	seat[k].as_bool() == Some(true)
}

/// 맡은 쪽 — 지금 목차 번호와 함께. 「모든 쪽」이면 "all"
pub fn scope_slides(seat: &Value, deck: &Value) -> Value {
	let all = deck["slides"].as_array().cloned().unwrap_or_default();
	match &seat["slides"] {
		Value::Array(ids) => json!(all
			.iter()
			.enumerate()
			.filter(|(_, x)| ids.iter().any(|i| i == &x["id"]))
			.map(|(i, x)| json!({ "no": i + 1, "id": x["id"], "file": x["file"], "title": x["title"] }))
			.collect::<Vec<_>>()),
		_ => json!("all"),
	}
}

/// 세션에게 줄 규칙 글
pub fn rules(seat: &Value, deck: &Value) -> String {
	let sl = scope_slides(seat, deck);
	let slides = match sl.as_array() {
		None => "모든 쪽".to_string(),
		Some(v) if v.is_empty() => "맡은 쪽 없음 (읽기만)".to_string(),
		Some(v) => v.iter().map(|x| format!("{}쪽({})", x["no"], x["file"].as_str().unwrap_or(""))).collect::<Vec<_>>().join(" · "),
	};
	let yn = |k: &str| if flag(seat, k) { "한다" } else { "하지 않는다" };
	format!(
		"{} — 고칠 수 있는 쪽: {slides}. theme.css 고치기: {}. 쪽 더하기 · 빼기 · 옮기기(deck.json): {}. 되돌리기 · 릴리즈: {}.\n\
		 맡지 않은 파일은 읽기만 한다. commit 은 맡은 파일만 판에 넣고, 나머지는 left 로 돌려준다 — 네가 고친 것이 left 에 있으면 되돌린다.",
		label(seat),
		yn("theme"),
		yn("order"),
		yn("manage"),
	)
}

fn view(dir: &Path, seat: &Value, deck: &Value, me: Option<&str>) -> Value {
	let p = presence(dir);
	let at = p.get(&no(seat).to_string()).cloned().unwrap_or(Value::Null);
	let taken = !at.is_null() && fresh(&at);
	json!({
		"no": no(seat),
		"name": seat["name"],
		"color": seat["color"],
		"slides": scope_slides(seat, deck),
		"theme": flag(seat, "theme"),
		"order": flag(seat, "order"),
		"manage": flag(seat, "manage"),
		"taken": taken,
		"mine": me.is_some() && at["session"].as_str() == me,
		"seen": at["seen"],
		"doing": at["doing"],
	})
}

pub fn seats_cmd(dir: &Path, deck: &Value, sid: Option<&str>) -> Value {
	let all = list(dir);
	let me = sid.and_then(|s| mine(dir, s));
	json!({
		"seats": all.iter().map(|x| view(dir, x, deck, sid)).collect::<Vec<_>>(),
		"me": me.as_ref().map(no),
		"session": sid,
	})
}

/// 담당을 맡는다. key 가 없으면 이미 맡은 담당 → 빈 담당 차례. 담당이 하나도 없으면 「모든 권한」 1번을 만든다 (혼자 쓰던 길이 그대로 되게)
pub fn join(dir: &Path, deck: &Value, sid: &str, key: Option<&str>, name: Option<&str>, take: bool) -> R<Value> {
	let _l = lock(dir);
	let mut all = list(dir);
	let mut p = presence(dir);
	let held = |p: &serde_json::Map<String, Value>, n: u64| p.get(&n.to_string()).filter(|v| fresh(v) && v["session"].as_str() != Some(sid)).cloned();
	let seat = if all.is_empty() {
		let s = json!({ "no": 1, "name": name.unwrap_or(""), "color": PALETTE[0], "slides": "all", "theme": true, "order": true, "manage": true });
		all.push(s.clone());
		save(dir, &all)?;
		s
	} else if let Some(k) = key {
		let s = find(&all, k).ok_or_else(|| format!("없는 담당: {k} — 있는 담당: {} (사용자가 앱의 「담당」에서 더한다)", all.iter().map(label).collect::<Vec<_>>().join(" / ")))?;
		if let Some(h) = held(&p, no(&s)) {
			if !take {
				let ago = (now() - h["seen"].as_i64().unwrap_or(0)) / 60000;
				return Err(format!("다른 세션이 맡고 있는 담당이다: {} (마지막 명령 {ago}분 전) — 사용자에게 묻고, 넘겨받으라 하면 --take", label(&s)));
			}
		}
		s
	} else if let Some(s) = mine(dir, sid) {
		s
	} else {
		all.iter()
			.find(|s| held(&p, no(s)).is_none())
			.cloned()
			.ok_or_else(|| format!("빈 담당이 없다 — 모두 맡겨져 있다: {} (사용자에게 앱의 「담당」에서 더해 달라고 한다)", all.iter().map(label).collect::<Vec<_>>().join(" / ")))?
	};
	// --name 을 주면 그 담당의 이름을 바꾼다 — 앱의 「담당」 창에서 고치는 이름과 같은 칸
	let seat = match name.map(str::trim).filter(|x| !x.is_empty()) {
		Some(nm) if seat["name"].as_str() != Some(nm) => {
			let n = no(&seat);
			let mut all = list(dir);
			for s in all.iter_mut().filter(|x| no(x) == n) {
				s["name"] = json!(nm);
			}
			save(dir, &all)?;
			find(&all, &n.to_string()).unwrap_or(seat)
		}
		_ => seat,
	};
	// 한 세션은 한 덱에서 담당 하나만 맡는다
	p.retain(|_, v| v["session"].as_str() != Some(sid));
	let t = now();
	p.insert(no(&seat).to_string(), json!({ "session": sid, "since": t, "seen": t }));
	save_presence(dir, &p)?;
	log(dir, no(&seat), "join", "맡음");
	let mut v = view(dir, &seat, deck, Some(sid));
	v["rules"] = json!(rules(&seat, deck));
	Ok(v)
}

pub fn leave(dir: &Path, sid: &str) -> R<Value> {
	let _l = lock(dir);
	let mut p = presence(dir);
	let gone: Vec<String> = p.iter().filter(|(_, v)| v["session"].as_str() == Some(sid)).map(|(k, _)| k.clone()).collect();
	p.retain(|_, v| v["session"].as_str() != Some(sid));
	save_presence(dir, &p)?;
	for k in &gone {
		log(dir, k.parse().unwrap_or(0), "leave", "내려놓음");
	}
	Ok(json!({ "left": gone }))
}

/// 지금 하는 일 — 앱의 「담당」 창과 쪽 목록에 보인다. ids 는 쪽 id(번호는 순서가 바뀌면 다른 쪽을 가리킨다)
pub fn doing(dir: &Path, seat: &Value, text: Option<&str>, ids: Vec<String>) -> R<Value> {
	let _l = lock(dir);
	let mut p = presence(dir);
	let k = no(seat).to_string();
	let cur = p.get_mut(&k).ok_or("이 담당을 맡고 있지 않다 — join 부터 한다")?;
	match text {
		Some(t) => {
			cur["doing"] = json!({ "text": t, "slides": ids, "at": now() });
			log(dir, no(seat), "doing", t);
		}
		None => {
			if let Some(o) = cur.as_object_mut() {
				o.remove("doing");
			}
		}
	}
	let out = cur.clone();
	save_presence(dir, &p)?;
	Ok(out)
}

/// 이 세션이 명령을 불렀다 — 마지막 명령 때를 고친다
pub fn seen(dir: &Path, seat: &Value) {
	let _l = lock(dir);
	let mut p = presence(dir);
	if let Some(v) = p.get_mut(&no(seat).to_string()) {
		v["seen"] = json!(now());
		let _ = save_presence(dir, &p);
	}
}

/// 쪽을 더한 담당은 그 쪽도 맡는다 — 안 그러면 막 더한 쪽을 판에 넣지 못한다
pub fn adopt(dir: &Path, seat: &Value, id: &str) {
	let _l = lock(dir);
	let mut all = list(dir);
	let n = no(seat);
	if let Some(s) = all.iter_mut().find(|x| no(x) == n) {
		if let Some(ids) = s["slides"].as_array_mut() {
			ids.push(json!(id));
			let _ = save(dir, &all);
		}
	}
}
