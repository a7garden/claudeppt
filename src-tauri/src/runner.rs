// 내 PC 의 Claude 를 공유 덱에 붙인다 (2026.11.26) — 팀원이 「내 PC 의 Claude」로 보낸 턴을 이 PC 에서 돌린다.
//
// 덱 주인 앱이 턴을 지휘하고(줄 세우기 · 대화 · 판), 여기는 claude 프로세스만 돌린다 (덱 주인 쪽: collab.rs 「팀원 PC 의 Claude」).
//
//   붙기      공유 덱 창(collab_join)이 받은 기기 쿠키로 덱 주인의 /_/runner 에 붙는다. 쿠키는 웹뷰에서 읽고 메모리에만 둔다
//   사본      앱 데이터 shared/<호스트>/<덱 id>/ 에 덱 파일을 받아 둔다. 처음 · 턴 시작마다 목록(manifest)을 맞추고, 그 사이에는 바뀐 경로만 받는다
//   실행      지시(run)를 받으면 사본에서 claude 를 돌린다 — 격리 인자는 덱 주인 PC 와 같다(claude.rs execute). 작업 폴더 밖은 읽지도 쓰지도 못한다.
//             claude 경로 · 모델 · 생각 깊이는 이 PC 의 설정을 쓴다 (사용량도 이 PC 의 계정)
//   돌려주기  출력 줄은 그대로(사본 경로만 표시로 바꿔 — 이 PC 의 경로가 건너가지 않게), Claude 가 사본에 쓴 파일은 다 쓰는 대로(put) 보낸다.
//             끝나면 대화 기록에서 늘어난 뒷부분만 보낸다
//
// 이 PC 의 Claude 를 쓰게 할지는 사람이 처음 화면 「공유 덱」에서 덱 주인마다 켠다. 덱 주인이 내준 화면(공유 덱 창)은 이것을 켜지 못한다 —
// 그 창에는 명령 권한이 없다(capabilities). 켠 동안 덱 주인 앱은 이 PC 의 사용량으로 턴을 돌릴 수 있다 — 그래서 덱 주인마다 사람이 켠다

use crate::{Res, err};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

const COOKIE: &str = "cppt_d";

#[derive(Default)]
pub struct Runners {
	list: Mutex<HashMap<String, Handle>>,
}

struct Handle {
	stop: tokio::sync::watch::Sender<bool>,
	status: Arc<Mutex<Status>>,
}

#[derive(Serialize, Clone)]
pub struct Status {
	origin: String,
	/// waiting — 공유 덱 창에서 들어가기를 기다린다 · connected — 붙었다 · running — 턴을 돌린다 · error — 다시 붙는 중
	state: &'static str,
	detail: String,
}

fn set(app: &AppHandle, st: &Arc<Mutex<Status>>, state: &'static str, detail: impl Into<String>) {
	let s = {
		let mut g = st.lock().unwrap();
		g.state = state;
		g.detail = detail.into();
		g.clone()
	};
	let _ = app.emit("runner-status", s);
}

/// 켠다 — 이미 켜져 있으면 그대로
#[tauri::command]
pub fn runner_start(app: AppHandle, origin: String) -> Res<()> {
	let origin = tauri::Url::parse(origin.trim()).map_err(|_| "주소가 올바르지 않다".to_string())?.origin().ascii_serialization();
	let r = app.state::<Runners>();
	if r.list.lock().unwrap().contains_key(&origin) {
		return Ok(());
	}
	let (stop, rx) = tokio::sync::watch::channel(false);
	let status = Arc::new(Mutex::new(Status { origin: origin.clone(), state: "waiting", detail: String::new() }));
	r.list.lock().unwrap().insert(origin.clone(), Handle { stop, status: status.clone() });
	let app2 = app.clone();
	tauri::async_runtime::spawn(async move { keep(app2, origin, status, rx).await });
	Ok(())
}

#[tauri::command]
pub fn runner_stop(app: AppHandle, origin: String) {
	let origin = tauri::Url::parse(origin.trim()).map(|u| u.origin().ascii_serialization()).unwrap_or(origin);
	if let Some(h) = app.state::<Runners>().list.lock().unwrap().remove(&origin) {
		let _ = h.stop.send(true);
		let _ = app.emit("runner-status", Status { origin, state: "off", detail: String::new() });
	}
}

