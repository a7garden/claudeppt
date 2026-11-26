// 팀 협업 서버 — 「설정 › 협업」을 켜면 이 앱(호스트) 안에서 HTTP + WebSocket 을 연다. 끄면 닫는다. 기본은 꺼짐.
//
//   화면       같은 React 화면을 브라우저에 내준다 (설치 판: 앱에 담긴 화면 · 개발 실행: Vite 로 넘긴다)
//   슬라이드    /_/d/<덱 열쇠>/<id>[@커밋]/<경로> — deck:// 와 같은 serve() 를 쓴다 (경로 검사 · 런타임 끼우기 그대로).
//              브라우저는 슬라이드를 sandbox iframe(다른 출처)으로 연다 — 슬라이드 안 스크립트가 앱 화면에 손대거나 팀원 이름으로
//              의도를 보내지 못하게. 그래서 슬라이드는 쿠키가 아니라 주소 안 덱 열쇠로 연다(읽기 전용, 화면 열쇠와 다르다).
//              슬라이드 HTML 에는 CSP connect-src 'none' — 슬라이드 스크립트는 서버에 아무 요청도 못 한다
//   캐시 · 압축  지금 파일은 ETag + no-cache(바뀌지 않았으면 304), 판 고정 주소(@커밋)와 해시 붙은 화면 파일은 immutable. gzip
//   상태       호스트 화면이 덱 · 대화 · 세션 · 판을 collab_publish 로 올리면 접속한 모든 브라우저에 /_/ws 로 보낸다.
//              새로 붙거나(다시 붙기 포함) 따라가지 못한 브라우저에는 지금 것을 통째로 다시 보낸다
//   의도       브라우저가 하려는 일(요청 보내기 · 직접 편집 · 의견)은 호스트 화면에 「collab-intent」 사건으로 넘기고 답을 기다린다.
//              쓰기는 호스트 한 곳에서만 — 두 화면이 같은 파일 · 대화 기록을 따로 쓰면 하나가 다른 것을 덮는다
//   접속       누가 붙었고 어느 쪽을 보는지(members). 모든 브라우저와 호스트 화면에 알린다
//   초대       /j/<링크 열쇠> — 공용 링크는 이름을 한 번 적고, 개인 링크는 정한 이름으로 바로 들어온다. 들어오면 기기 쿠키(HttpOnly)를 받고
//              그 뒤로는 쿠키로 들어온다. 링크 · 기기 · 잠금은 invite.rs (앱 데이터 collab.json). 내보낸 기기는 그 자리에서 끊긴다.
//              그 밖의 모든 요청에 기기 쿠키가 있어야 한다. IP 로 믿지 않는다 — 바깥 길(터널)로 온 요청은 127.0.0.1 로 보인다.
//              팀원의 이름은 서버가 정한다(기기 이름) — 요청 · 편집 · 판의 보낸 사람이 브라우저가 적어 보낸 이름이 아니다.
//              /_/ws · /_/rpc 는 같은 출처(Origin)에서 온 것만 — 다른 출처 페이지가 팀원 브라우저의 쿠키로 붙지 못하게
//   읽기       /_/rpc 는 허용 목록뿐 — 열려 있는 덱 안 파일 읽기 · 판 목록. 쓰기 · 절대 경로 · 설정 · claude 실행은 없다

use crate::invite::{self, Book, Why};
use crate::{AppState, Res, err};
use axum::Router;
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State as Ax};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{broadcast, mpsc, oneshot};

const COOKIE: &str = "cppt_d";
/// 처음 해 보는 포트 — 쓰이고 있으면 아무 빈 포트
const DEFAULT_PORT: u16 = 47815;
/// 의도 하나를 기다리는 가장 긴 시간 — Claude 턴이 오래 돈다
const INTENT_WAIT: Duration = Duration::from_secs(3 * 60 * 60);
/// 살아 있는지 묻는 간격 (2026.11.26). 덮은 노트북 · 끊긴 와이파이는 TCP 가 끊긴 줄 모른 채 몇 분을 간다 —
/// 그동안 서버는 그 사람을 「접속」으로, 브라우저는 「연결됨」으로 보인다. 세 번 답이 없으면 끊는다
const BEAT: Duration = Duration::from_secs(20);
/// 브라우저가 받는 「살아 있다」 — 브라우저는 이것도 못 받으면 스스로 끊고 다시 붙는다 (collab.ts)
const PING: &str = r#"{"t":"ping"}"#;
/// 브라우저가 부를 수 있는 의도. 호스트 화면(collab.ts)도 같은 목록만 받는다 — 둘 다 지켜야 넘어간다
const INTENTS: &[&str] = &["send", "stop", "newTalk", "direct", "undo", "redo", "pinAdd", "pinUpdate", "pinRemove", "pinResolve", "pinSend", "upload"];

#[derive(Default)]
pub struct Collab {
	hub: Mutex<Option<Arc<Hub>>>,
	stop: Mutex<Option<oneshot::Sender<()>>>,
}

pub struct Hub {
	app: AppHandle,
	book: Mutex<Book>,
	book_path: PathBuf,
	/// 바깥 길(터널) — 열려 있으면 그 주소가 링크의 첫 주소가 된다
	tunnel: tokio::sync::Mutex<Option<crate::tunnel::Tunnel>>,
	public: Mutex<Option<(String, &'static str)>>,
	/// 연결 → (기기 id, 그 연결에 보내는 길) — 내보낼 때 끊는다
	conns: Mutex<HashMap<u64, (String, mpsc::UnboundedSender<String>)>>,
	/// 슬라이드 주소 안의 열쇠 — 열린 덱 파일 읽기만 된다
	deck_key: String,
	port: u16,
	tx: broadcast::Sender<Arc<str>>,
	shared: Mutex<Shared>,
	members: Mutex<BTreeMap<u64, Member>>,
	pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
	next: AtomicU64,
	/// 팀원 PC 의 Claude — 기기 id → 연결 (아래 「팀원 PC 의 Claude」)
	runners: Mutex<HashMap<String, Runner>>,
	/// 팀원 PC 에서 도는 턴 — 턴 id → 그 턴
	remote_runs: Mutex<HashMap<String, RemoteRun>>,
	/// 세션 기록을 마지막으로 이어 쓴 기기와 그때 기록 길이 — 같은 기기가 그 뒤 아무도 안 쓴 세션을 이으면 기록을 다시 보내지 않는다
	transcript_at: Mutex<HashMap<String, (String, usize)>>,
}

/// 호스트가 올린 상태. turns 는 따로 — 글자가 흐르는 동안 바뀐 턴만 오간다
#[derive(Default)]
struct Shared {
	seq: u64,
	set: Map<String, Value>,
	order: Vec<String>,
	turns: HashMap<String, Value>,
}

#[derive(Clone, Serialize)]
pub struct Member {
	conn: u64,
	/// 기기 id (호스트는 "")
	device: String,
	name: String,
	slide: Option<String>,
	host: bool,
	since: i64,
	/// 이 기기가 「내 PC 의 Claude」를 붙여 두었나 — 요청칸이 고르기를 보인다
	runner: bool,
}

#[derive(Serialize, Clone)]
pub struct Info {
	port: u16,
	/// 이 서버에 닿는 주소들 — 바깥 길(있으면 맨 앞) · 사무실 망 · 이 PC
	bases: Vec<String>,
	/// 바깥 길 — { url, kind: "tailscale" | "cloudflare" }
	tunnel: Option<TunnelView>,
	links: Vec<LinkView>,
	devices: Vec<DeviceView>,
	locked: bool,
	members: Vec<Member>,
}

#[derive(Serialize, Clone)]
struct TunnelView {
	url: String,
	kind: &'static str,
}

#[derive(Serialize, Clone)]
struct LinkView {
	id: String,
	url: String,
	name: Option<String>,
	expires: Option<i64>,
	expired: bool,
}

#[derive(Serialize, Clone)]
struct DeviceView {
	id: String,
	name: String,
	seen: i64,
	online: bool,
}

/// 요청을 보낸 기기 — auth 가 쿠키로 찾아 요청에 붙인다
#[derive(Clone)]
struct Who {
	device: String,
	name: String,
}

fn now() -> i64 {
	chrono::Utc::now().timestamp_millis()
}

use invite::same;

fn book_file() -> PathBuf {
	crate::control::data_dir().join("collab.json")
}

/// 이 PC 의 사무실 망 주소 — 밖으로 나가는 기본 길의 주소. UDP 는 connect 만으로는 아무것도 보내지 않는다
fn lan_ip() -> Option<String> {
	let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
	s.connect("8.8.8.8:80").ok()?;
	let ip = s.local_addr().ok()?.ip();
	(!ip.is_loopback() && !ip.is_unspecified()).then(|| ip.to_string())
}

impl Hub {
	fn info(&self) -> Info {
		let mut bases = vec![];
		let public = self.public.lock().unwrap().clone();
		if let Some((u, _)) = &public {
			bases.push(u.clone());
		}
		if let Some(ip) = lan_ip() {
			bases.push(format!("http://{ip}:{}", self.port));
		}
		bases.push(format!("http://localhost:{}", self.port));
		let members: Vec<Member> = self.members.lock().unwrap().values().cloned().collect();
		let b = self.book.lock().unwrap();
		let t = now();
		Info {
			port: self.port,
			links: b.links.iter().map(|l| LinkView { id: l.id.clone(), url: format!("{}/j/{}", bases[0], l.token), name: l.name.clone(), expires: l.expires, expired: l.expires.is_some_and(|e| e <= t) }).collect(),
			devices: b.devices.iter().rev().map(|d| DeviceView { id: d.id.clone(), name: d.name.clone(), seen: d.seen, online: members.iter().any(|m| m.device == d.id) }).collect(),
			locked: b.locked,
			tunnel: public.map(|(url, kind)| TunnelView { url, kind }),
			bases,
			members,
		}
	}

