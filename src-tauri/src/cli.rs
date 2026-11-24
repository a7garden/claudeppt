// CLI — 같은 실행 파일에 명령 인자를 주면 창 없이 명령으로 돈다 (main.rs). 앱 밖 Claude Code 가 스킬 「claudeppt」로 부른다.
//
// 목차
//   명령 표          COMMANDS · HELP
//   인자 · 경로      Args · fix_path (Git Bash 의 /d/… 꼴도 받는다)
//   덱 찾기          deck_dir — --deck · 지금 폴더에서 위로 · 앱에 열린 덱 순서
//   앱 없이 하는 일   list · info · log · commit · restore · pack · unpack · paths — 파일과 git 만 본다
//   스킬 깔기        skill — 스킬 「claudeppt」(저장소 skill/SKILL.md 를 실행 파일에 담아 둔다)와 cppt 꾸러미를 ~/.claude/skills 에 쓴다
//   앱에 넘기는 일    status · open · new · import · export · shot · inspect · check · release
//                    웹뷰가 쪽을 그려야 하는 일이라 실행 중인 앱에 넘긴다 (control.rs → src/lib/remote.ts)
//   앱 부르기        call — control.json 으로 찾아 붙고, 꺼져 있으면 띄운 뒤 준비될 때까지 기다린다
//
// 출력은 늘 stdout 에 JSON 하나다 — 에이전트가 그대로 읽는다. 실패면 {"ok":false,"error":…} 와 종료 코드 1.
// 쪽 번호는 1부터 센다 (deck.json 의 slides 순서). 앱 안의 「@3」 과 같은 번호다.

use crate::{control, project, vcs};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

type R<T> = Result<T, String>;

const COMMANDS: &[&str] = &[
	"help", "skill", "paths", "status", "list", "info", "log", "commit", "restore", "pack", "unpack",
	"launch", "open", "new", "import", "export", "shot", "inspect", "check", "release",
];

const HELP: &str = "ClaudePPT CLI — 출력은 JSON 하나. 쪽 번호는 1부터.

덱 고르기 (모든 명령 공통): --deck <폴더 | deck.json | 저장 폴더 안 이름>
  주지 않으면 지금 폴더에서 위로 deck.json 을 찾고, 없으면 앱에 열린 덱을 쓴다.

앱 없이
  skill [--to <폴더>]                Claude Code 스킬 「claudeppt」를 깐다 (기본 ~/.claude/skills/claudeppt)
  paths                              저장 폴더 · 앱 데이터 · 실행 파일 위치
  list                               저장 폴더의 덱 목록 (최근 고친 순)
  info                               덱 목차 · 지금 판 · 릴리즈
  log [-n 20]                        판 이력 (v<n> = 커밋 수)
  commit -m \"<메시지>\" [--force]      바뀐 파일을 한 판으로 남긴다
  restore <v3 | 3 | 커밋> [--force]    그 판의 파일로 되돌려 새 판으로 남긴다 (이력은 지우지 않는다)
  pack <out.cppt>                    폴더째 한 파일로 묶는다 (판 이력 포함)
  unpack <file.cppt> [--to <폴더>]   묶음을 저장 폴더에 푼다

앱에 넘김 (꺼져 있으면 띄운다)
  status                             앱이 켜져 있는지 · 열린 덱 · 앱 안 Claude 가 일하는 중인지
  launch                             앱만 띄운다
  open [--slide 3]                   덱을 앱 화면에 연다 · 그 쪽으로 간다
  new <제목> [--template <이름>] [--no-open]
                                     저장 폴더에 새 덱 (표지 한 장) · 템플릿의 스타일 규칙(style)을 돌려준다
  import <file.pptx> [--no-open]     PPTX 를 가져와 새 덱으로
  export <out.pptx> [--exact]        PPTX 로 내보낸다. --exact 는 모양 그대로(그림 + 투명 글상자)
  shot [--slides 1,3-5] [--out <폴더>] [--scale 1]
                                     쪽을 브라우저가 그린 그대로 PNG 로 굽는다 (기본 .claudeppt/shots/<n>.png)
  inspect [--slides 1,3-5]           PPTX 로 나갈 때 무엇이 편집 가능한 도형 · 글상자가 되고 무엇이 그림으로 굳는지, 쪽 밖으로 넘친 것
  check                              PPTX 를 PowerPoint 로 그려 웹과 픽셀로 견준다 (PowerPoint 필요)
  release [--name <이름>] [--notes <메모>]
                                     릴리즈 r<k> — releases/r<k>-v<n>.pptx 와 git 태그
