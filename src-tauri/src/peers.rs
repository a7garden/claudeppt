// 앱끼리 바로 주고받기 (2026.11.27) : 분산 협업 3단계 (design/분산 협업).
// 켜져 있는 명부 사람에게 iroh 로 묻고, 그 사람이 가진 것 중 내가 없는 것만 묶음으로 받는다. 서로 묻기만 한다(남의 사본에 밀어 넣지 않는다).
//
//   잇기     공유(collab)와 같은 끝점 · 같은 열쇠. 길(ALPN)만 claudeppt/sync/1 로 따로다 : p2p.rs serve 가 길을 보고 여기로 넘긴다
//   묻기     {deck, haves} JSON 하나 → 답 첫 바이트 0(줄 것 없음) · 1(묶음이 뒤따른다) · 2(거절, 까닭이 뒤따른다)
//   가리기   상대 열쇠는 iroh 가 TLS 로 확인한 것(remote_id)이다. 그 열쇠가 그 덱 명부에서 사본을 받는 사람일 때만 준다
//   들이기   받은 묶음은 파일로 받은 것과 같은 sync::import 를 지난다 : 통로가 늘어도 검증은 하나다
//   찾기     명부의 열쇠가 곧 iroh 주소다. iroh 가 열쇠로 주소를 찾아(주소록) 바로 잇고, 안 되면 중계를 거친다
//
// 참여 요청은 이 길로 가지 않는다 : 명부에 없는 사람에게는 주지도 묻지도 않는다. 처음 받는 사람은 묶음 파일 · 우편함으로 들어온다

use crate::{Res, err, sync};
use iroh::Endpoint;
use iroh::endpoint::Connection;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;

pub const ALPN: &[u8] = b"claudeppt/sync/1";
/// 한 사람에게 닿아 묶음을 다 받기까지 기다리는 가장 긴 시간 : 처음 찾기 · 구멍 뚫기 · 큰 덱의 첫 묶음을 합쳐
const PULL: Duration = Duration::from_secs(600);
const DIAL: Duration = Duration::from_secs(20);
/// 묶음 하나의 상한 : 가져온 PPTX 덱의 전 이력이 수백 MB 다
const MAX: u64 = 4 << 30;

#[derive(Serialize, Deserialize)]
struct Ask {
	deck: String,
	haves: Vec<String>,
}

fn temp(name: &str) -> PathBuf {
	crate::control::data_dir().join("sync-tmp").join(format!("{name}-{}.cpptb", uuid::Uuid::new_v4().simple()))
}

// ── 주는 쪽 ──

/// 들어온 연결 하나 : 흐름마다 묻기 하나
pub async fn serve(conn: Connection) {
	let who = conn.remote_id().to_z32();
	while let Ok((mut send, mut recv)) = conn.accept_bi().await {
		let who = who.clone();
		tauri::async_runtime::spawn(async move {
			let Ok(raw) = recv.read_to_end(1 << 20).await else { return };
			let Ok(ask) = serde_json::from_slice::<Ask>(&raw) else { return };
			let out = temp("serve");
			let made = {
				let out = out.clone();
				tauri::async_runtime::spawn_blocking(move || {
					let d = sync::deck_dir(&ask.deck).ok_or("이 PC 에 없는 덱")?;
					sync::serve_bundle(&d, &who, &ask.haves, &out)
				})
				.await
				.map_err(err)
				.and_then(|r| r)
			};
			match made {
				Ok(true) => {
					let _ = send.write_all(b"1").await;
					if let Ok(mut f) = tokio::fs::File::open(&out).await {
						let _ = tokio::io::copy(&mut f, &mut send).await;
					}
				}
				Ok(false) => {
					let _ = send.write_all(b"0").await;
				}
				Err(why) => {
					let _ = send.write_all(format!("2{why}").as_bytes()).await;
				}
			}
			let _ = send.finish();
			let _ = send.stopped().await;
			let _ = tokio::fs::remove_file(&out).await;
		});
	}
}

// ── 묻는 쪽 ──