#[tauri::command]
pub fn runner_list(app: AppHandle) -> Vec<Status> {
	app.state::<Runners>().list.lock().unwrap().values().map(|h| h.status.lock().unwrap().clone()).collect()
}

/// 공유 덱 창이 받은 기기 쿠키 — 그 창이 열려 있어야 읽는다
fn cookie(app: &AppHandle, origin: &str) -> Option<String> {
	let w = app.get_webview_window(&crate::collab::join_label(origin))?;
	let url = tauri::Url::parse(&format!("{origin}/")).ok()?;
	w.cookies_for_url(url).ok()?.into_iter().find(|c| c.name() == COOKIE).map(|c| c.value().to_string())
}

/// 끌 때까지 붙어 있는다 — 끊기면 다시 붙는다
async fn keep(app: AppHandle, origin: String, status: Arc<Mutex<Status>>, mut stop: tokio::sync::watch::Receiver<bool>) {
	let mut secret: Option<String> = None;
	let mut wait = 1u64;
	while !*stop.borrow() {
		if let Some(c) = cookie(&app, &origin) {
			secret = Some(c);
		}
		let Some(sec) = secret.clone() else {
			set(&app, &status, "waiting", "");
			tokio::select! { _ = tokio::time::sleep(Duration::from_secs(2)) => {}, _ = stop.changed() => {} }
			continue;
		};
		match session(&app, &origin, &sec, &status, &mut stop).await {
			Ok(()) => wait = 1,
			Err(e) => {
				set(&app, &status, "error", e);
				// 쿠키가 바뀌었을 수 있다(다시 들어옴) — 다음에는 창에서 다시 읽는다
				secret = None;
			}
		}
		tokio::select! { _ = tokio::time::sleep(Duration::from_secs(wait)) => {}, _ = stop.changed() => {} }
		wait = (wait * 2).min(15);
	}
}

/// 덱 주인에게 HTTP 로 묻는다 — 기기 쿠키와 Origin 을 붙인다 (collab.rs auth · same_origin)
#[derive(Clone)]
struct Host {
	origin: String,
	secret: String,
	http: reqwest::Client,
}

impl Host {
	async fn get(&self, path: &str) -> Res<reqwest::Response> {
		let r = self.http.get(format!("{}{path}", self.origin)).header("cookie", format!("{COOKIE}={}", self.secret)).header("origin", &self.origin).send().await.map_err(err)?;
		Ok(r)
	}
}

/// 사본 — 덱 id · 폴더 · 파일마다 마지막으로 맞춘 내용 지문
struct Mirror {
	root: PathBuf,
	id: String,
	dir: PathBuf,
	known: HashMap<String, String>,
}

fn fnv(b: &[u8]) -> String {
	let mut x: u64 = 0xcbf29ce484222325;
	for v in b {
		x ^= *v as u64;
		x = x.wrapping_mul(0x100000001b3);
	}
	format!("{x:016x}")
}

/// 사본에 쓸 수 있는 경로인가 — 덱 주인이 준 경로라도 사본 밖으로 나가지 못하게
fn safe(rel: &str) -> bool {
	!rel.is_empty() && !rel.starts_with('/') && !rel.contains("..") && !rel.contains(':') && !rel.starts_with(".git")
}

impl Mirror {
	/// 목록을 받아 다른 파일만 받고, 덱 주인에게 없는 파일은 지운다
	async fn sync(&mut self, host: &Host) -> Res<()> {
		let m: Value = host.get("/_/runner/manifest").await?.error_for_status().map_err(err)?.json().await.map_err(err)?;
		let id = m["id"].as_str().unwrap_or("deck").chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect::<String>();
		if id != self.id {
			self.id = id.clone();
			self.dir = self.root.join(&id);
			self.known.clear();
			std::fs::create_dir_all(&self.dir).map_err(err)?;
		}
		let files = m["files"].as_object().cloned().unwrap_or_default();
		for (rel, hash) in &files {
			let hash = hash.as_str().unwrap_or("");
			if !safe(rel) || self.known.get(rel).map(String::as_str) == Some(hash) {
				continue;
			}
			let p = self.dir.join(rel);
			if std::fs::read(&p).ok().is_some_and(|b| fnv(&b) == hash) {
				self.known.insert(rel.clone(), hash.to_string());
				continue;
			}
			self.fetch(host, rel).await?;
		}
		// 덱 주인에게 없어진 파일 — 사본에서도 뺀다 (.claudeppt/run 은 이 PC 의 claude 가 쓰는 자리라 둔다)
		for rel in walk(&self.dir) {
			if !files.contains_key(&rel) && !rel.starts_with(".claudeppt/run") && !rel.starts_with(".claudeppt/sessions") {
				let _ = std::fs::remove_file(self.dir.join(&rel));
				self.known.remove(&rel);
			}
		}
		Ok(())
	}