";

/// 창 앱은 인자를 받지 않는다 — 인자가 하나라도 있으면 CLI 다. 틀린 명령 이름에 창이 뜨지 않고 도움말로 답하게
pub fn wants(args: &[String]) -> bool {
	!args.is_empty()
}

pub fn main(args: Vec<String>) -> i32 {
	let cmd = args[0].as_str();
	if matches!(cmd, "help" | "--help" | "-h") {
		print!("{HELP}");
		return 0;
	}
	let a = Args::parse(&args[1..]);
	match run(cmd, &a) {
		Ok(v) => {
			println!("{}", serde_json::to_string_pretty(&json!({ "ok": true, "data": v })).unwrap());
			0
		}
		Err(e) => {
			println!("{}", serde_json::to_string_pretty(&json!({ "ok": false, "error": e })).unwrap());
			1
		}
	}
}

fn run(cmd: &str, a: &Args) -> R<Value> {
	match cmd {
		"paths" => Ok(json!({
			"exe": std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
			"data": control::data_dir(),
			"library": library(),
			"control": control::control_file(),
		})),
		"skill" => skill(a),
		"list" => list(),
		"info" => info(&deck_dir(a)?),
		"log" => {
			let n = a.get("n").map(|s| s.parse().map_err(|_| "-n 은 숫자")).transpose()?.unwrap_or(20);
			Ok(json!(vcs::vcs_log(s(&deck_dir(a)?), Some(n))?))
		}
		"commit" => {
			let dir = deck_dir(a)?;
			let msg = a.get("m").ok_or("-m \"<메시지>\" 가 필요하다")?;
			guard(&dir, a)?;
			let c = vcs::vcs_commit(s(&dir), msg.into())?;
			refresh(&dir, "commit");
			Ok(match c { Some(c) => json!(c), None => json!({ "unchanged": true }) })
		}
		"restore" => restore(&deck_dir(a)?, a),
		"pack" => {
			let dir = deck_dir(a)?;
			let out = abs(a.pos(0).ok_or("묶을 파일 경로(<out.cppt>)가 필요하다")?);
			project::pack_deck(s(&dir), s(&out))?;
			Ok(json!({ "out": out }))
		}
		"unpack" => {
			let file = abs(a.pos(0).ok_or("풀 파일(<file.cppt>)이 필요하다")?);
			let name = file.file_stem().map(|x| x.to_string_lossy().into_owned()).unwrap_or("deck".into());
			let dest = a.get("to").map(abs).unwrap_or_else(|| library().join(name));
			Ok(json!({ "dir": project::unpack_deck(s(&file), s(&dest))? }))
		}
		"status" => match connect() {
			Some(c) if !c.enabled => Ok(json!({ "app": true, "enabled": false, "error": OFF })),
			Some(c) => c.call("status", json!({})),
			None => Ok(json!({ "app": false })),
		},
		"launch" => {
			app()?;
			Ok(json!({ "app": true }))
		}
		"open" => {
			let slide = a.get("slide").map(|x| x.parse::<u32>().map_err(|_| "--slide 는 숫자")).transpose()?;
			app()?.call("open", json!({ "dir": deck_dir(a)?, "slide": slide }))
		}
		"new" => {
			let title = a.pos.join(" ");
			app()?.call("new", json!({ "title": title, "template": a.get("template"), "open": !a.has("no-open") }))
		}
		"import" => {
			let file = abs(a.pos(0).ok_or("가져올 PPTX 경로가 필요하다")?);
			if !file.is_file() {
				return Err(format!("파일이 없다: {}", file.display()));
			}
			app()?.call("import", json!({ "path": file, "open": !a.has("no-open") }))
		}
		"export" => {
			let dir = deck_dir(a)?;
			let out = abs(a.pos(0).ok_or("내보낼 경로(<out.pptx>)가 필요하다")?);
			app()?.call("export", json!({ "dir": dir, "out": out, "exact": a.has("exact") }))
		}
		"shot" => {
			let dir = deck_dir(a)?;
			let out = a.get("out").map(abs).unwrap_or_else(|| dir.join(".claudeppt").join("shots"));
			let scale = a.get("scale").map(|x| x.parse::<f64>().map_err(|_| "--scale 은 숫자")).transpose()?.unwrap_or(1.0);
			app()?.call("shot", json!({ "dir": dir, "slides": slides(a)?, "out": out, "scale": scale }))
		}
		"inspect" => {
			let dir = deck_dir(a)?;
			app()?.call("inspect", json!({ "dir": dir, "slides": slides(a)? }))
		}
		"check" => app()?.call("check", json!({ "dir": deck_dir(a)? })),
		"release" => {
			let dir = deck_dir(a)?;
			app()?.call("release", json!({ "dir": dir, "name": a.get("name").unwrap_or(""), "notes": a.get("notes").unwrap_or("") }))
		}
		_ => Err(format!("모르는 명령: {cmd} — 쓸 수 있는 명령: {} (help 로 자세히)", COMMANDS.join(" "))),
	}
}

