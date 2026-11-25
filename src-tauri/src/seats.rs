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

/// 고쳐 쓰기 전에 읽는다 — 파일이 없으면 빈 목록, 있는데 못 읽으면 잠시 다시 읽고 그래도 안 되면 오류.
/// 2026.11.25 : 못 읽은 것을 빈 목록으로 보면 join 이 「모든 권한」 1번을 만들어(이름을 바꿀 때는 빈 목록을) 저장해,
///              사용자가 정한 담당이 사라졌다. 앱이 이 파일을 잠금 없이 반쯤 쓰는 동안 읽으면 그렇게 됐다
fn load(dir: &Path) -> R<Vec<Value>> {
	let p = state(dir).join("seats.json");
	for _ in 0..10 {
		match std::fs::read_to_string(&p) {
			Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
			Ok(t) => {
				if let Ok(v) = serde_json::from_str::<Value>(&t) {
					return Ok(v["seats"].as_array().cloned().unwrap_or_default());
				}
			}
			Err(_) => {}
		}
		std::thread::sleep(std::time::Duration::from_millis(30));
	}
	Err("담당 파일(.claudeppt/seats.json)을 읽지 못했다 — 잠시 뒤 다시 한다".into())
}

fn save(dir: &Path, seats: &[Value]) -> R<()> {
	write(dir, "seats.json", &json!({ "seats": seats }))
}

/// 앱의 「담당」 창이 고친 것을 파일에 합친다 — 화면이 본 담당(before)과 고친 담당(after)의 차이만 지금 파일에 얹는다.
/// 화면의 사본은 몇 초 묵었을 수 있어서, 통째로 쓰면 그 사이 바깥 세션이 한 일(쪽 맡기 · 이름 · 새 1번)을 덮는다
pub fn update(dir: &Path, before: &[Value], after: &[Value]) -> R<Vec<Value>> {
	let _l = lock(dir);
	let merged = merge(&load(dir)?, before, after);
	save(dir, &merged)?;
	Ok(merged)
}

fn merge(cur: &[Value], before: &[Value], after: &[Value]) -> Vec<Value> {
	let by = |v: &[Value], n: u64| v.iter().find(|x| no(x) == n).cloned();
	let mut out = Vec::new();
	for c in cur {
		match (by(before, no(c)), by(after, no(c))) {
			// 화면에서 지운 담당
			(Some(_), None) => {}
			(Some(b), Some(a)) => out.push(patch(c, &b, &a)),
			// 화면이 몰랐던 담당(그 사이 바깥 세션이 만든 것)
			_ => out.push(c.clone()),
		}
	}
	// 화면이 새로 더한 담당 — 그 번호를 그 사이 다른 쪽이 썼으면 다음 번호로
	for a in after.iter().filter(|a| by(before, no(a)).is_none()) {
		let mut a = a.clone();
		if out.iter().any(|x| no(x) == no(&a)) {
			let next = out.iter().map(no).max().unwrap_or(0) + 1;
			a["no"] = json!(next);
			a["color"] = json!(PALETTE[(next as usize - 1) % PALETTE.len()]);
		}
		out.push(a);
	}
	out.sort_by_key(no);
	out
}

/// 화면이 바꾼 칸만 얹는다. 맡은 쪽 목록은 화면이 더하고 뺀 것만 — 그 사이 바깥 세션이 맡은 쪽(adopt)을 잃지 않게
fn patch(cur: &Value, before: &Value, after: &Value) -> Value {
	let mut out = cur.clone();
	let Some(a) = after.as_object() else { return out };
	for (k, av) in a {
		let bv = &before[k];
		if av == bv {
			continue;
		}
		if let (Some(c), Some(b), Some(aa)) = (cur[k].as_array(), bv.as_array(), av.as_array()) {
			let mut ids: Vec<Value> = c.iter().filter(|x| !b.contains(x) || aa.contains(x)).cloned().collect();
			ids.extend(aa.iter().filter(|x| !b.contains(x) && !c.contains(x)).cloned());
			out[k] = json!(ids);
		} else {
			out[k] = av.clone();
		}
	}
	out
}

/// 앱의 「비우기」 — 맡은 세션을 내보낸다
pub fn vacate(dir: &Path, seat: u64) -> R<()> {
	let _l = lock(dir);
	let mut p = presence(dir);
	if p.remove(&seat.to_string()).is_some() {
		save_presence(dir, &p)?;
	}
	Ok(())
}

// 앱 명령 — 잠금을 기다리며 잠들 수 있어 메인 스레드 밖에서 돈다
#[tauri::command(async)]
pub fn seats_update(dir: String, before: Vec<Value>, after: Vec<Value>) -> R<Vec<Value>> {
	update(Path::new(&dir), &before, &after)
}

