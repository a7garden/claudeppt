// 공유 덱을 앱끼리 잇는다 (2026.11.26) — 설치 · 계정 없이, PC 전체가 아니라 이 앱만 망에 붙는다 (iroh).
//
//   열쇠      앱마다 한 번 만든 열쇠(ed25519)가 곧 주소다. 앱 데이터 p2p.key 에 Windows 보호 저장(DPAPI)으로 싸 둔다 — IP 가 바뀌어도 같은 열쇠로 찾는다.
//             초대 링크는 claudeppt://<덱 주인 앱 열쇠>/j/<링크 열쇠> 꼴이다 (collab.rs Info.app)
//   잇기      iroh 가 덱 주인 앱을 열쇠로 찾아(n0 주소록) 직접 잇고(구멍 뚫기), 안 되면 중계를 거친다. 늘 종단 간 암호화 — 중계는 내용을 못 본다.
//             2026.11.26 : 중계는 iroh 를 만든 곳(n0)의 공용 중계를 쓴다. 문서상 시험용이라 속도 제한이 있다 — 사무실 안은 대개 직접 이어져 거의 거치지 않는다
//   덱 주인   들어온 흐름(stream)마다 이 PC 의 협업 서버(127.0.0.1:<포트>)로 그대로 넘긴다. 협업이 꺼져 있으면 연결을 닫는다.
//             누가 들어오는지는 지금처럼 협업 서버가 초대 링크 · 기기 쿠키로 가린다 — 열쇠를 안다고 들어오지 못한다
//   팀원      덱 주인마다 이 PC 안에만 열리는 출입구(127.0.0.1)를 하나 두고, 거기로 온 TCP 연결을 iroh 흐름 하나로 잇는다.
//             공유 덱 창은 http://<열쇠 앞부분>.localhost:<포트> 를 연다 — 웹뷰(Chromium)는 *.localhost 를 이 PC 로 잇는다.
//             덱 주인마다 이름이 달라 쿠키가 섞이지 않는다(쿠키는 포트를 가리지 않는다). 「내 Claude」(runner.rs)는 Windows 가 *.localhost 를
//             못 찾으므로 127.0.0.1 로 바로 잇는다 (direct)

use crate::{Res, err};
use base64::Engine;
use iroh::endpoint::{Connection, RecvStream, SendStream, presets};
use iroh::{Endpoint, EndpointId, SecretKey};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

/// 앱끼리 잇는 링크의 머리 — claudeppt://<열쇠>/…
pub const SCHEME: &str = "claudeppt";
/// 이 앱끼리만 말이 통한다 — 다른 iroh 앱이 이 열쇠로 와도 손을 잡지 않는다
const ALPN: &[u8] = b"claudeppt/collab/1";
/// 덱 주인에게 닿기를 기다리는 가장 긴 시간 — 처음 찾기(주소록) · 구멍 뚫기를 합쳐
const DIAL: Duration = Duration::from_secs(20);

#[derive(Default)]
pub struct P2p {
	ep: tokio::sync::OnceCell<Endpoint>,
	/// 팀원 쪽 출입구 — 덱 주인 열쇠(z32) → 출입구
	gates: Mutex<HashMap<String, Arc<Gate>>>,
}

struct Gate {
	origin: String,
	/// 덱 주인과의 연결 하나 — 흐름(HTTP 연결 하나)마다 새로 잇지 않는다. 끊겼으면 다음 흐름에서 다시 잇는다
	conn: tokio::sync::Mutex<Option<Connection>>,
}

fn key_file() -> std::path::PathBuf {
	crate::control::data_dir().join("p2p.key")
}

/// 이 앱의 열쇠 — 처음 한 번 만들어 남긴다. 못 남기면(보호 저장이 안 되는 곳) 이번 실행에만 쓴다
fn secret() -> SecretKey {
	let b64 = base64::engine::general_purpose::STANDARD;
	let saved = std::fs::read_to_string(key_file()).ok().and_then(|t| b64.decode(t.trim()).ok()).and_then(|b| crate::runner::dpapi::unprotect(&b)).and_then(|b| <[u8; 32]>::try_from(b).ok());
	if let Some(b) = saved {
		return SecretKey::from_bytes(&b);
	}
	let k = SecretKey::generate();
	if let Some(sealed) = crate::runner::dpapi::protect(&k.to_bytes()) {
		let _ = std::fs::create_dir_all(crate::control::data_dir());
		let _ = std::fs::write(key_file(), b64.encode(sealed));
	}
	k
}