	/// 덱 주인이 알린 바뀐 파일 하나 — 지문이 이 사본과 같으면 받지 않는다(방금 이 PC 가 보낸 파일). None 이면 없어졌다
	async fn changed(&mut self, host: &Host, rel: &str, hash: Option<&str>) -> Res<()> {
		if !safe(rel) {
			return Ok(());
		}
		let p = self.dir.join(rel);
		let have = std::fs::read(&p).ok().map(|b| fnv(&b));
		// 아직 보내지 않은 Claude 의 쓰기가 있으면 두다 — 곧 put 으로 나간다
		let unsent = have.is_some() && self.known.get(rel) != have.as_ref();
		match hash {
			Some(h) if have.as_deref() == Some(h) => {
				self.known.insert(rel.to_string(), h.to_string());
				Ok(())
			}
			_ if unsent => Ok(()),
			None => {
				self.known.remove(rel);
				let _ = std::fs::remove_file(p);
				Ok(())
			}
			Some(_) => self.fetch(host, rel).await,
		}
	}

	/// 한 파일을 받는다 — 덱 주인에게 없으면 지운다. 지문을 먼저 적고 쓴다(감시가 「Claude 가 썼다」로 보지 않게)
	async fn fetch(&mut self, host: &Host, rel: &str) -> Res<()> {
		if !safe(rel) {
			return Ok(());
		}
		let q: String = percent_encoding::utf8_percent_encode(rel, percent_encoding::NON_ALPHANUMERIC).to_string();
		let r = host.get(&format!("/_/runner/file?path={q}")).await?;
		let p = self.dir.join(rel);
		if r.status() == reqwest::StatusCode::NOT_FOUND {
			self.known.remove(rel);
			let _ = std::fs::remove_file(p);
			return Ok(());
		}
		let b = r.error_for_status().map_err(err)?.bytes().await.map_err(err)?;
		let new = fnv(&b);
		if let Ok(local) = std::fs::read(&p) {
			let have = fnv(&local);
			// 아직 보내지 않은 Claude 의 쓰기가 있다 — 덮으면 그 쓰기를 잃는다. 곧 put 으로 나간다
			if self.known.get(rel).is_some_and(|k| *k != have) && have != new {
				return Ok(());
			}
			// 내용이 같으면 쓰지 않는다 — 다시 쓰면 고친 시각이 바뀌어 Claude 가 「읽은 뒤 바뀌었다」며 다시 읽는다
			if have == new {
				self.known.insert(rel.to_string(), new);
				return Ok(());
			}
		}
		self.known.insert(rel.to_string(), new);
		if let Some(d) = p.parent() {
			std::fs::create_dir_all(d).map_err(err)?;
		}
		std::fs::write(p, &b).map_err(err)
	}

	/// Claude 가 쓴 파일 — 지문이 달라진 덱 파일 (앱 상태 · 실행 자리는 빼고).
	/// settle 이면 방금(0.15초 안) 고친 파일은 다음 훑기로 미룬다 — 쓰는 도중의 반쪽 파일을 보내 모두의 화면이 깨졌다 돌아오지 않게
	fn written(&mut self, settle: bool) -> Vec<(String, Vec<u8>)> {
		let mut out = vec![];
		for rel in walk(&self.dir) {
			if rel.starts_with(".claudeppt") || rel.starts_with(".git") {
				continue;
			}
			let p = self.dir.join(&rel);
			if settle && std::fs::metadata(&p).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|e| e < Duration::from_millis(150)) {
				continue;
			}
			let Ok(b) = std::fs::read(&p) else { continue };
			let h = fnv(&b);
			if self.known.get(&rel) != Some(&h) {
				self.known.insert(rel.clone(), h);
				out.push((rel, b));
			}
		}
		out
	}
}

