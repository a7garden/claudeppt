// 바깥 제어 통로 — 앱 밖의 Claude Code 세션이 CLI(cli.rs)로 이 앱을 부린다.
//
//   통로     127.0.0.1 의 빈 포트 하나. 한 연결에 JSON 한 줄을 받고 JSON 한 줄로 답한 뒤 닫는다.
//            HTTP 가 아니라서 웹 페이지가 fetch 로 두드려도 첫 줄(「POST / HTTP/1.1」)이 JSON 이 아니라 받지 않는다.
//   열쇠     켤 때마다 새로 만드는 토큰. control.json(앱 데이터 폴더)에 포트 · 토큰 · pid 를 적는다.
//            슬라이드 HTML 안 스크립트가 포트를 찾아내도 토큰 없이는 받지 않는다.
//   처리     ping 말고는 화면(src/lib/remote.ts)에 「remote」 사건으로 넘기고, 화면이 remote_reply 로 답할 때까지 연결을 잡고 기다린다.
//            새로 만들기 · 가져오기 · 내보내기 · 쪽 그림은 웹뷰가 쪽을 그려야 해서 Rust 만으로는 못 한다.
//   준비     화면이 사건을 받을 수 있게 되면 remote_ready 를 부르고, 그때 control.json 을 쓴다 —
//            CLI 는 이 파일이 생기기를 기다려 앱이 다 뜬 것을 안다. 끌 때 지운다.

use crate::{Res, err};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// tauri.conf.json 의 identifier. CLI 는 Tauri 없이 이 이름으로 앱 데이터 폴더를 찾는다
pub const IDENT: &str = "com.seesun.claudeppt";
/// 한 명령을 기다리는 가장 긴 시간 — 큰 PPTX 가져오기 · 비교 검사가 몇 분 걸린다
const WAIT: Duration = Duration::from_secs(60 * 60);

pub fn data_dir() -> PathBuf {
	dirs::data_dir().unwrap_or_default().join(IDENT)
}

pub fn control_file() -> PathBuf {
	data_dir().join("control.json")
}

#[derive(Default)]
pub struct Control {
	port: Mutex<u16>,
	token: String,
	/// 요청 id → 답을 기다리는 연결
	pending: Mutex<HashMap<String, mpsc::Sender<Value>>>,
	/// 설정 「바깥 연결 › 바깥 제어」. 꺼도 통로는 닫지 않고 ping 에만 답한다 — 닫으면 CLI 가 앱이 꺼진 줄 알고 하나 더 띄운다
	enabled: AtomicBool,
	/// 최근 바깥 명령 — 설정 화면에 보인다. 오래된 것부터 버린다
	recent: Mutex<Vec<Value>>,
}

impl Control {
	pub fn new() -> Self {
		Control { token: uuid::Uuid::new_v4().simple().to_string(), enabled: AtomicBool::new(true), ..Default::default() }
	}
}

/// 통로를 연다. control.json 은 화면이 준비된 뒤(remote_ready) 쓴다
pub fn start(app: &AppHandle) -> Res<()> {
	let listener = TcpListener::bind("127.0.0.1:0").map_err(err)?;
	*app.state::<Control>().port.lock().unwrap() = listener.local_addr().map_err(err)?.port();
	let app = app.clone();
	std::thread::spawn(move || {
		for s in listener.incoming().flatten() {
			let app = app.clone();
			std::thread::spawn(move || {
				let _ = serve(&app, s);
			});
		}
	});
	Ok(())
}

fn serve(app: &AppHandle, s: TcpStream) -> std::io::Result<()> {
	let mut out = s.try_clone()?;
	// 토큰을 보기 전이라 한 줄 길이를 묶는다 — 끝없이 보내 메모리를 채우지 못하게
	let mut line = String::new();
	BufReader::new(s.take(1 << 20)).read_line(&mut line)?;
	let reply = handle(app, &line);
	out.write_all(format!("{reply}\n").as_bytes())?;
	out.flush()
}