// ── 인자 · 경로 ──

struct Args {
	pos: Vec<String>,
	opt: HashMap<String, String>,
}

/// 값을 받는 선택지. 나머지 --이름 은 켜고 끄기다
const VALUED: &[&str] = &["deck", "m", "message", "n", "out", "slides", "slide", "scale", "name", "notes", "to", "template"];

impl Args {
	fn parse(raw: &[String]) -> Args {
		let mut a = Args { pos: vec![], opt: HashMap::new() };
		let mut it = raw.iter();
		while let Some(x) = it.next() {
			let key = x.strip_prefix("--").or_else(|| x.strip_prefix('-').filter(|k| k.len() == 1));
			match key {
				Some(k) => {
					let (k, inline) = match k.split_once('=') {
						Some((k, v)) => (k, Some(v.to_string())),
						None => (k, None),
					};
					let k = if k == "message" { "m" } else { k };
					let v = if VALUED.contains(&k) { inline.or_else(|| it.next().cloned()).unwrap_or_default() } else { "1".into() };
					a.opt.insert(k.into(), v);
				}
				None => a.pos.push(x.clone()),
			}
		}
		a
	}
	fn get(&self, k: &str) -> Option<&str> {
		self.opt.get(k).map(String::as_str)
	}
	fn has(&self, k: &str) -> bool {
		self.opt.contains_key(k)
	}
	fn pos(&self, i: usize) -> Option<&str> {
		self.pos.get(i).map(String::as_str)
	}
}

/// Git Bash 가 넘기는 /d/workspace/… 를 D:\workspace\… 로
fn fix_path(p: &str) -> String {
	let b = p.as_bytes();
	if b.len() >= 2 && b[0] == b'/' && b[1].is_ascii_alphabetic() && (b.len() == 2 || b[2] == b'/') {
		return format!("{}:\\{}", (b[1] as char).to_ascii_uppercase(), p.get(3..).unwrap_or("").replace('/', "\\"));
	}
	p.to_string()
}

fn abs(p: &str) -> PathBuf {
	let p = PathBuf::from(fix_path(p));
	std::path::absolute(&p).unwrap_or(p)
}

fn s(p: &Path) -> String {
	p.to_string_lossy().into_owned()
}

/// 「1,3-5」 → [1,3,4,5]. 없으면 null — 모든 쪽
fn slides(a: &Args) -> R<Value> {
	let Some(spec) = a.get("slides") else { return Ok(Value::Null) };
	let mut out = vec![];
	for part in spec.split(',').map(str::trim).filter(|x| !x.is_empty()) {
		let num = |x: &str| x.trim().parse::<u32>().map_err(|_| format!("--slides 를 읽지 못했다: {spec}"));
		match part.split_once('-') {
			Some((x, y)) => out.extend(num(x)?..=num(y)?),
			None => out.push(num(part)?),
		}
	}
	Ok(json!(out))
}

// ── 덱 찾기 ──