/// 이 앱의 iroh 끝점 — 처음 쓸 때 연다(덱 주인으로 공유를 켤 때 · 팀원으로 공유 덱에 들어갈 때). 앱이 꺼질 때까지 둔다
async fn endpoint(app: &AppHandle) -> Res<Endpoint> {
	let p = app.state::<P2p>();
	let ep = p
		.ep
		.get_or_try_init(|| async {
			let ep = Endpoint::builder(presets::N0).secret_key(secret()).alpns(vec![ALPN.to_vec()]).bind().await.map_err(|e| format!("앱끼리 잇는 길을 열지 못했다: {e}"))?;
			let (ep2, app2) = (ep.clone(), app.clone());
			tauri::async_runtime::spawn(async move { serve(app2, ep2).await });
			Ok::<_, String>(ep)
		})
		.await?;
	Ok(ep.clone())
}

/// 이 앱의 열쇠(z32) — 덱 주인의 초대 링크에 들어간다. 공유를 켤 때 부른다
pub async fn my_id(app: &AppHandle) -> Res<String> {
	Ok(endpoint(app).await?.id().to_z32())
}

// ── 덱 주인 ──

/// 들어온 연결을 받는다 — 흐름마다 협업 서버로 넘긴다
async fn serve(app: AppHandle, ep: Endpoint) {
	while let Some(incoming) = ep.accept().await {
		let app = app.clone();
		tauri::async_runtime::spawn(async move {
			let Ok(conn) = incoming.await else { return };
			while let Ok((send, recv)) = conn.accept_bi().await {
				// 협업이 꺼져 있으면 받지 않는다 — 팀원 출입구는 「덱 주인이 공유를 끄셨습니다」를 보인다
				let Some(port) = crate::collab::serving_port(&app) else {
					conn.close(1u32.into(), b"off");
					return;
				};
				tauri::async_runtime::spawn(async move {
					if let Ok(tcp) = TcpStream::connect(("127.0.0.1", port)).await {
						pipe(tcp, send, recv).await;
					}
				});
			}
		});
	}
}

/// TCP 하나와 iroh 흐름 하나를 양쪽으로 잇는다 — 한쪽이 다 보내면 다른 쪽에 「끝」을 알린다
async fn pipe(tcp: TcpStream, mut send: SendStream, mut recv: RecvStream) {
	let (mut r, mut w) = tcp.into_split();
	let up = async {
		let _ = tokio::io::copy(&mut r, &mut send).await;
		let _ = send.finish();
	};
	let down = async {
		let _ = tokio::io::copy(&mut recv, &mut w).await;
		let _ = w.shutdown().await;
	};
	tokio::join!(up, down);
}

// ── 팀원 ──

/// claudeppt://<열쇠>… 에서 열쇠를 꺼낸다 (소문자 z32)
pub fn id_of(url: &str) -> Option<String> {
	let rest = url.trim().strip_prefix(SCHEME)?.strip_prefix("://")?;
	let id = rest.split(['/', '?', '#']).next()?.to_ascii_lowercase();
	EndpointId::from_z32(&id).ok().map(|_| id)
}

/// 덱 주인을 가리키는 이름 — claudeppt://<열쇠> 는 그대로, http(s) 는 origin. 공유 덱 목록 · 「내 Claude」 열쇠 · 창 이름이 이것으로 덱 주인을 가린다
/// (팀원 출입구의 포트는 실행마다 바뀔 수 있어 이름으로 쓰지 않는다)
pub fn canon(url: &str) -> Res<String> {
	if let Some(id) = id_of(url) {
		return Ok(format!("{SCHEME}://{id}"));
	}
	let u = tauri::Url::parse(url.trim()).map_err(|_| "링크가 올바르지 않다".to_string())?;
	if !matches!(u.scheme(), "http" | "https") {
		return Err("ClaudePPT 초대 링크(claudeppt://) 나 http · https 링크만 열 수 있다".into());
	}
	Ok(u.origin().ascii_serialization())
}