	fn save(&self) {
		self.book.lock().unwrap().save(&self.book_path);
	}

	/// 장부가 바뀌었다 — 파일에 남기고 호스트 화면에 알린다
	fn book_changed(&self) {
		self.save();
		let _ = self.app.emit("collab-info", self.info());
	}

	/// 새로 붙은 브라우저에 줄 지금 상태 통째
	fn snapshot(&self) -> String {
		let s = self.shared.lock().unwrap();
		let put: Vec<&Value> = s.order.iter().filter_map(|id| s.turns.get(id)).collect();
		json!({ "t": "state", "seq": s.seq, "full": true, "patch": { "set": s.set, "turns": { "order": s.order, "put": put } } }).to_string()
	}

	/// 호스트가 올린 바뀐 것을 쌓고 모두에게 보낸다
	fn publish(&self, patch: Value) {
		let msg = {
			let mut s = self.shared.lock().unwrap();
			if patch.get("reset").and_then(Value::as_bool) == Some(true) {
				*s = Shared { seq: s.seq, ..Default::default() };
			}
			if let Some(set) = patch.get("set").and_then(Value::as_object) {
				for (k, v) in set {
					s.set.insert(k.clone(), v.clone());
				}
			}
			if let Some(t) = patch.get("turns") {
				if let Some(order) = t.get("order").and_then(Value::as_array) {
					s.order = order.iter().filter_map(|x| x.as_str().map(String::from)).collect();
					let keep: std::collections::HashSet<String> = s.order.iter().cloned().collect();
					s.turns.retain(|k, _| keep.contains(k));
				}
				for turn in t.get("put").and_then(Value::as_array).into_iter().flatten() {
					if let Some(id) = turn.get("id").and_then(Value::as_str) {
						s.turns.insert(id.to_string(), turn.clone());
					}
				}
			}
			s.seq += 1;
			json!({ "t": "state", "seq": s.seq, "patch": patch }).to_string()
		};
		let _ = self.tx.send(msg.into());
	}

	/// 호스트 이름 — 공용 링크로 들어오는 이름이 이것과 겹치지 않게
	fn host_name(&self) -> Vec<String> {
		self.members.lock().unwrap().get(&0).map(|m| m.name.clone()).into_iter().collect()
	}