/// 한 사람에게 묻고 받은 것을 들인다. 줄 것이 없었으면 None
async fn pull(ep: &Endpoint, d: &Path, deck: &str, to: impl Into<iroh::EndpointAddr>) -> Res<Option<sync::Imported>> {
	let conn = tokio::time::timeout(DIAL, ep.connect(to, ALPN)).await.map_err(|_| "닿지 못했다 (꺼져 있다)".to_string())?.map_err(|e| format!("닿지 못했다: {e}"))?;
	let (mut send, mut recv) = conn.open_bi().await.map_err(err)?;
	let dd = d.to_path_buf();
	let haves = tauri::async_runtime::spawn_blocking(move || sync::haves(&dd)).await.map_err(err)?;
	send.write_all(&serde_json::to_vec(&Ask { deck: deck.into(), haves }).map_err(err)?).await.map_err(err)?;
	send.finish().map_err(err)?;
	let mut head = [0u8; 1];
	recv.read_exact(&mut head).await.map_err(|e| format!("답을 읽지 못했다: {e}"))?;
	match head[0] {
		b'0' => return Ok(None),
		b'2' => {
			let why = recv.read_to_end(4096).await.unwrap_or_default();
			return Err(format!("거절했다: {}", String::from_utf8_lossy(&why)));
		}
		b'1' => {}
		_ => return Err("모르는 답".into()),
	}
	let file = temp("pull");
	tokio::fs::create_dir_all(file.parent().unwrap()).await.map_err(err)?;
	let r = async {
		let mut f = tokio::fs::File::create(&file).await.map_err(err)?;
		let mut limited = tokio::io::AsyncReadExt::take(&mut recv, MAX + 1);
		let n = tokio::io::copy(&mut limited, &mut f).await.map_err(err)?;
		if n > MAX {
			return Err("묶음이 너무 크다".to_string());
		}
		f.flush().await.map_err(err)?;
		drop(f);
		let (dd, ff) = (d.to_path_buf(), file.clone());
		tauri::async_runtime::spawn_blocking(move || sync::import(&dd, &ff)).await.map_err(err)?
	}
	.await;
	let _ = tokio::fs::remove_file(&file).await;
	conn.close(0u32.into(), b"done");
	r.map(Some)
}

#[derive(Serialize, Default)]
pub struct PeerRan {
	/// 물어본 사람 수 · 닿은 사람 수 · 묶음을 받은 사람 수
	asked: usize,
	reached: usize,
	received: usize,
	conflicts: Vec<String>,
	/// 닿았는데 어긋난 것 (닿지 못한 것은 넣지 않는다 : 꺼져 있는 것은 흔한 일이다)
	errors: Vec<String>,
}