/// 덱 주인에게 닿는 http 주소 — 앱끼리 잇는 덱 주인이면 출입구를 열고(이미 있으면 그것) 그 주소, 아니면 canon 그대로
pub async fn reach(app: &AppHandle, canon: &str) -> Res<String> {
	match id_of(canon) {
		Some(id) => Ok(gate(app, &id).await?.origin.clone()),
		None => Ok(canon.to_string()),
	}
}

/// *.localhost 출입구면 127.0.0.1:<포트> — Windows 는 *.localhost 를 못 찾는다 (runner.rs 가 직접 잇는다)
pub fn direct(origin: &str) -> Option<std::net::SocketAddr> {
	let u = tauri::Url::parse(origin).ok()?;
	u.host_str()?.ends_with(".localhost").then(|| std::net::SocketAddr::from(([127, 0, 0, 1], u.port().unwrap_or(80))))
}

/// 출입구 포트 — 열쇠마다 늘 같은 자리부터 해 본다(웹뷰가 주소별로 남기는 것이 실행마다 흩어지지 않게). 쓰이고 있으면 다음 자리
fn first_port(id: &str) -> u16 {
	let h = id.bytes().fold(0xcbf29ce484222325u64, |x, b| (x ^ b as u64).wrapping_mul(0x100000001b3));
	20000 + (h % 20000) as u16
}

async fn gate(app: &AppHandle, id: &str) -> Res<Arc<Gate>> {
	if let Some(g) = app.state::<P2p>().gates.lock().unwrap().get(id) {
		return Ok(g.clone());
	}
	let host = EndpointId::from_z32(id).map_err(|_| "초대 링크의 덱 주인 열쇠가 올바르지 않다".to_string())?;
	let ep = endpoint(app).await?;
	if ep.id() == host {
		return Err("내 앱의 링크다 — 이 덱은 이미 이 앱에서 열려 있다".into());
	}
	let mut listener = None;
	for i in 0..20 {
		if let Ok(l) = tokio::net::TcpListener::bind(("127.0.0.1", first_port(id).wrapping_add(i))).await {
			listener = Some(l);
			break;
		}
	}
	let listener = match listener {
		Some(l) => l,
		None => tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.map_err(err)?,
	};
	let port = listener.local_addr().map_err(err)?.port();
	// 이름 한 칸은 63자까지 — 열쇠(52자) 앞 20자로 덱 주인을 가린다
	let g = Arc::new(Gate { origin: format!("http://{}.localhost:{port}", &id[..20]), conn: tokio::sync::Mutex::new(None) });
	{
		let p = app.state::<P2p>();
		let mut gates = p.gates.lock().unwrap();
		if let Some(other) = gates.get(id) {
			return Ok(other.clone());
		}
		gates.insert(id.to_string(), g.clone());
	}
	let g2 = g.clone();
	tauri::async_runtime::spawn(async move {
		while let Ok((tcp, _)) = listener.accept().await {
			let (g, ep) = (g2.clone(), ep.clone());
			tauri::async_runtime::spawn(async move {
				match stream(&g, &ep, host).await {
					Ok((send, recv)) => pipe(tcp, send, recv).await,
					Err(e) => unreachable_page(tcp, &e).await,
				}
			});
		}
	});
	Ok(g)
}

/// 덱 주인에게 흐름 하나를 연다 — 연결이 없거나 끊겼으면 다시 잇는다
async fn stream(g: &Gate, ep: &Endpoint, host: EndpointId) -> Res<(SendStream, RecvStream)> {
	let mut slot = g.conn.lock().await;
	if let Some(c) = slot.as_ref() {
		if c.close_reason().is_none() {
			if let Ok(s) = c.open_bi().await {
				return Ok(s);
			}
		}
	}
	*slot = None;
	let c = tokio::time::timeout(DIAL, ep.connect(host, ALPN)).await.map_err(|_| "덱 주인 앱에 닿지 못했다 (시간 초과)".to_string())?.map_err(|e| format!("덱 주인 앱에 닿지 못했다: {e}"))?;
	let s = c.open_bi().await.map_err(err)?;
	*slot = Some(c);
	Ok(s)
}