	fn members_changed(&self) {
		let list: Vec<Member> = self.members.lock().unwrap().values().cloned().collect();
		let _ = self.tx.send(json!({ "t": "members", "list": list }).to_string().into());
		let _ = self.app.emit("collab-members", &list);
	}
}

fn hub(app: &AppHandle) -> Option<Arc<Hub>> {
	app.state::<Collab>().hub.lock().unwrap().clone()
}

// ── 명령 (호스트 화면) ──

/// 켠다. 이미 켜져 있으면 지금 것을 돌려준다
#[tauri::command]
pub async fn collab_start(app: AppHandle) -> Res<Info> {
	if let Some(h) = hub(&app) {
		return Ok(h.info());
	}
	let listener = match tokio::net::TcpListener::bind(("0.0.0.0", DEFAULT_PORT)).await {
		Ok(l) => l,
		Err(_) => tokio::net::TcpListener::bind(("0.0.0.0", 0)).await.map_err(err)?,
	};
	let port = listener.local_addr().map_err(err)?.port();
	let (tx, _) = broadcast::channel(512);
	let h = Arc::new(Hub {
		app: app.clone(),
		book: Mutex::new({
			let mut b = Book::load(&book_file());
			b.ensure_public(now());
			b
		}),
		book_path: book_file(),
		tunnel: tokio::sync::Mutex::new(None),
		public: Mutex::new(None),
		conns: Mutex::new(HashMap::new()),
		deck_key: uuid::Uuid::new_v4().simple().to_string(),
		port,
		tx,
		shared: Mutex::new(Shared::default()),
		members: Mutex::new(BTreeMap::new()),
		pending: Mutex::new(HashMap::new()),
		next: AtomicU64::new(1),
		runners: Mutex::new(HashMap::new()),
		remote_runs: Mutex::new(HashMap::new()),
		transcript_at: Mutex::new(HashMap::new()),
	});
	let (stop_tx, stop_rx) = oneshot::channel::<()>();
	let router = routes(h.clone());
	tauri::async_runtime::spawn(async move {
		let _ = axum::serve(listener, router).with_graceful_shutdown(async { let _ = stop_rx.await; }).await;
	});
	let c = app.state::<Collab>();
	*c.hub.lock().unwrap() = Some(h.clone());
	*c.stop.lock().unwrap() = Some(stop_tx);
	h.save();
	Ok(h.info())
}

fn with_hub(app: &AppHandle, f: impl FnOnce(&Hub)) -> Res<Info> {
	let h = hub(app).ok_or("협업이 꺼져 있다")?;
	f(&h);
	h.book_changed();
	Ok(h.info())
}

/// 링크를 만든다 — name 이 있으면 개인 링크, hours 가 있으면 그 시간 뒤 만료
#[tauri::command]
pub fn collab_link_new(app: AppHandle, name: Option<String>, hours: Option<u32>) -> Res<Info> {
	with_hub(&app, |h| {
		h.book.lock().unwrap().new_link(name, hours, now());
	})
}

/// 링크를 지운다 — 그 링크로 이미 들어온 기기는 그대로 (내보내려면 기기를 내보낸다)
#[tauri::command]
pub fn collab_link_remove(app: AppHandle, id: String) -> Res<Info> {
	with_hub(&app, |h| {
		let mut b = h.book.lock().unwrap();
		b.remove_link(&id);
		b.ensure_public(now());
	})
}

/// 기기를 내보낸다 — 붙어 있으면 그 자리에서 끊고, 기기 열쇠를 지워 다시 들어오려면 링크가 있어야 한다
#[tauri::command]
pub fn collab_kick(app: AppHandle, device: String) -> Res<Info> {
	with_hub(&app, |h| {
		h.book.lock().unwrap().remove_device(&device);
		for (d, tx) in h.conns.lock().unwrap().values() {
			if *d == device {
				let _ = tx.send(json!({ "t": "kicked" }).to_string());
				let _ = tx.send(CLOSE.into());
			}
		}
		if let Some(r) = h.runners.lock().unwrap().get(&device) {
			let _ = r.tx.send(CLOSE.into());
		}
	})
}

/// 회의 잠금 — 켜면 새 기기가 들어오지 못한다
#[tauri::command]
pub fn collab_lock(app: AppHandle, on: bool) -> Res<Info> {
	with_hub(&app, |h| {
		h.book.lock().unwrap().locked = on;
	})
}

/// 바깥 길을 열거나 닫는다 — 깔린 Tailscale(Funnel) · cloudflared 를 쓴다 (tunnel.rs)
#[tauri::command]
pub async fn collab_tunnel(app: AppHandle, on: bool) -> Res<Info> {
	let h = hub(&app).ok_or("협업이 꺼져 있다")?;
	let mut slot = h.tunnel.lock().await;
	if let Some(t) = slot.take() {
		crate::tunnel::stop(t).await;
	}
	*h.public.lock().unwrap() = None;
	if on {
		let t = crate::tunnel::start(h.port).await?;
		*h.public.lock().unwrap() = Some((t.url.clone(), t.kind));
		*slot = Some(t);
	}
	drop(slot);
	let _ = h.app.emit("collab-info", h.info());
	Ok(h.info())
}

/// 다른 사람의 공유 덱에 이 앱으로 들어간다 (2026.11.26) — 초대 링크나 들어간 적 있는 주소를 이 앱의 새 창으로 연다.
/// 창 안은 호스트가 내준 화면이라 협업 브라우저와 똑같이 돈다(__CPPT_REMOTE__ → transport.ts 의 remote).
/// 권한(capabilities/default.json)은 main 창에만 있다 — 남의 PC 가 내준 스크립트가 이 PC 의 파일 · claude · 설정을 부르지 못하게.
/// 기기 쿠키는 앱의 웹뷰 저장소에 남아, 다음에는 주소만으로 다시 들어온다. 같은 호스트는 창 하나 (다시 열면 그 창으로)
#[tauri::command]
pub async fn collab_join(app: AppHandle, url: String) -> Res<String> {
	let u = tauri::Url::parse(url.trim()).map_err(|_| "링크가 올바르지 않다".to_string())?;
	let host = u.host_str().ok_or("링크에 주소가 없다")?.to_string();
	if !matches!(u.scheme(), "http" | "https") {
		return Err("http · https 링크만 열 수 있다".into());
	}
	let origin = u.origin().ascii_serialization();
	let label = join_label(&origin);
	if let Some(w) = app.get_webview_window(&label) {
		let _ = w.unminimize();
		let _ = w.set_focus();
		// 초대 링크면 그리로(이름 묻기 · 쿠키 받기), 주소만이면 보던 화면 그대로
		if u.path().starts_with("/j/") {
			w.navigate(u).map_err(err)?;
		}
		return Ok(origin);
	}
	tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(u))
		.title(format!("ClaudePPT · {host}"))
		.inner_size(1440.0, 900.0)
		.min_inner_size(900.0, 600.0)
		.center()
		// 파일 · 쪽 끌어 놓기를 화면(HTML)이 받게 — Tauri 가 가로채면 첨부 · 쪽 끌어 놓기가 먹지 않는다
		.disable_drag_drop_handler()
		.initialization_script("window.__CPPT_REMOTE__ = true;")
		.build()
		.map_err(err)?;
	Ok(origin)
}

/// 공유 덱 창의 이름 — 호스트 주소마다 하나. 내 PC 의 Claude(runner.rs)가 이 창에서 기기 쿠키를 읽는다
pub fn join_label(origin: &str) -> String {
	format!("join-{}", etag(origin.as_bytes()).trim_matches('"'))
}

/// 바깥 길에 쓸 수 있는 도구 — 화면이 안내 글을 고른다
#[tauri::command]
pub async fn collab_tools() -> crate::tunnel::Tools {
	tokio::task::spawn_blocking(crate::tunnel::detect).await.unwrap_or(crate::tunnel::Tools { tailscale: None, cloudflared: None })
}

/// 연결 안에서만 쓰는 「끊어라」 표시 — 서버가 보내는 말과 겹치지 않는 글
const CLOSE: &str = "\u{0}close";

/// 끈다 — 붙어 있던 브라우저는 모두 끊긴다
#[tauri::command]
pub fn collab_stop(state: State<Collab>) {
	if let Some(tx) = state.stop.lock().unwrap().take() {
		let _ = tx.send(());
	}
	if let Some(h) = state.hub.lock().unwrap().take() {
		let _ = h.tx.send(json!({ "t": "bye" }).to_string().into());
		// 열린 WebSocket 을 닫는다 — 우아한 종료는 연결이 끝나기를 기다리고, 닫지 않으면 브라우저가 옛 서버에 붙은 채로 남아
		// 다시 켠 서버에 다시 붙지 못한다
		for (_, tx) in h.conns.lock().unwrap().values() {
			let _ = tx.send(CLOSE.into());
		}
		for r in h.runners.lock().unwrap().values() {
			let _ = r.tx.send(CLOSE.into());
		}
		for run in h.remote_runs.lock().unwrap().values_mut() {
			if let Some(d) = run.done.take() {
				let _ = d.send(json!({ "code": -1, "stderr": "협업을 껐다" }));
			}
		}
		let h2 = h.clone();
		tauri::async_runtime::spawn(async move {
			if let Some(t) = h2.tunnel.lock().await.take() {
				crate::tunnel::stop(t).await;
			}
		});
		for (_, tx) in h.pending.lock().unwrap().drain() {
			let _ = tx.send(json!({ "ok": false, "error": "stopped" }));
		}
	}
}

#[tauri::command]
pub fn collab_info(app: AppHandle) -> Option<Info> {
	hub(&app).map(|h| h.info())
}

/// 호스트 화면이 바뀐 상태를 올린다 — { set?: {키: 값}, turns?: { order?, put? }, reset? }
#[tauri::command]
pub fn collab_publish(app: AppHandle, patch: Value) {
	if let Some(h) = hub(&app) {
		h.publish(patch);
	}
}

/// 호스트 화면이 의도에 답한다 — { ok, value? , error? }
#[tauri::command]
pub fn collab_reply(app: AppHandle, id: String, reply: Value) {
	if let Some(h) = hub(&app) {
		if let Some(tx) = h.pending.lock().unwrap().remove(&id) {
			let _ = tx.send(reply);
		}
	}
}

/// 호스트도 한 사람으로 — 이름 · 보는 쪽
#[tauri::command]
pub fn collab_view(app: AppHandle, name: String, slide: Option<String>) {
	if let Some(h) = hub(&app) {
		h.members.lock().unwrap().insert(0, Member { conn: 0, device: String::new(), name, slide, host: true, since: now(), runner: false });
		h.members_changed();
	}
}

// ── HTTP ──

fn routes(h: Arc<Hub>) -> Router {
	Router::new()
		.route("/_/ws", get(ws))
		.route("/_/rpc", post(rpc))
		.route("/_/runner", get(runner_ws))
		.route("/_/runner/manifest", get(runner_manifest))
		.route("/_/runner/file", get(runner_file))
		.route("/_/d/{key}/{*rest}", get(deck))
		.route("/__rt.js", get(deck_rt))
		.route("/j/{token}", get(join_page).post(join))
		.fallback(get(front))
		.layer(middleware::from_fn_with_state(h.clone(), auth))
		.layer(tower_http::compression::CompressionLayer::new())
		.with_state(h)
}