/// 명부의 켜져 있는 사람들에게 묻는다. 명부에 나 말고 아무도 없으면 앱끼리 잇는 길을 열지도 않는다
#[tauri::command]
pub async fn sync_peers_run(app: AppHandle, dir: String) -> Res<PeerRan> {
	let d = PathBuf::from(&dir);
	let dd = d.clone();
	let (deck, peers) = tauri::async_runtime::spawn_blocking(move || (sync::register(&dd), sync::peers_of(&dd))).await.map_err(err)?;
	let mut ran = PeerRan::default();
	let Some(deck) = deck else { return Ok(ran) };
	if peers.is_empty() {
		return Ok(ran);
	}
	let ep = crate::p2p::endpoint(&app).await?;
	// 한 사람씩 : 같은 덱 폴더에 묶음을 둘 이상 동시에 들이지 않게 (들이는 동안 잠그지만 받기까지는 차례로 하는 편이 간단하다)
	for p in peers {
		ran.asked += 1;
		let Ok(id) = iroh::EndpointId::from_z32(&p) else { continue };
		match tokio::time::timeout(PULL, pull(&ep, &d, &deck, id)).await {
			Ok(Ok(got)) => {
				ran.reached += 1;
				if let Some(g) = got {
					ran.received += 1;
					ran.conflicts.extend(g.conflicts);
				}
			}
			Ok(Err(e)) if e.starts_with("닿지 못했다") => {}
			Ok(Err(e)) => {
				ran.reached += 1;
				ran.errors.push(format!("{}: {e}", crate::trust::short(&p)));
			}
			Err(_) => ran.errors.push(format!("{}: 시간 초과", crate::trust::short(&p))),
		}
	}
	Ok(ran)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::trust::{Role, TEST_KEY};
	use iroh::endpoint::presets;
	use iroh::SecretKey;

	fn tmp(name: &str) -> PathBuf {
		let d = std::env::temp_dir().join(format!("cppt-peers-{name}-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&d);
		d
	}
	fn s(p: &Path) -> String {
		p.to_string_lossy().into()
	}
	fn put(d: &Path, rel: &str, text: &str) {
		let p = d.join(rel);
		std::fs::create_dir_all(p.parent().unwrap()).unwrap();
		std::fs::write(p, text).unwrap();
		crate::vcs::vcs_commit(s(d), format!("{rel}"), None).unwrap();
	}
	async fn ep(k: Option<u8>) -> Endpoint {
		let mut b = Endpoint::builder(presets::Minimal).relay_mode(iroh::RelayMode::Disabled).alpns(vec![ALPN.to_vec()]);
		if let Some(k) = k {
			b = b.secret_key(SecretKey::from_bytes(&[k; 32]));
		}
		b.bind().await.unwrap()
	}

	/// 가(1)의 덱을 나(2)가 iroh 로 묻고 받는다 · 명부에 없는 열쇠는 거절된다
	#[tokio::test]
	async fn members_pull_and_strangers_are_refused() {
		let (a, b, f) = (tmp("a"), tmp("b"), tmp("f").join("first.cpptb"));
		std::fs::create_dir_all(&a).unwrap();
		TEST_KEY.with(|k| k.replace(SecretKey::from_bytes(&[1; 32])));
		put(&a, "deck.json", "{}");
		put(&a, "slides/s1.html", "1");
		crate::sync::sync_export(s(&a), s(&f), true).unwrap();
		let key2 = crate::trust::key_id(&SecretKey::from_bytes(&[2; 32]));
		crate::trust::change(&a, &SecretKey::from_bytes(&[1; 32]), |r| {
			r.people.push(crate::trust::Person { id: "b".into(), name: "나".into(), keys: vec![key2.clone()], role: Role::Edit, slides: vec![], replica: true });
			Ok(())
		})
		.unwrap();
		let deck = sync::register(&a).unwrap();
		put(&a, "slides/s1.html", "2");
		TEST_KEY.with(|k| k.replace(SecretKey::from_bytes(&[2; 32])));
		crate::sync::sync_open(s(&f), s(&b)).unwrap();

		let host = ep(None).await;
		let h2 = host.clone();
		tokio::spawn(async move {
			while let Some(i) = h2.accept().await {
				if let Ok(c) = i.await {
					tokio::spawn(serve(c));
				}
			}
		});
		let me = ep(Some(2)).await;
		let got = pull(&me, &b, &deck, host.addr()).await.unwrap().expect("받을 것이 있다");
		assert!(got.adopted, "명부가 바뀐 사슬을 받았다");
		assert_eq!(std::fs::read_to_string(b.join("slides/s1.html")).unwrap(), "2");
		// 다시 물으면 줄 것이 없다
		assert!(pull(&me, &b, &deck, host.addr()).await.unwrap().is_none());
		// 가 쪽에서는 이제 「이 PC 에만 있음」이 아니다 : 나가 받아 갔다
		TEST_KEY.with(|k| k.replace(SecretKey::from_bytes(&[1; 32])));
		assert!(!crate::sync::sync_status(s(&a)).unwrap().unwrap().unsent);
		TEST_KEY.with(|k| k.replace(SecretKey::from_bytes(&[2; 32])));
		// 명부에 없는 열쇠
		let stranger = ep(Some(9)).await;
		let e = pull(&stranger, &b, &deck, host.addr()).await.unwrap_err();
		assert!(e.contains("거절"), "{e}");
		TEST_KEY.with(|k| k.replace(SecretKey::from_bytes(&[7; 32])));
		for p in [&a, &b, &f.parent().unwrap().to_path_buf()] {
			let _ = std::fs::remove_dir_all(p);
		}
	}
}