#[tauri::command(async)]
pub fn seats_vacate(dir: String, seat: u64) -> R<()> {
	vacate(Path::new(&dir), seat)
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
	let mut all = load(dir)?;
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
			let mut all = load(dir)?;
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
	let Ok(mut all) = load(dir) else { return };
	let n = no(seat);
	if let Some(s) = all.iter_mut().find(|x| no(x) == n) {
		if let Some(ids) = s["slides"].as_array_mut() {
			ids.push(json!(id));
			let _ = save(dir, &all);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn tmp(name: &str) -> std::path::PathBuf {
		let d = std::env::temp_dir().join(format!("cppt-seats-{name}-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&d);
		std::fs::create_dir_all(d.join(".claudeppt")).unwrap();
		d
	}
	fn seat(n: u64, name: &str, slides: Value) -> Value {
		json!({ "no": n, "name": name, "color": PALETTE[0], "slides": slides, "theme": false, "order": false, "manage": false })
	}

	// 반쯤 쓰인 담당 파일을 읽으면 join 이 「모든 권한」 1번으로 덮어써 정한 담당이 사라졌다 — 이제는 거절하고 파일을 그대로 둔다
	#[test]
	fn join_does_not_overwrite_unreadable_seats() {
		let d = tmp("join");
		let half = "{\n  \"seats\": [\n    { \"no\": 1, \"name\": \"도입\"";
		std::fs::write(d.join(".claudeppt/seats.json"), half).unwrap();
		assert!(join(&d, &json!({ "slides": [] }), "s1", None, None, false).is_err());
		assert_eq!(std::fs::read_to_string(d.join(".claudeppt/seats.json")).unwrap(), half);
		let _ = std::fs::remove_dir_all(&d);
	}

	// 담당 파일이 없으면 혼자 쓰던 길 그대로 — 모든 권한 1번을 만든다
	#[test]
	fn join_without_seats_creates_first() {
		let d = tmp("first");
		let v = join(&d, &json!({ "slides": [] }), "s1", None, None, false).unwrap();
		assert_eq!(v["no"], 1);
		assert_eq!(list(&d).len(), 1);
		let _ = std::fs::remove_dir_all(&d);
	}

	// 화면이 이름을 바꾸는 사이 바깥 세션이 쪽을 맡았다(adopt) — 둘 다 남는다
	#[test]
	fn update_keeps_adopted_slide_and_new_name() {
		let before = vec![seat(1, "", json!(["a"]))];
		let cur = vec![seat(1, "", json!(["a", "b"]))];
		let after = vec![seat(1, "도입", json!(["a"]))];
		let m = merge(&cur, &before, &after);
		assert_eq!(m[0]["name"], "도입");
		assert_eq!(m[0]["slides"], json!(["a", "b"]));
	}

	// 화면에서 쪽을 빼고 더한 것만 얹는다
	#[test]
	fn update_applies_slide_add_and_remove() {
		let before = vec![seat(1, "", json!(["a", "b"]))];
		let cur = vec![seat(1, "", json!(["a", "b", "c"]))];
		let after = vec![seat(1, "", json!(["b", "d"]))];
		assert_eq!(merge(&cur, &before, &after)[0]["slides"], json!(["b", "c", "d"]));
	}

	// 화면이 지운 담당은 빠지고, 화면이 몰랐던 담당은 남고, 번호가 겹친 새 담당은 다음 번호로
	#[test]
	fn update_delete_keep_and_renumber() {
		let before = vec![seat(1, "", json!("all")), seat(2, "가", json!([]))];
		let cur = vec![seat(1, "", json!("all")), seat(2, "가", json!([])), seat(3, "바깥", json!([]))];
		let after = vec![seat(1, "", json!("all")), seat(3, "새", json!([]))];
		let m = merge(&cur, &before, &after);
		let names: Vec<_> = m.iter().map(|x| (no(x), x["name"].as_str().unwrap().to_string())).collect();
		assert_eq!(names, vec![(1, "".into()), (3, "바깥".into()), (4, "새".into())]);
		assert_eq!(m[2]["color"], PALETTE[3]);
	}

	// 「모든 쪽」(문자열)과 목록 사이를 바꾸면 화면 값 그대로
	#[test]
	fn update_switches_all_and_list() {
		let before = vec![seat(1, "", json!(["a"]))];
		let after = vec![seat(1, "", json!("all"))];
		assert_eq!(merge(&before, &before, &after)[0]["slides"], "all");
	}

	#[test]
	fn update_writes_file_atomically_and_vacate_removes_presence() {
		let d = tmp("update");
		save(&d, &[seat(1, "", json!(["a"]))]).unwrap();
		let m = update(&d, &[seat(1, "", json!(["a"]))], &[seat(1, "도입", json!(["a"]))]).unwrap();
		assert_eq!(list(&d), m);
		save_presence(&d, json!({ "1": { "session": "s1", "since": 0, "seen": 0 } }).as_object().unwrap()).unwrap();
		vacate(&d, 1).unwrap();
		assert!(presence(&d).is_empty());
		let _ = std::fs::remove_dir_all(&d);
	}
}