fn cookie_of(headers: &HeaderMap) -> Option<String> {
	let raw = headers.get(header::COOKIE)?.to_str().ok()?;
	raw.split(';').map(str::trim).find_map(|c| c.strip_prefix(&format!("{COOKIE}=")).map(String::from))
}


/// 기기 쿠키 검사. 찾은 기기를 요청에 붙인다(Who). 초대 링크 · 슬라이드 · 런타임은 저마다 따로 본다
async fn auth(Ax(h): Ax<Arc<Hub>>, mut req: Request, next: Next) -> Response {
	let path = req.uri().path();
	// 슬라이드는 주소 안 덱 열쇠로(처리기가 본다), 런타임은 누구에게나 같은 코드라 열쇠 없이, 초대 링크는 링크 열쇠로
	if path.starts_with("/_/d/") || path == "/__rt.js" || path.starts_with("/j/") {
		return next.run(req).await;
	}
	let public = h.public.lock().unwrap().as_ref().map(|(u, _)| u.clone());
	if (path == "/_/ws" || path == "/_/rpc" || path.starts_with("/_/runner")) && !same_origin(req.headers(), public.as_deref()) {
		return StatusCode::FORBIDDEN.into_response();
	}
	let who = cookie_of(req.headers()).and_then(|c| h.book.lock().unwrap().device(&c, now())).map(|d| Who { device: d.id, name: d.name });
	match who {
		Some(w) => {
			req.extensions_mut().insert(w);
			next.run(req).await
		}
		None => page(StatusCode::UNAUTHORIZED, DENIED),
	}
}

fn page(status: StatusCode, html: &str) -> Response {
	(status, [(header::CONTENT_TYPE, "text/html; charset=utf-8")], html.to_string()).into_response()
}

/// 한국어 브라우저인가 — 초대 화면 글을 고른다
fn korean(headers: &HeaderMap) -> bool {
	headers.get(header::ACCEPT_LANGUAGE).and_then(|v| v.to_str().ok()).is_none_or(|l| l.trim_start().starts_with("ko"))
}

fn refused(headers: &HeaderMap, why: Why) -> Response {
	let ko = korean(headers);
	let msg = match (why, ko) {
		(Why::Expired, true) => "링크가 만료되었습니다. 호스트에게 새 링크를 받아 주세요.",
		(Why::Expired, false) => "This link has expired. Ask the host for a new one.",
		(Why::Locked, true) => "호스트가 회의를 잠갔습니다. 지금은 새로 들어올 수 없습니다.",
		(Why::Locked, false) => "The host locked the meeting. New people can't join right now.",
		(Why::Unknown, true) => "없는 링크입니다. 호스트에게 링크를 다시 받아 주세요.",
		(Why::Unknown, false) => "This link doesn't exist. Ask the host for the link again.",
	};
	page(StatusCode::FORBIDDEN, &format!("{HEAD}<p>{msg}</p>"))
}

const HEAD: &str = "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\"><title>ClaudePPT</title><style>body{font:15px system-ui,sans-serif;padding:48px;max-width:420px;margin:auto;color:#222}input,button{font:inherit;padding:8px 10px;border-radius:6px;border:1px solid #bbb}button{background:#222;color:#fff;border:0;margin-left:6px}</style><h2 style=\"font-size:18px\">ClaudePPT</h2>";

fn signed_in(secret: &str) -> Response {
	let mut r = Response::new(Body::empty());
	*r.status_mut() = StatusCode::SEE_OTHER;
	r.headers_mut().insert(header::LOCATION, HeaderValue::from_static("/"));
	// SameSite=Lax — 채팅 앱에서 링크를 눌러 들어온 첫 이동에도 붙어야 한다. 한 해 동안 기억한다(내보내면 서버에서 지운다)
	r.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&format!("{COOKIE}={secret}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000")).unwrap());
	r
}

/// 초대 링크를 열었다 — 이미 들어온 기기면 바로 화면으로, 개인 링크면 그 이름으로 들어오고, 공용 링크면 이름을 묻는다
async fn join_page(Ax(h): Ax<Arc<Hub>>, axum::extract::Path(token): axum::extract::Path<String>, headers: HeaderMap) -> Response {
	if cookie_of(&headers).is_some_and(|c| h.book.lock().unwrap().device(&c, now()).is_some()) {
		let mut r = Response::new(Body::empty());
		*r.status_mut() = StatusCode::SEE_OTHER;
		r.headers_mut().insert(header::LOCATION, HeaderValue::from_static("/"));
		return r;
	}
	let link = match h.book.lock().unwrap().link(&token, now()) {
		Ok(l) => l.clone(),
		Err(why) => return refused(&headers, why),
	};
	if link.name.is_some() {
		let (_, secret) = h.book.lock().unwrap().join(&link, "", &[], now());
		h.book_changed();
		return signed_in(&secret);
	}
	let (q, ph, go) = if korean(&headers) { ("들어가기 전에 이름을 적어 주세요. 요청 · 고친 것에 이 이름이 남습니다.", "이름", "들어가기") } else { ("Enter your name before joining. It is shown on your requests and edits.", "Name", "Join") };
	page(StatusCode::OK, &format!("{HEAD}<p>{q}</p><form method=post><input name=name placeholder=\"{ph}\" maxlength=40 required autofocus><button>{go}</button></form>"))
}

#[derive(serde::Deserialize)]
struct JoinForm {
	name: String,
}

/// 공용 링크에서 이름을 적고 들어온다
async fn join(Ax(h): Ax<Arc<Hub>>, axum::extract::Path(token): axum::extract::Path<String>, headers: HeaderMap, axum::Form(f): axum::Form<JoinForm>) -> Response {
	let link = match h.book.lock().unwrap().link(&token, now()) {
		Ok(l) => l.clone(),
		Err(why) => return refused(&headers, why),
	};
	if invite::clean_name(&f.name).is_empty() {
		return join_page(Ax(h), axum::extract::Path(token), headers).await;
	}
	let host = h.host_name();
	let (_, secret) = h.book.lock().unwrap().join(&link, &f.name, &host, now());
	h.book_changed();
	signed_in(&secret)
}

const DENIED: &str = "<!doctype html><meta charset=utf-8><title>ClaudePPT</title><body style=\"font:15px system-ui;padding:40px\"><p>초대 링크로 들어와 주세요. 호스트에게 링크를 받아 주세요.</p><p>Please open the invite link. Ask the host for one.</p>";

/// 요청을 보낸 페이지가 이 서버에서 온 것인가 — Origin 의 호스트:포트가 Host 와 같아야 한다.
/// 브라우저는 WebSocket 연결과 POST fetch 에 늘 Origin 을 붙인다. sandbox 슬라이드는 「null」이라 걸린다
/// 바깥 길로 온 요청은 터널이 Host 를 127.0.0.1 로 바꿔 보낼 수 있다 — 그래서 바깥 길 주소(public)와 같은 Origin 도 받는다
fn same_origin(headers: &HeaderMap, public: Option<&str>) -> bool {
	let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else { return false };
	if public.is_some_and(|p| p.trim_end_matches('/').eq_ignore_ascii_case(origin)) {
		return true;
	}
	let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else { return false };
	origin.split_once("://").is_some_and(|(_, h)| h.eq_ignore_ascii_case(host))
}

/// 내용으로 만든 ETag (FNV-1a 64)
fn etag(bytes: &[u8]) -> String {
	let mut x: u64 = 0xcbf29ce484222325;
	for b in bytes {
		x ^= *b as u64;
		x = x.wrapping_mul(0x100000001b3);
	}
	format!("\"{x:016x}\"")
}