fn library() -> PathBuf {
	let set = std::fs::read_to_string(control::data_dir().join("settings.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
	match set.as_ref().and_then(|v| v["library"].as_str()).filter(|x| !x.is_empty()) {
		Some(l) => PathBuf::from(l),
		None => dirs::document_dir().unwrap_or_else(|| dirs::home_dir().unwrap_or_default()).join("ClaudePPT"),
	}
}

fn deck_dir(a: &Args) -> R<PathBuf> {
	if let Some(d) = a.get("deck") {
		let p = abs(d);
		let p = if p.file_name().is_some_and(|f| f.eq_ignore_ascii_case("deck.json")) { p.parent().unwrap().to_path_buf() } else { p };
		if p.join("deck.json").is_file() {
			return Ok(p);
		}
		let named = library().join(d);
		if named.join("deck.json").is_file() {
			return Ok(named);
		}
		return Err(format!("덱을 찾지 못했다: {d} (폴더 · deck.json · 저장 폴더 안 이름)"));
	}
	// 지금 폴더에서 위로 — slides/ 안에서 불러도 그 덱을 찾는다
	if let Ok(mut d) = std::env::current_dir() {
		loop {
			if d.join("deck.json").is_file() {
				return Ok(d);
			}
			if !d.pop() {
				break;
			}
		}
	}
	if let Some(c) = connect().filter(|c| c.enabled) {
		if let Some(d) = c.call("status", json!({}))?["dir"].as_str().filter(|x| !x.is_empty()) {
			return Ok(PathBuf::from(d));
		}
	}
	Err("덱을 고르지 않았다 — --deck <폴더> 를 주거나 덱 폴더 안에서 부르거나 앱에서 덱을 연다".into())
}

// ── 앱 없이 하는 일 ──

fn list() -> R<Value> {
	let lib = library();
	let items = json!(project::library_list(s(&lib))?);
	let decks: Vec<Value> = items
		.as_array()
		.unwrap()
		.iter()
		.map(|x| json!({ "dir": x["dir"], "title": x["deck"]["title"], "slides": x["deck"]["slides"].as_array().map_or(0, |v| v.len()), "modified": x["modified"] }))
		.collect();
	Ok(json!({ "library": lib, "decks": decks }))
}

/// 스킬 본문은 CLI 와 판을 맞추려고 실행 파일에 담는다 — 앱을 새 판으로 올리면 skill 을 다시 부르면 된다
const SKILL_MD: &str = include_str!("../../skill/SKILL.md");

const WRAPPER: &str = r#"#!/usr/bin/env bash
# ClaudePPT CLI 꾸러미 — claudeppt.exe skill 이 썼다. 실행 파일을 찾아 인자를 그대로 넘긴다.
# 찾는 차례: $CLAUDEPPT_EXE → 이 꾸러미를 쓴 실행 파일 → 설치 자리(%LOCALAPPDATA%\ClaudePPT)
for c in "$CLAUDEPPT_EXE" "{exe}" "$LOCALAPPDATA/ClaudePPT/claudeppt.exe"; do
	[ -n "$c" ] && [ -f "$c" ] && exec "$c" "$@"
done
echo '{"ok":false,"error":"ClaudePPT 실행 파일을 찾지 못했다 — 앱을 깔거나 CLAUDEPPT_EXE 를 준다"}'
exit 1
"#;

fn skill(a: &Args) -> R<Value> {
	install_skill(a.get("to").map(abs))?;
	Ok(skill_state(a.get("to").map(abs)))
}

/// 사용자 스킬 자리 — Claude Code 가 어느 폴더에서 열든 읽는다
pub fn skill_dir() -> PathBuf {
	dirs::home_dir().unwrap_or_default().join(".claude").join("skills").join("claudeppt")
}

fn exe_slash() -> String {
	std::env::current_exe().map(|p| s(&p).replace('\\', "/")).unwrap_or_default()
}

/// Claude Code 의 Bash(Git Bash)가 부르는 꾸러미. 이 실행 파일을 먼저 찾고, 옮겨졌으면 설치 자리를 본다
fn wrapper() -> String {
	WRAPPER.replace("{exe}", &exe_slash())
}

/// SKILL.md 와 cppt 꾸러미를 쓴다. 설정 화면 「바깥 연결 › 스킬」과 CLI skill 이 같이 쓴다
pub fn install_skill(to: Option<PathBuf>) -> R<()> {
	let to = to.unwrap_or_else(skill_dir);
	std::fs::create_dir_all(&to).map_err(|e| e.to_string())?;
	std::fs::write(to.join("SKILL.md"), SKILL_MD).map_err(|e| e.to_string())?;
	std::fs::write(to.join("cppt"), wrapper()).map_err(|e| e.to_string())
}

/// 깔린 스킬이 이 실행 파일과 맞는지 — current 가 false 면 앱을 새 판으로 올렸거나 실행 파일이 옮겨진 것이다
pub fn skill_state(to: Option<PathBuf>) -> Value {
	let to = to.unwrap_or_else(skill_dir);
	let md = std::fs::read_to_string(to.join("SKILL.md")).ok();
	let wr = std::fs::read_to_string(to.join("cppt")).ok();
	// 꾸러미에 적힌 실행 파일 — 다른 판의 앱이 깔았으면 그 경로가 보인다
	let linked = wr.as_deref().and_then(|w| w.lines().find(|l| l.starts_with("for c in")).and_then(|l| l.split('"').nth(3)).map(String::from));
	json!({
		"dir": to,
		"installed": md.is_some() && wr.is_some(),
		"current": md.as_deref() == Some(SKILL_MD) && wr.as_deref() == Some(wrapper().as_str()),
		"exe": exe_slash(),
		"linked": linked,
	})
}

fn info(dir: &Path) -> R<Value> {
	let deck: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("deck.json")).map_err(|e| e.to_string())?).map_err(|e| format!("deck.json 을 읽지 못했다: {e}"))?;
	let slides: Vec<Value> = deck["slides"]
		.as_array()
		.map(|v| v.iter().enumerate().map(|(i, x)| json!({ "no": i + 1, "id": x["id"], "file": x["file"], "title": x["title"] })).collect())
		.unwrap_or_default();
	let head = vcs::vcs_log(s(dir), Some(1)).ok().and_then(|v| v.into_iter().next());
	let releases = std::fs::read_to_string(dir.join("releases").join("releases.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(json!([]));
	Ok(json!({
		"dir": dir,
		"title": deck["title"],
		"size": deck["size"],
		"theme": deck["theme"],
		"source": deck["source"],
		"slides": slides,
		"version": head,
		"releases": releases,
	}))
}

fn restore(dir: &Path, a: &Args) -> R<Value> {
	let want = a.pos(0).ok_or("되돌릴 판(v3 · 3 · 커밋)이 필요하다")?;
	guard(dir, a)?;
	let log = vcs::vcs_log(s(dir), None)?;
	let log = json!(log);
	let n = want.trim_start_matches(['v', 'V']).parse::<u64>().ok();
	let hit = log.as_array().unwrap().iter().find(|c| match n {
		Some(n) => c["n"].as_u64() == Some(n),
		None => c["hash"].as_str().is_some_and(|h| h.starts_with(want)),
	});
	let c = hit.ok_or(format!("판을 찾지 못했다: {want}"))?;
	let r = vcs::vcs_restore(s(dir), c["hash"].as_str().unwrap().into(), format!("v{} 으로 되돌린다", c["n"]))?;
	refresh(dir, "restore");
	Ok(json!(r))
}

/// 앱 안 Claude 가 이 덱을 고치는 중이면 판을 남기거나 되돌리지 않는다 — 반쯤 고친 파일이 판에 들어가거나 덮인다
fn guard(dir: &Path, a: &Args) -> R<()> {
	if a.has("force") {
		return Ok(());
	}
	let Some(c) = connect().filter(|c| c.enabled) else { return Ok(()) };
	let st = c.call("status", json!({}))?;
	if st["running"].as_bool() == Some(true) && st["dir"].as_str().is_some_and(|d| same(Path::new(d), dir)) {
		return Err("앱 안 Claude 가 이 덱을 고치는 중이다 — 끝난 뒤 다시 하거나 --force".into());
	}
	Ok(())
}

fn same(a: &Path, b: &Path) -> bool {
	s(a).trim_end_matches('\\').eq_ignore_ascii_case(s(b).trim_end_matches('\\'))
}

/// 앱이 이 덱을 열어 두었으면 판 목록 · 릴리즈를 다시 읽게 한다. 파일 변경은 폴더 감시가 잡지만 .git 은 보지 않는다
fn refresh(dir: &Path, why: &str) {
	if let Some(c) = connect().filter(|c| c.enabled) {
		let _ = c.call("refresh", json!({ "dir": dir, "why": why }));
	}
}

// ── 앱 부르기 ──

const OFF: &str = "앱의 「설정 › 바깥 연결 › 바깥 제어」가 꺼져 있다 — 사용자에게 켜 달라고 한다";

struct Conn {
	port: u16,
	token: String,
	// 설정 「바깥 연결 › 바깥 제어」가 켜져 있는지. 꺼져 있어도 ping 에는 답한다 — 그래야 CLI 가 앱을 하나 더 띄우지 않는다
	enabled: bool,
}

impl Conn {
	fn raw(&self, cmd: &str, args: Value) -> R<Value> {
		let addr = std::net::SocketAddr::from(([127, 0, 0, 1], self.port));
		let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(|e| format!("앱에 붙지 못했다: {e}"))?;
		s.write_all(format!("{}\n", json!({ "token": self.token, "cmd": cmd, "args": args })).as_bytes()).map_err(|e| e.to_string())?;
		let mut line = String::new();
		BufReader::new(s).read_line(&mut line).map_err(|e| e.to_string())?;
		serde_json::from_str(&line).map_err(|_| "앱의 답을 읽지 못했다".to_string())
	}
	fn call(&self, cmd: &str, args: Value) -> R<Value> {
		let r = self.raw(cmd, args)?;
		if r["ok"].as_bool() == Some(true) { Ok(r["data"].clone()) } else { Err(r["error"].as_str().unwrap_or("앱이 실패를 알렸다").into()) }
	}
}

/// 켜져 있고 답하는 앱. control.json 이 남아 있어도 앱이 죽었으면 None
fn connect() -> Option<Conn> {
	let v: Value = serde_json::from_str(&std::fs::read_to_string(control::control_file()).ok()?).ok()?;
	let mut c = Conn { port: v["port"].as_u64()? as u16, token: v["token"].as_str()?.into(), enabled: true };
	let r = c.raw("ping", json!({})).ok().filter(|r| r["ok"].as_bool() == Some(true))?;
	c.enabled = r["data"]["enabled"].as_bool() != Some(false);
	Some(c)
}

/// 앱에 붙는다. 꺼져 있으면 이 실행 파일을 인자 없이 띄우고, 화면이 준비될 때까지(최대 90초) 기다린다
fn app() -> R<Conn> {
	if let Some(c) = connect() {
		if !c.enabled {
			return Err(OFF.into());
		}
		return Ok(c);
	}
	let exe = std::env::current_exe().map_err(|e| e.to_string())?;
	let mut cmd = std::process::Command::new(&exe);
	cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
	#[cfg(windows)]
	{
		use std::os::windows::process::CommandExt;
		// DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP — CLI 가 끝나도 앱은 남는다
		cmd.creation_flags(0x0000_0008 | 0x0000_0200);
		no_inherit_stdio();
	}
	cmd.spawn().map_err(|e| format!("앱을 띄우지 못했다: {e}"))?;
	let t0 = Instant::now();
	while t0.elapsed() < Duration::from_secs(90) {
		std::thread::sleep(Duration::from_millis(400));
		if let Some(c) = connect() {
			return Ok(c);
		}
	}
	Err(format!("앱을 띄웠지만 90초 안에 준비되지 않았다 ({})", exe.display()))
}

/// 이 프로세스의 표준 입출력 핸들을 앱에 물려주지 않게 한다.
/// 물려주면 셸(Claude Code 의 Bash)이 그 파이프가 닫히기를 — 곧 앱이 꺼지기를 — 기다리며 멈춘다.
#[cfg(windows)]
fn no_inherit_stdio() {
	unsafe extern "system" {
		fn GetStdHandle(n: u32) -> isize;
		fn SetHandleInformation(h: isize, mask: u32, flags: u32) -> i32;
	}
	for n in [-10i32, -11, -12] {
		unsafe {
			let h = GetStdHandle(n as u32);
			if h != 0 && h != -1 {
				SetHandleInformation(h, 1, 0);
			}
		}
	}
}