fn walk(root: &Path) -> Vec<String> {
	let mut out = vec![];
	let mut stack = vec![root.to_path_buf()];
	while let Some(d) = stack.pop() {
		for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
			let p = e.path();
			if p.is_dir() {
				stack.push(p);
			} else if let Ok(r) = p.strip_prefix(root) {
				out.push(r.to_string_lossy().replace('\\', "/"));
			}
		}
	}
	out
}

/// 붙어 있는 한 번 — 끊기면 Err 로 돌아가 다시 붙는다
async fn session(app: &AppHandle, origin: &str, secret: &str, status: &Arc<Mutex<Status>>, stop: &mut tokio::sync::watch::Receiver<bool>) -> Res<()> {
	let host = Host { origin: origin.to_string(), secret: secret.to_string(), http: reqwest::Client::builder().timeout(Duration::from_secs(60)).build().map_err(err)? };
	let ws_url = format!("{}/_/runner", origin.replacen("http", "ws", 1));
	let mut req = ws_url.into_client_request().map_err(err)?;
	req.headers_mut().insert("cookie", HeaderValue::from_str(&format!("{COOKIE}={secret}")).map_err(err)?);
	req.headers_mut().insert("origin", HeaderValue::from_str(origin).map_err(err)?);
	let (ws, _) = tokio_tungstenite::connect_async(req).await.map_err(|e| format!("덱 주인에게 붙지 못했다: {e}"))?;
	let (mut sink, mut stream) = ws.split();

	let key = crate::collab::join_label(origin);
	let mirror = Arc::new(tokio::sync::Mutex::new(Mirror { root: crate::control::data_dir().join("shared").join(&key), id: String::new(), dir: PathBuf::new(), known: HashMap::new() }));
	// 미리 받아 둔다 — 덱 주인이 아직 덱을 열지 않았으면 못 받아도 붙어 있는다(턴을 받을 때 다시 맞춘다)
	let _ = mirror.lock().await.sync(&host).await;
	let (out, mut outbox) = mpsc::unbounded_channel::<String>();
	set(app, status, "connected", "");

	// 도는 턴 — 턴 id → claude pid. 멈춤 · 끊김 때 끈다
	let pids: Arc<Mutex<HashMap<String, u32>>> = Arc::default();
	// claude 가 뜨기 전(사본을 맞추는 동안)에 멈춘 턴 — 뜨자마자 끈다
	let cancel: Arc<Mutex<std::collections::HashSet<String>>> = Arc::default();
	// Claude 가 쓴 파일을 바로 보낸다 — 도는 턴이 있을 때만 0.2초마다 사본을 훑는다 (덱은 작아 훑는 값이 싸다)
	let push = {
		let (mirror, out, pids) = (mirror.clone(), out.clone(), pids.clone());
		tauri::async_runtime::spawn(async move {
			loop {
				tokio::time::sleep(Duration::from_millis(200)).await;
				let turn = pids.lock().unwrap().keys().next().cloned();
				let Some(turn) = turn else { continue };
				for (rel, b) in mirror.lock().await.written(true) {
					let _ = out.send(json!({ "t": "put", "turn": turn, "path": rel, "data": base64::engine::general_purpose::STANDARD.encode(b) }).to_string());
				}
			}
		})
	};

	let result: Res<()> = loop {
		tokio::select! {
			_ = stop.changed() => break Ok(()),
			m = outbox.recv() => {
				let Some(m) = m else { break Ok(()) };
				if sink.send(Message::Text(m.into())).await.is_err() { break Err("덱 주인과 연결이 끊겼다".into()); }
			}
			m = stream.next() => {
				let text = match m {
					Some(Ok(Message::Text(t))) => t.to_string(),
					Some(Ok(Message::Close(_))) | None => break Err("덱 주인이 연결을 닫았다".into()),
					Some(Err(e)) => break Err(format!("덱 주인과 연결이 끊겼다: {e}")),
					_ => continue,
				};
				let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
				match v["t"].as_str().unwrap_or("") {
					"changed" => {
						// 받는 동안 이 줄을 막지 않는다 — 도는 턴의 출력 줄이 밀리지 않게
						let (mirror, host) = (mirror.clone(), host.clone());
						tauri::async_runtime::spawn(async move {
							let mut mi = mirror.lock().await;
							for (p, h) in v["files"].as_object().into_iter().flatten() {
								let _ = mi.changed(&host, p, h.as_str()).await;
							}
						});
					}
					"run" => {
						let (app, host, mirror, out, pids, cancel, status) = (app.clone(), host.clone(), mirror.clone(), out.clone(), pids.clone(), cancel.clone(), status.clone());
						tauri::async_runtime::spawn(async move { run(app, host, mirror, out, pids, cancel, status, v).await });
					}
					"stop" => {
						let turn = v["turn"].as_str().unwrap_or("").to_string();
						match pids.lock().unwrap().get(&turn).copied() {
							Some(pid) => crate::claude::kill_tree(pid),
							None => { cancel.lock().unwrap().insert(turn); }
						}
					}
					_ => {}
				}
			}
		}
	};
	push.abort();
	// 붙어 있던 동안 돌던 claude 는 끈다 — 덱 주인은 그 턴을 끝난 것으로 본다(collab.rs)
	for pid in pids.lock().unwrap().values() {
		crate::claude::kill_tree(*pid);
	}
	if *stop.borrow() {
		let _ = sink.send(Message::Close(None)).await;
	}
	result
}