/// 캐시 머리글 — immutable 이면 한 해 동안 다시 묻지 않고, 아니면 매번 ETag 로 묻는다(바뀌지 않았으면 304)
fn cached(mut r: Response, immutable: bool) -> Response {
	let v = if immutable { "public, max-age=31536000, immutable" } else { "no-cache" };
	r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(v));
	r
}

async fn deck(Ax(h): Ax<Arc<Hub>>, axum::extract::Path((key, _)): axum::extract::Path<(String, String)>, headers: HeaderMap, uri: Uri) -> Response {
	if !same(&key, &h.deck_key) {
		return StatusCode::UNAUTHORIZED.into_response();
	}
	let rest = uri.path()["/_/d/".len() + key.len()..].to_string();
	let r = crate::serve(&h.app, &rest);
	if r.status() != StatusCode::OK {
		return r.map(Body::from);
	}
	// 판 고정 주소(<id>@<커밋>/…)는 바뀌지 않는다
	let pinned = rest.trim_start_matches('/').split('/').next().is_some_and(|head| head.contains('@'));
	let html = r.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|c| c.starts_with("text/html"));
	let tag = etag(r.body());
	if !pinned && headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(tag.as_str()) {
		let mut nm = Response::new(Body::empty());
		*nm.status_mut() = StatusCode::NOT_MODIFIED;
		nm.headers_mut().insert(header::ETAG, HeaderValue::from_str(&tag).unwrap());
		return cached(nm, false);
	}
	let mut r = r.map(Body::from);
	let hd = r.headers_mut();
	// sandbox 슬라이드(출처 없음)가 글꼴 · 그림을 읽으려면 필요하다. 덱 열쇠가 곧 허락이라 쿠키를 쓰지 않는다
	hd.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
	hd.insert(header::ETAG, HeaderValue::from_str(&tag).unwrap());
	if html {
		hd.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("connect-src 'none'; form-action 'none'; base-uri 'self'; object-src 'none'"));
	}
	cached(r, pinned)
}

async fn deck_rt(Ax(h): Ax<Arc<Hub>>) -> Response {
	let mut r = crate::serve(&h.app, "/__rt.js").map(Body::from);
	r.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
	cached(r, false)
}

/// 화면 파일. 설치 판은 앱에 담긴 것, 개발 실행은 Vite(devUrl)로 넘긴다 — 개발 중 고친 화면이 바로 보이게
async fn front(Ax(h): Ax<Arc<Hub>>, uri: Uri) -> Response {
	if tauri::is_dev() {
		let Some(base) = h.app.config().build.dev_url.clone() else { return StatusCode::NOT_FOUND.into_response() };
		let url = format!("{}{}", base.as_str().trim_end_matches('/'), uri.path_and_query().map(|p| p.as_str()).unwrap_or("/"));
		return match reqwest::get(&url).await {
			Ok(r) => {
				let status = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
				let ct = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream").to_string();
				let body = r.bytes().await.unwrap_or_default();
				(status, [(header::CONTENT_TYPE, ct)], body).into_response()
			}
			Err(e) => (StatusCode::BAD_GATEWAY, e.to_string()).into_response(),
		};
	}
	let path = uri.path();
	let asset = h.app.asset_resolver().get(path.to_string()).or_else(|| h.app.asset_resolver().get("/index.html".into()));
	match asset {
		// Vite 가 이름에 내용 해시를 붙인 파일(/assets/…)은 바뀌지 않는다. index.html 은 새 판에서 바뀐다
		Some(a) => cached((StatusCode::OK, [(header::CONTENT_TYPE, a.mime_type)], a.bytes).into_response(), path.starts_with("/assets/")),
		None => StatusCode::NOT_FOUND.into_response(),
	}
}

/// 읽기만 — 열려 있는 덱(id) 안
async fn rpc(Ax(h): Ax<Arc<Hub>>, axum::Json(q): axum::Json<Value>) -> Response {
	let cmd = q["cmd"].as_str().unwrap_or("");
	let a = &q["args"];
	let dir = a["id"].as_str().and_then(|id| h.app.state::<AppState>().projects.lock().unwrap().get(id).cloned());
	let Some(dir) = dir else { return (StatusCode::NOT_FOUND, "덱이 열려 있지 않다").into_response() };
	let rel = a["rel"].as_str().unwrap_or("");
	let r: Res<Value> = match cmd {
		"read" => crate::fsx::inside(&dir.to_string_lossy(), rel).and_then(|p| std::fs::read_to_string(p).map_err(err)).map(Value::from),
		"exists" => crate::fsx::inside(&dir.to_string_lossy(), rel).map(|p| Value::from(p.exists())),
		"log" => {
			let limit = a["limit"].as_u64().map(|n| n as u32);
			let d = dir.to_string_lossy().to_string();
			tokio::task::spawn_blocking(move || crate::vcs::vcs_log(d, limit)).await.map_err(err).and_then(|r| r).map(|v| json!(v))
		}
		_ => Err(format!("원격에서는 쓸 수 없다: {cmd}")),
	};
	match r {
		Ok(v) => axum::Json(v).into_response(),
		Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
	}
}

// ── WebSocket ──

async fn ws(Ax(h): Ax<Arc<Hub>>, axum::Extension(who): axum::Extension<Who>, up: WebSocketUpgrade) -> Response {
	up.on_upgrade(move |s| conn(h, who, s))
}

async fn conn(h: Arc<Hub>, who: Who, mut socket: WebSocket) {
	let id = h.next.fetch_add(1, Ordering::SeqCst);
	let (direct, mut inbox) = mpsc::unbounded_channel::<String>();
	let mut rx = h.tx.subscribe();
	h.conns.lock().unwrap().insert(id, (who.device.clone(), direct.clone()));
	h.members.lock().unwrap().insert(id, Member { conn: id, device: who.device.clone(), name: who.name.clone(), slide: None, host: false, since: now(), runner: h.runners.lock().unwrap().contains_key(&who.device) });
	h.members_changed();
	let hello = json!({ "t": "hello", "conn": id, "deckKey": h.deck_key, "name": who.name }).to_string();
	if socket.send(Message::Text(hello.into())).await.is_err() || socket.send(Message::Text(h.snapshot().into())).await.is_err() {
		return;
	}
	let list: Vec<Member> = h.members.lock().unwrap().values().cloned().collect();
	let _ = socket.send(Message::Text(json!({ "t": "members", "list": list }).to_string().into())).await;
	let mut beat = tokio::time::interval_at(tokio::time::Instant::now() + BEAT, BEAT);
	// 브라우저에서 마지막으로 무엇이든 받은 때 — Ping 에는 브라우저가 알아서 Pong 으로 답한다
	let mut heard = tokio::time::Instant::now();
	loop {
		tokio::select! {
			m = socket.recv() => match m {
				Some(Ok(Message::Text(t))) => { heard = tokio::time::Instant::now(); on_message(&h, id, &direct, t.as_str()) }
				Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
				_ => heard = tokio::time::Instant::now(),
			},
			_ = beat.tick() => {
				if heard.elapsed() > BEAT * 3 { break; }
				if socket.send(Message::Ping(Default::default())).await.is_err() || socket.send(Message::Text(PING.into())).await.is_err() { break; }
			},
			b = rx.recv() => match b {
				Ok(s) => { if socket.send(Message::Text(s.to_string().into())).await.is_err() { break; } }
				// 따라가지 못했다 — 지금 상태를 통째로 다시 준다
				Err(broadcast::error::RecvError::Lagged(_)) => { if socket.send(Message::Text(h.snapshot().into())).await.is_err() { break; } }
				Err(broadcast::error::RecvError::Closed) => break,
			},
			d = inbox.recv() => match d {
				Some(s) if s == CLOSE => { let _ = socket.send(Message::Close(None)).await; break; }
				Some(s) => { if socket.send(Message::Text(s.into())).await.is_err() { break; } }
				None => break,
			},
		}
	}
	h.conns.lock().unwrap().remove(&id);
	if h.members.lock().unwrap().remove(&id).is_some() {
		h.members_changed();
	}
	let _ = h.app.emit("collab-info", h.info());
}