fn handle(app: &AppHandle, line: &str) -> Value {
	let Ok(req) = serde_json::from_str::<Value>(line) else { return json!({ "ok": false, "error": "요청이 JSON 한 줄이 아니다" }) };
	let ctl = app.state::<Control>();
	if req["token"].as_str() != Some(ctl.token.as_str()) {
		return json!({ "ok": false, "error": "토큰이 맞지 않는다" });
	}
	let cmd = req["cmd"].as_str().unwrap_or("");
	let on = ctl.enabled.load(Ordering::Relaxed);
	if cmd == "ping" {
		return json!({ "ok": true, "data": { "pid": std::process::id(), "version": app.package_info().version.to_string(), "enabled": on } });
	}
	if !on {
		return json!({ "ok": false, "error": "앱의 「설정 › 바깥 연결 › 바깥 제어」가 꺼져 있다" });
	}
	let started = chrono::Local::now();
	let reply = forward(app, &ctl, cmd, &req["args"]);
	// 상태 묻기는 CLI 가 저절로 부르는 것이라 기록에 넣지 않는다.
	// 새로 고침은 앱 없이 한 일(commit · restore)을 알리는 것이라 그 일 이름(why)으로 남긴다
	let label = if cmd == "refresh" { req["args"]["why"].as_str().unwrap_or("") } else { cmd };
	if cmd != "status" && !label.is_empty() {
		let mut r = ctl.recent.lock().unwrap();
		r.push(json!({
			"at": started.format("%H:%M:%S").to_string(),
			"cmd": label,
			"dir": req["args"]["dir"].as_str().or(req["args"]["path"].as_str()).unwrap_or(""),
			"ok": reply["ok"].as_bool() == Some(true),
			"error": reply["error"],
			"ms": (chrono::Local::now() - started).num_milliseconds(),
		}));
		let n = r.len();
		if n > 30 {
			r.drain(..n - 30);
		}
	}
	let _ = app.emit("remote-log", ());
	reply
}

fn forward(app: &AppHandle, ctl: &Control, cmd: &str, args: &Value) -> Value {
	let id = uuid::Uuid::new_v4().simple().to_string();
	let (tx, rx) = mpsc::channel();
	ctl.pending.lock().unwrap().insert(id.clone(), tx);
	if app.emit("remote", json!({ "id": id, "cmd": cmd, "args": args })).is_err() {
		ctl.pending.lock().unwrap().remove(&id);
		return json!({ "ok": false, "error": "화면에 명령을 넘기지 못했다" });
	}
	match rx.recv_timeout(WAIT) {
		Ok(v) => v,
		Err(_) => {
			ctl.pending.lock().unwrap().remove(&id);
			json!({ "ok": false, "error": "앱이 답하지 않았다 (시간 초과)" })
		}
	}
}

/// 화면이 「remote」 사건을 받을 준비를 마쳤다 — 이제 CLI 가 찾아오게 control.json 을 쓴다
#[tauri::command]
pub fn remote_ready(state: State<Control>) -> Res<()> {
	let d = data_dir();
	std::fs::create_dir_all(&d).map_err(err)?;
	let v = json!({
		"port": *state.port.lock().unwrap(),
		"token": state.token,
		"pid": std::process::id(),
		"exe": std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
	});
	let tmp = d.join("control.json.tmp");
	std::fs::write(&tmp, serde_json::to_string_pretty(&v).map_err(err)?).map_err(err)?;
	std::fs::rename(tmp, control_file()).map_err(err)
}

#[tauri::command]
pub fn remote_reply(state: State<Control>, id: String, reply: Value) -> Res<()> {
	if let Some(tx) = state.pending.lock().unwrap().remove(&id) {
		let _ = tx.send(reply);
	}
	Ok(())
}

/// 설정 화면 「바깥 연결」 — 통로 · 최근 명령 · 스킬 상태를 한 번에
#[tauri::command]
pub fn remote_info(state: State<Control>) -> Value {
	json!({
		"enabled": state.enabled.load(Ordering::Relaxed),
		"port": *state.port.lock().unwrap(),
		"control": control_file(),
		"recent": *state.recent.lock().unwrap(),
		"skill": crate::cli::skill_state(None),
	})
}

#[tauri::command]
pub fn remote_set_enabled(state: State<Control>, on: bool) {
	state.enabled.store(on, Ordering::Relaxed);
}

#[tauri::command]
pub fn skill_install() -> Res<Value> {
	crate::cli::install_skill(None)?;
	Ok(crate::cli::skill_state(None))
}

/// 끌 때 — 다른 창이 새로 쓴 control.json 은 남긴다 (pid 가 이 프로세스일 때만 지운다)
pub fn forget() {
	let f = control_file();
	let mine = std::fs::read_to_string(&f).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).and_then(|v| v["pid"].as_u64()) == Some(std::process::id() as u64);
	if mine {
		let _ = std::fs::remove_file(f);
	}
}