/// 턴 하나 — 사본을 맞추고, 이어 쓸 기록을 놓고, 이 PC 의 claude 로 돌린다
#[allow(clippy::too_many_arguments)]
async fn run(app: AppHandle, host: Host, mirror: Arc<tokio::sync::Mutex<Mirror>>, out: mpsc::UnboundedSender<String>, pids: Arc<Mutex<HashMap<String, u32>>>, cancel: Arc<Mutex<std::collections::HashSet<String>>>, status: Arc<Mutex<Status>>, v: Value) {
	let turn = v["turn"].as_str().unwrap_or("").to_string();
	// base — 덱 주인이 가진 기록 길이. 그 뒤에 늘어난 것(tail)만 보낸다
	let exit = |turn: &str, code: i64, stderr: String, sid: Option<String>, base: usize, tail: Option<String>| json!({ "t": "exit", "turn": turn, "code": code, "stderr": stderr, "sid": sid, "base": base, "tail": tail }).to_string();
	let dir = {
		let mut m = mirror.lock().await;
		if let Err(e) = m.sync(&host).await {
			let _ = out.send(exit(&turn, -1, format!("덱을 받지 못했다: {e}"), None, 0, None));
			return;
		}
		m.dir.clone()
	};
	if cancel.lock().unwrap().remove(&turn) {
		let _ = out.send(exit(&turn, -1, String::new(), None, 0, None));
		return;
	}
	let resume = v["resume"].as_str().filter(|s| crate::claude::valid_sid(s)).map(String::from);
	// 이어 쓸 기록 — 받았으면 놓는다. 안 왔으면 이 PC 가 마지막으로 이어 쓴 그대로라는 뜻이다(collab.rs transcript_at)
	let mut base = 0usize;
	if let Some(sid) = &resume {
		if let Some(t) = v["transcript"].as_str() {
			crate::claude::place_transcript(&dir, sid, t);
		}
		base = v["transcriptLen"].as_u64().unwrap_or(0) as usize;
	}
	let s = crate::project::settings_load(app.clone()).unwrap_or(Value::Null);
	let c = &s["claude"];
	let Some(exe) = crate::claude::resolve(c["path"].as_str().unwrap_or("")) else {
		let _ = out.send(exit(&turn, -1, "이 PC 에서 claude 실행 파일을 찾지 못했다. 설정 › Claude 에서 경로를 준다".into(), None, 0, None));
		return;
	};
	set(&app, &status, "running", "");
	let job = crate::claude::Job {
		exe,
		dir: &dir,
		prompt: v["prompt"].as_str().unwrap_or(""),
		system: v["system"].as_str().unwrap_or(""),
		model: c["model"].as_str().unwrap_or(""),
		effort: c["effort"].as_str().unwrap_or(""),
		resume: resume.as_deref(),
		session_id: v["sessionId"].as_str(),
		fonts: false,
	};
	let (out2, turn2, turn3, pids2, cancel2) = (out.clone(), turn.clone(), turn.clone(), pids.clone(), cancel.clone());
	// 줄을 보내기 전에 쓴 파일부터 — 「고쳤다」는 줄이 화면에 닿을 때 덱에도 그 파일이 있게
	let mirror2 = mirror.clone();
	// 출력 줄 안의 사본 경로 → 표시 (collab.rs rewrite 가 덱 경로로 채운다). JSON 글 안이라 역슬래시가 둘이다
	let here = dir.to_string_lossy().to_string();
	let (esc, fwd) = (here.replace('\\', "\\\\"), here.replace('\\', "/"));
	let ended = crate::claude::execute(
		job,
		move |line| {
			if line.contains("\"tool_result\"") {
				if let Ok(mut m) = mirror2.try_lock() {
					for (rel, b) in m.written(false) {
						let _ = out2.send(json!({ "t": "put", "turn": turn2, "path": rel, "data": base64::engine::general_purpose::STANDARD.encode(b) }).to_string());
					}
				}
			}
			let line = line.replace(&esc, crate::collab::DECK_MARK).replace(&fwd, crate::collab::DECK_MARK_FWD);
			let _ = out2.send(json!({ "t": "line", "turn": turn2, "line": line }).to_string());
		},
		move |pid| {
			// 뜨기 전에 멈췄으면 바로 끈다
			if cancel2.lock().unwrap().remove(&turn3) {
				crate::claude::kill_tree(pid);
			}
			pids2.lock().unwrap().insert(turn3, pid);
		},
	)
	.await;
	// 끝에 남은 쓰기를 모두 보내고 끝을 알린다
	for (rel, b) in mirror.lock().await.written(false) {
		let _ = out.send(json!({ "t": "put", "turn": turn, "path": rel, "data": base64::engine::general_purpose::STANDARD.encode(b) }).to_string());
	}
	pids.lock().unwrap().remove(&turn);
	if pids.lock().unwrap().is_empty() {
		set(&app, &status, "connected", "");
	}
	match ended {
		Ok(e) => {
			// 늘어난 뒷부분만 — 앞부분이 덱 주인이 가진 것과 같은 길이로 이어질 때. 아니면(새 세션 · 기록을 못 이음) 통째로
			let text = e.sid.as_deref().and_then(|sid| crate::claude::transcript_text(&dir, sid));
			let (base, tail) = match text {
				Some(t) if base > 0 && t.len() >= base && t.is_char_boundary(base) => (base, Some(t[base..].to_string())),
				Some(t) => (0, Some(t)),
				None => (0, None),
			};
			let _ = out.send(exit(&turn, e.code as i64, e.stderr, e.sid, base, tail));
		}
		Err(e) => {
			let _ = out.send(exit(&turn, -1, e, None, 0, None));
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn only_claude_writes_go_back() {
		let d = std::env::temp_dir().join(format!("cppt-runner-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&d);
		std::fs::create_dir_all(d.join("slides")).unwrap();
		std::fs::create_dir_all(d.join(".claudeppt/run")).unwrap();
		std::fs::write(d.join("slides/s1.html"), "a").unwrap();
		let mut m = Mirror { root: d.clone(), id: "x".into(), dir: d.clone(), known: HashMap::from([("slides/s1.html".to_string(), fnv(b"a"))]) };
		assert!(m.written(false).is_empty(), "받은 그대로면 보내지 않는다");
		std::fs::write(d.join("slides/s1.html"), "b").unwrap();
		std::fs::write(d.join("slides/s2.html"), "new").unwrap();
		std::fs::write(d.join(".claudeppt/run/system.md"), "x").unwrap();
		assert!(m.written(true).is_empty(), "방금 쓴 파일은 다음 훑기로 미룬다");
		let mut w: Vec<String> = m.written(false).into_iter().map(|(r, _)| r).collect();
		w.sort();
		assert_eq!(w, ["slides/s1.html", "slides/s2.html"], "앱 상태 · 실행 자리는 보내지 않는다");
		assert!(m.written(false).is_empty(), "한 번 보낸 것은 다시 보내지 않는다");
		let _ = std::fs::remove_dir_all(&d);
	}

	#[test]
	fn mirror_paths_stay_inside() {
		for ok in ["slides/s1.html", "theme.css", ".claudeppt/attach/a.png"] {
			assert!(safe(ok), "{ok}");
		}
		for no in ["", "/etc/x", "../x", "a/../../x", "C:/x", ".git/config"] {
			assert!(!safe(no), "{no}");
		}
	}
}