fn on_message(h: &Arc<Hub>, conn: u64, direct: &mpsc::UnboundedSender<String>, text: &str) {
	let Ok(m) = serde_json::from_str::<Value>(text) else { return };
	match m["t"].as_str().unwrap_or("") {
		// 이름 · 보는 쪽 — 들어올 때와 쪽을 옮길 때
		// 보는 쪽 — 이름은 서버가 정한 기기 이름 그대로 (브라우저가 보낸 이름은 쓰지 않는다)
		"hello" | "view" => {
			let slide = m["slide"].as_str().map(String::from);
			if let Some(e) = h.members.lock().unwrap().get_mut(&conn) {
				e.slide = slide;
			}
			h.members_changed();
		}
		"intent" => {
			let cid = m["id"].clone();
			let name = m["name"].as_str().unwrap_or("").to_string();
			if !INTENTS.contains(&name.as_str()) {
				let _ = direct.send(json!({ "t": "reply", "id": cid, "ok": false, "error": format!("원격에서는 할 수 없다: {name}") }).to_string());
				return;
			}
			let (who, device) = h.members.lock().unwrap().get(&conn).map(|x| (x.name.clone(), x.device.clone())).unwrap_or_default();
			let key = uuid::Uuid::new_v4().simple().to_string();
			let (tx, rx) = oneshot::channel();
			h.pending.lock().unwrap().insert(key.clone(), tx);
			let sent = h.app.emit("collab-intent", json!({ "id": key, "from": { "conn": conn, "name": who, "device": device }, "name": name, "args": m["args"] }));
			let (h2, direct) = (h.clone(), direct.clone());
			tauri::async_runtime::spawn(async move {
				let reply = if sent.is_err() { json!({ "ok": false, "error": "host" }) } else {
					match tokio::time::timeout(INTENT_WAIT, rx).await {
						Ok(Ok(v)) => v,
						_ => json!({ "ok": false, "error": "timeout" }),
					}
				};
				h2.pending.lock().unwrap().remove(&key);
				let mut r = json!({ "t": "reply", "id": cid });
				if let (Some(o), Some(src)) = (r.as_object_mut(), reply.as_object()) {
					for (k, v) in src {
						o.insert(k.clone(), v.clone());
					}
				}
				let _ = direct.send(r.to_string());
			});
		}
		_ => {}
	}
}

// ── 팀원 PC 의 Claude (runner.rs 가 붙는다) ──
//
// 2026.11.26 : 팀원이 「내 PC 의 Claude」로 보낸 턴도 덱 주인 앱이 지금처럼 지휘한다(줄 세우기 · 대화 · 판 · 그림 채우기).
// claude 프로세스만 팀원 PC 의 사본 폴더에서 돈다. 그래서 겪는 것이 덱 주인 Claude 와 같다:
//   출력 줄      팀원 PC 가 보낸 줄을 이 PC 의 「claude」 사건으로 그대로 낸다 — 대화칸 · 도구 목록 · 세션 id 가 같은 코드로 돈다
//   파일 쓰기    Claude 가 사본에 쓰는 즉시 그 파일을 보낸다(put). 여기서 덱에 쓰면 폴더 감시가 모두의 화면을 바로 다시 그린다
//   사본 맞추기  /_/runner/manifest · file 로 받고, 덱이 바뀌면 바뀐 경로를 알린다(files_changed) — Claude 는 늘 최신 파일을 읽는다
//   대화 기록    이어 쓸 세션이면 기록 글을 함께 보내고, 끝나면 늘어난 뒷부분을 받아 덱에 남긴다 — 누가 어느 PC 에서 이어 써도 맥락이 같다.
//                그 PC 가 마지막으로 이어 쓴 뒤 아무도 이어 쓰지 않았으면 기록을 다시 보내지 않는다 (기록은 수 MB 까지 커진다 — 바깥 길에서 시작이 늦었다)
//   경로        출력 줄 안의 사본 경로는 팀원 PC 가 표시(DECK_MARK)로 바꿔 보내고 여기서 덱 경로로 채운다 — 서로의 PC 경로(사용자 이름)가 건너가지 않는다
// 받는 쓰기는 그 기기의 턴이 도는 동안, 덱 폴더 안, .git · .claudeppt 밖만. 팀원 PC 가 덱 주인 PC 의 다른 곳을 건드리지 못하게

/// 팀원 PC 의 Claude 연결 하나
struct Runner {
	tx: mpsc::UnboundedSender<String>,
	conn: u64,
}

/// 출력 줄 안에서 사본 폴더 자리를 가리키는 표시 — runner.rs 와 같아야 한다. JSON 글 안에서 역슬래시로 쓴 경로 · 빗금으로 쓴 경로
pub const DECK_MARK: &str = "@@CPPT_DECK@@";
pub const DECK_MARK_FWD: &str = "@@CPPT_DECK_FWD@@";

/// 팀원 PC 에서 도는 턴
struct RemoteRun {
	device: String,
	dir: PathBuf,
	done: Option<oneshot::Sender<Value>>,
}

/// 사본에 넣는 파일인가 — 판 이력 · 앱 상태는 빼고, 턴이 읽는 첨부 · 판 펼침은 넣는다
fn mirrored(rel: &str) -> bool {
	!rel.is_empty()
		&& !rel.starts_with(".git")
		&& !rel.starts_with("releases/")
		&& (!rel.starts_with(".claudeppt/") || rel.starts_with(".claudeppt/attach/") || rel.starts_with(".claudeppt/versions/"))
}

/// 팀원 PC 가 써도 되는 파일인가 — Claude 가 고치는 덱 파일만
fn writable(rel: &str) -> bool {
	!rel.is_empty() && !rel.starts_with(".git") && !rel.starts_with(".claudeppt") && !rel.starts_with("releases/") && !rel.contains("..") && !rel.starts_with('/')
}

impl Hub {
	/// 지금 내준 덱 폴더 — 호스트 화면이 올린 상태의 dir. 열린 프로젝트일 때만
	fn deck_dir(&self) -> Option<(String, PathBuf)> {
		let (dir, id) = {
			let s = self.shared.lock().unwrap();
			(s.set.get("dir")?.as_str()?.to_string(), s.set.get("id")?.as_str()?.to_string())
		};
		let open = self.app.state::<AppState>().projects.lock().unwrap().get(&id).cloned()?;
		(open == PathBuf::from(&dir)).then_some((id, open))
	}

	fn set_runner_flag(&self, device: &str, on: bool) {
		for m in self.members.lock().unwrap().values_mut() {
			if m.device == device {
				m.runner = on;
			}
		}
		self.members_changed();
	}
}

/// 덱이 바뀌었다 (watch.rs) — 붙어 있는 팀원 PC 들이 사본을 맞춘다. 경로마다 내용 지문(없어졌으면 null)을 함께 보낸다 —
/// 팀원 PC 가 방금 보낸 파일이면 지문이 같아 다시 받지 않는다
pub fn files_changed(app: &AppHandle, paths: &[String]) {
	let Some(h) = hub(app) else { return };
	if h.runners.lock().unwrap().is_empty() {
		return;
	}
	let Some((_, dir)) = h.deck_dir() else { return };
	let mut files = Map::new();
	for p in paths.iter().filter(|p| mirrored(p)) {
		let hash = std::fs::read(dir.join(p)).ok().map(|b| etag(&b).trim_matches('"').to_string());
		files.insert(p.clone(), hash.map(Value::from).unwrap_or(Value::Null));
	}
	if files.is_empty() {
		return;
	}
	let msg = json!({ "t": "changed", "files": files }).to_string();
	for r in h.runners.lock().unwrap().values() {
		let _ = r.tx.send(msg.clone());
	}
}