/// 닿지 못했으면 공유 덱 창에 까닭을 보인다 — 빈 창 · 브라우저 오류 화면 대신
async fn unreachable_page(mut tcp: TcpStream, why: &str) {
	let body = format!(
		"<!doctype html><meta charset=utf-8><title>ClaudePPT</title><body style=\"font:15px system-ui,sans-serif;padding:48px;max-width:460px;margin:auto;color:#222\"><h2 style=\"font-size:18px\">덱 주인 앱에 닿지 못했습니다</h2><p>덱 주인의 ClaudePPT 가 켜져 있고 공유 중인지 확인해 주세요. 확인한 뒤 이 창을 새로 고치면(F5) 다시 잇습니다.</p><p style=\"color:#888;font-size:13px\">{}</p>",
		why.replace('<', "&lt;")
	);
	let head = format!("HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
	let _ = tcp.write_all(head.as_bytes()).await;
	let _ = tcp.write_all(body.as_bytes()).await;
	let _ = tcp.shutdown().await;
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn reads_app_links() {
		let id = SecretKey::generate().public().to_z32();
		assert_eq!(id_of(&format!("claudeppt://{id}/j/abc")), Some(id.clone()));
		assert_eq!(id_of(&format!("  CLAUDEPPT://{}/  ", id.to_uppercase())), None, "머리는 소문자만");
		assert_eq!(id_of(&format!("claudeppt://{}/j/abc", id.to_uppercase())), Some(id.clone()), "열쇠 대소문자는 가리지 않는다");
		assert_eq!(id_of("claudeppt://nothex/j/abc"), None);
		assert_eq!(canon(&format!("claudeppt://{id}/j/abc")).unwrap(), format!("claudeppt://{id}"));
		assert_eq!(canon("http://10.0.0.5:47815/j/abc").unwrap(), "http://10.0.0.5:47815");
		assert!(canon("file:///c:/x").is_err());
	}

	#[test]
	fn gate_address_goes_straight_to_this_pc() {
		assert_eq!(direct("http://abcd.localhost:23456"), Some(([127, 0, 0, 1], 23456).into()));
		assert_eq!(direct("http://10.0.0.5:47815"), None);
		assert_eq!(first_port("abc"), first_port("abc"));
		assert!((20000..40000).contains(&first_port("anything")));
	}

	/// 두 끝점을 이 PC 안에서 잇고(중계 · 주소록 없이) 흐름이 양쪽으로 오가는지 본다
	#[tokio::test]
	async fn pipes_a_tcp_connection_through_iroh() {
		use tokio::io::AsyncReadExt;
		let host = Endpoint::builder(presets::Minimal).relay_mode(iroh::RelayMode::Disabled).alpns(vec![ALPN.to_vec()]).bind().await.unwrap();
		let member = Endpoint::builder(presets::Minimal).relay_mode(iroh::RelayMode::Disabled).bind().await.unwrap();
		// 덱 주인 쪽 「협업 서버」 — 받은 것을 크게 바꿔 돌려준다
		let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
		let sport = server.local_addr().unwrap().port();
		tokio::spawn(async move {
			let (mut s, _) = server.accept().await.unwrap();
			let mut buf = vec![];
			s.read_to_end(&mut buf).await.unwrap();
			s.write_all(&buf.to_ascii_uppercase()).await.unwrap();
		});
		let h2 = host.clone();
		tokio::spawn(async move {
			let conn = h2.accept().await.unwrap().await.unwrap();
			let (send, recv) = conn.accept_bi().await.unwrap();
			pipe(TcpStream::connect(("127.0.0.1", sport)).await.unwrap(), send, recv).await;
			conn.closed().await;
		});
		// 팀원 쪽 출입구 — 받은 TCP 를 덱 주인에게 잇는다
		let gate = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
		let gport = gate.local_addr().unwrap().port();
		let addr = host.addr();
		tokio::spawn(async move {
			let (tcp, _) = gate.accept().await.unwrap();
			let c = member.connect(addr, ALPN).await.unwrap();
			let (send, recv) = c.open_bi().await.unwrap();
			pipe(tcp, send, recv).await;
			c.closed().await;
		});
		let mut c = TcpStream::connect(("127.0.0.1", gport)).await.unwrap();
		c.write_all(b"hello deck").await.unwrap();
		c.shutdown().await.unwrap();
		let mut got = vec![];
		tokio::time::timeout(Duration::from_secs(20), c.read_to_end(&mut got)).await.unwrap().unwrap();
		assert_eq!(got, b"HELLO DECK");
	}
}