/// 사본에 넣을 파일 목록과 내용 지문
async fn runner_manifest(Ax(h): Ax<Arc<Hub>>) -> Response {
	let Some((id, dir)) = h.deck_dir() else { return (StatusCode::NOT_FOUND, "덱이 열려 있지 않다").into_response() };
	let files = tokio::task::spawn_blocking(move || {
		let mut out = Map::new();
		let mut stack = vec![dir.clone()];
		while let Some(d) = stack.pop() {
			for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
				let p = e.path();
				let rel = p.strip_prefix(&dir).unwrap().to_string_lossy().replace('\\', "/");
				if p.is_dir() {
					if rel != ".git" && rel != "releases" {
						stack.push(p);
					}
				} else if mirrored(&rel) {
					if let Ok(b) = std::fs::read(&p) {
						out.insert(rel, Value::from(etag(&b).trim_matches('"').to_string()));
					}
				}
			}
		}
		out
	})
	.await
	.unwrap_or_default();
	axum::Json(json!({ "id": id, "files": files })).into_response()
}

#[derive(serde::Deserialize)]
struct FileQ {
	path: String,
}

async fn runner_file(Ax(h): Ax<Arc<Hub>>, axum::extract::Query(q): axum::extract::Query<FileQ>) -> Response {
	let Some((_, dir)) = h.deck_dir() else { return StatusCode::NOT_FOUND.into_response() };
	if !mirrored(&q.path) {
		return StatusCode::FORBIDDEN.into_response();
	}
	match crate::fsx::inside(&dir.to_string_lossy(), &q.path).and_then(|p| std::fs::read(p).map_err(err)) {
		Ok(b) => (StatusCode::OK, [(header::CONTENT_TYPE, "application/octet-stream")], b).into_response(),
		Err(_) => StatusCode::NOT_FOUND.into_response(),
	}
}

async fn runner_ws(Ax(h): Ax<Arc<Hub>>, axum::Extension(who): axum::Extension<Who>, up: WebSocketUpgrade) -> Response {
	// 대화 기록 · 그림 파일이 한 번에 온다
	up.max_message_size(256 << 20).on_upgrade(move |s| runner_conn(h, who, s))
}

async fn runner_conn(h: Arc<Hub>, who: Who, mut socket: WebSocket) {
	let id = h.next.fetch_add(1, Ordering::SeqCst);
	let (tx, mut inbox) = mpsc::unbounded_channel::<String>();
	// 한 기기에 하나 — 다시 붙으면 옛 연결을 끊는다
	let old = h.runners.lock().unwrap().insert(who.device.clone(), Runner { tx, conn: id });
	if let Some(old) = old {
		let _ = old.tx.send(CLOSE.into());
		// 옛 연결에서 돌던 턴은 그 PC 가 이미 껐다(runner.rs 는 끊기면 claude 를 끈다). 끝내지 않으면 3시간 동안 「도는 중」으로 남는다
		fail_runs(&h, &who.device, "팀원 PC 가 다시 붙었다");
	}
	h.set_runner_flag(&who.device, true);
	let mut beat = tokio::time::interval_at(tokio::time::Instant::now() + BEAT, BEAT);
	let mut heard = tokio::time::Instant::now();
	loop {
		tokio::select! {
			m = socket.recv() => match m {
				Some(Ok(Message::Text(t))) => { heard = tokio::time::Instant::now(); on_runner_message(&h, &who.device, t.as_str()) }
				Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
				_ => heard = tokio::time::Instant::now(),
			},
			d = inbox.recv() => match d {
				Some(s) if s == CLOSE => { let _ = socket.send(Message::Close(None)).await; break; }
				Some(s) => { if socket.send(Message::Text(s.into())).await.is_err() { break; } }
				None => break,
			},
			_ = beat.tick() => {
				if heard.elapsed() > BEAT * 3 { break; }
				if socket.send(Message::Ping(Default::default())).await.is_err() { break; }
			},
		}
	}
	let mine = {
		let mut r = h.runners.lock().unwrap();
		let mine = r.get(&who.device).is_some_and(|x| x.conn == id);
		if mine {
			r.remove(&who.device);
		}
		mine
	};
	if mine {
		h.set_runner_flag(&who.device, false);
		// 그 PC 에서 돌던 턴은 끝낸다 — 그때까지 보낸 파일은 덱에 남는다(이 PC 에서 멈춘 턴과 같다)
		fail_runs(&h, &who.device, "팀원 PC 와 연결이 끊겼다");
	}
}

fn fail_runs(h: &Hub, device: &str, why: &str) {
	for run in h.remote_runs.lock().unwrap().values_mut().filter(|r| r.device == device) {
		if let Some(d) = run.done.take() {
			let _ = d.send(json!({ "code": -1, "stderr": why }));
		}
	}
}

/// 출력 줄 안의 사본 자리 표시를 덱 경로로 — JSON 글 안이라 역슬래시는 둘이다
fn rewrite(line: &str, dir: &Path) -> String {
	let host = dir.to_string_lossy().to_string();
	line.replace(DECK_MARK, &host.replace('\\', "\\\\")).replace(DECK_MARK_FWD, &host.replace('\\', "/"))
}

fn on_runner_message(h: &Arc<Hub>, device: &str, text: &str) {
	let Ok(m) = serde_json::from_str::<Value>(text) else { return };
	let turn = m["turn"].as_str().unwrap_or("").to_string();
	// 그 기기의 턴인가 — 남의 턴 이름으로 줄 · 파일을 보내지 못하게
	let run_dir = || h.remote_runs.lock().unwrap().get(&turn).filter(|r| r.device == device).map(|r| r.dir.clone());
	match m["t"].as_str().unwrap_or("") {
		"line" => {
			let Some(dir) = run_dir() else { return };
			let line = rewrite(m["line"].as_str().unwrap_or(""), &dir);
			let _ = h.app.emit("claude", json!({ "turn": turn, "line": line }));
		}
		"put" => {
			let Some(dir) = run_dir() else { return };
			let rel = m["path"].as_str().unwrap_or("");
			use base64::Engine;
			let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(m["data"].as_str().unwrap_or("")) else { return };
			if !writable(rel) || bytes.len() > 64 << 20 {
				return;
			}
			if let Ok(p) = crate::fsx::inside(&dir.to_string_lossy(), rel) {
				if let Some(d) = p.parent() {
					let _ = std::fs::create_dir_all(d);
				}
				let _ = std::fs::write(p, bytes);
			}
		}
		"exit" => {
			let Some(dir) = run_dir() else { return };
			// 기록은 덧붙기만 한다 — 팀원 PC 는 받은(또는 이미 있던) 길이 base 뒤의 것만 보낸다. 덱의 기록 길이가 base 와 같을 때만 잇는다
			if let (Some(sid), Some(tail)) = (m["sid"].as_str(), m["tail"].as_str()) {
				let base = m["base"].as_u64().unwrap_or(0) as usize;
				let have = crate::claude::saved_transcript(&dir, sid).unwrap_or_default();
				let full = if base == 0 { Some(tail.to_string()) } else if have.len() == base { Some(have + tail) } else { None };
				if let Some(full) = full {
					crate::claude::save_transcript(&dir, sid, &full);
					h.transcript_at.lock().unwrap().insert(sid.to_string(), (device.to_string(), full.len()));
				}
			}
			if let Some(d) = h.remote_runs.lock().unwrap().get_mut(&turn).and_then(|r| r.done.take()) {
				let _ = d.send(json!({ "code": m["code"].as_i64().unwrap_or(-1), "stderr": m["stderr"].as_str().unwrap_or("") }));
			}
		}
		_ => {}
	}
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSpec {
	turn: String,
	dir: String,
	device: String,
	prompt: String,
	system: String,
	resume: Option<String>,
	session_id: Option<String>,
}

/// 턴을 팀원 PC 의 Claude 로 돌린다 — claude_run 과 같은 답({code, stderr})을 준다. 줄은 그 사이 「claude」 사건으로 온다
#[tauri::command]
pub async fn claude_run_remote(app: AppHandle, spec: RemoteSpec) -> Res<Value> {
	let h = hub(&app).ok_or("협업이 꺼져 있다")?;
	let tx = h.runners.lock().unwrap().get(&spec.device).map(|r| r.tx.clone()).ok_or("그 팀원 PC 의 Claude 가 연결되어 있지 않다")?;
	let dir = PathBuf::from(&spec.dir);
	let resume = spec.resume.clone().filter(|s| !s.is_empty());
	// 이어 쓸 기록 — 덱에 남겨 두고(끝나면 뒷부분을 여기에 잇는다), 그 PC 가 이미 같은 기록을 쥐고 있으면 보내지 않는다
	let mut transcript = None;
	let mut transcript_len = 0usize;
	if let Some(sid) = resume.as_deref() {
		if let Some(t) = crate::claude::transcript_text(&dir, sid) {
			if crate::claude::saved_transcript(&dir, sid).as_deref() != Some(t.as_str()) {
				crate::claude::save_transcript(&dir, sid, &t);
			}
			transcript_len = t.len();
			let held = h.transcript_at.lock().unwrap().get(sid).is_some_and(|(d, n)| *d == spec.device && *n == t.len());
			if !held {
				transcript = Some(t);
			}
		}
	}
	let (done_tx, done_rx) = oneshot::channel();
	h.remote_runs.lock().unwrap().insert(spec.turn.clone(), RemoteRun { device: spec.device.clone(), dir, done: Some(done_tx) });
	let job = json!({ "t": "run", "turn": spec.turn, "prompt": spec.prompt, "system": spec.system, "resume": resume, "sessionId": spec.session_id, "transcript": transcript, "transcriptLen": transcript_len });
	if tx.send(job.to_string()).is_err() {
		h.remote_runs.lock().unwrap().remove(&spec.turn);
		return Err("그 팀원 PC 의 Claude 가 연결되어 있지 않다".into());
	}
	let r = tokio::time::timeout(INTENT_WAIT, done_rx).await;
	h.remote_runs.lock().unwrap().remove(&spec.turn);
	let v = match r {
		Ok(Ok(v)) => v,
		_ => json!({ "code": -1, "stderr": "팀원 PC 가 답하지 않았다" }),
	};
	Ok(json!({ "turn": spec.turn, "code": v["code"], "stderr": v["stderr"] }))
}

/// 팀원 PC 에서 도는 턴이면 멈추라고 보낸다 (claude_stop 이 부른다)
pub fn stop_remote(app: &AppHandle, turn: &str) {
	let Some(h) = hub(app) else { return };
	let device = h.remote_runs.lock().unwrap().get(turn).map(|r| r.device.clone());
	if let Some(d) = device {
		if let Some(r) = h.runners.lock().unwrap().get(&d) {
			let _ = r.tx.send(json!({ "t": "stop", "turn": turn }).to_string());
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn token_compare_is_exact() {
		assert!(same("abc", "abc"));
		assert!(!same("abc", "abd"));
		assert!(!same("abc", "ab"));
		assert!(!same("", "a"));
	}

	#[test]
	fn reads_cookie() {
		let mut h = HeaderMap::new();
		h.insert(header::COOKIE, HeaderValue::from_static("a=1; cppt_d=tok; b=2"));
		assert_eq!(cookie_of(&h).as_deref(), Some("tok"));
	}

	#[test]
	fn origin_must_match_host() {
		let h = |origin: Option<&'static str>, host: &'static str| {
			let mut m = HeaderMap::new();
			if let Some(o) = origin {
				m.insert(header::ORIGIN, HeaderValue::from_static(o));
			}
			m.insert(header::HOST, HeaderValue::from_static(host));
			same_origin(&m, None)
		};
		assert!(h(Some("http://10.0.0.5:47815"), "10.0.0.5:47815"));
		assert!(h(Some("https://abc.ts.net"), "abc.ts.net"));
		assert!(!h(Some("http://10.0.0.5:8080"), "10.0.0.5:47815"), "같은 PC 다른 포트");
		assert!(!h(Some("null"), "10.0.0.5:47815"), "sandbox 슬라이드");
		assert!(!h(Some("https://evil.example"), "10.0.0.5:47815"));
		assert!(!h(None, "10.0.0.5:47815"));
		// 바깥 길: Host 가 127.0.0.1 로 바뀌어 와도 터널 주소와 같은 Origin 은 받는다
		let mut m = HeaderMap::new();
		m.insert(header::ORIGIN, HeaderValue::from_static("https://plain-dog.trycloudflare.com"));
		m.insert(header::HOST, HeaderValue::from_static("127.0.0.1:47815"));
		assert!(same_origin(&m, Some("https://plain-dog.trycloudflare.com")));
		assert!(!same_origin(&m, Some("https://other.trycloudflare.com")));
		assert!(!same_origin(&m, None));
	}

	#[test]
	fn etag_follows_content() {
		assert_eq!(etag(b"a"), etag(b"a"));
		assert_ne!(etag(b"a"), etag(b"b"));
		assert!(etag(b"").starts_with('"') && etag(b"").ends_with('"'));
	}

	#[test]
	fn runner_reads_and_writes_only_deck_files() {
		for ok in ["slides/s1.html", "theme.css", "assets/a.png", ".claudeppt/attach/x.png", ".claudeppt/versions/v3/slides/s1.html", "deck.json"] {
			assert!(mirrored(ok), "{ok}");
		}
		for no in [".git/config", ".claudeppt/talk.json", ".claudeppt/sessions/a.jsonl", "releases/r1.pptx", ""] {
			assert!(!mirrored(no), "{no}");
		}
		for ok in ["slides/s1.html", "theme.css", "assets/new.svg", "deck.json"] {
			assert!(writable(ok), "{ok}");
		}
		for no in [".git/hooks/post-commit", ".claudeppt/talk.json", "../x", "/etc/x", "slides/../../x", "releases/r.pptx"] {
			assert!(!writable(no), "{no}");
		}
	}

	#[test]
	fn fills_deck_marks_in_json_lines() {
		// 출력 줄은 JSON 이라 경로의 역슬래시가 둘이다. 팀원 PC 는 사본 자리를 표시로 바꿔 보낸다
		let line = r#"{"file_path":"@@CPPT_DECK@@\\slides\\s1.html","p":"@@CPPT_DECK_FWD@@/theme.css"}"#;
		let out = rewrite(line, Path::new(r"D:\d\덱"));
		assert_eq!(out, r#"{"file_path":"D:\\d\\덱\\slides\\s1.html","p":"D:/d/덱/theme.css"}"#);
		assert!(serde_json::from_str::<Value>(&out).is_ok());
	}

	#[test]
	fn only_listed_intents_pass() {
		for ok in ["send", "direct", "pinAdd"] {
			assert!(INTENTS.contains(&ok));
		}
		for bad in ["exportTo", "release", "openProject", "settingsSave", "restore", "claudeRun"] {
			assert!(!INTENTS.contains(&bad));
		}
	}
}
