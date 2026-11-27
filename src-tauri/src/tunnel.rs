// 바깥 길 — 협업 서버를 사무실 밖에서도 같은 링크로 열게 한다. 깔린 도구를 찾아 쓴다 (없으면 사무실 망 안에서만).
//
//   Tailscale Funnel   tailscale funnel --bg --https=443 http://127.0.0.1:<포트>  → https://<기기>.<tailnet>.ts.net
//                      tailnet 관리자가 Funnel 을 허락해 두어야 한다. 끌 때 --https=443 off (사용자의 다른 Funnel 설정은 건드리지 않는다)
//   Cloudflare         cloudflared tunnel --url http://127.0.0.1:<포트>  → https://<무작위>.trycloudflare.com (켤 때마다 주소가 바뀐다)
//                      계정 없이 된다. 앱이 띄운 프로세스라 앱의 job 에 넣어 앱과 함께 꺼진다
// 터널로 온 요청은 127.0.0.1 에서 온 것으로 보인다 — 서버는 IP 로 믿지 않고 기기 쿠키만 본다 (collab.rs)
//
// 2026.11.27 : 둘 다 깔려 있지 않으면 cloudflared 를 처음 켤 때 한 번 앱이 받아 둔다 (데이터 폴더 bin/).
//              설치본에 넣지 않은 까닭은 크기다. cloudflared 가 약 55MB 라 설치본 · 자동 업데이트가 몇 배로 커진다. 대부분은 이 길을 쓰지 않는다.
//              순수 Rust 구현(cloudflare-quick-tunnel 크레이트)도 있으나 Cloudflare 가 공개하지 않은 프로토콜을 한 사람이 따라 만든 것이라
//              Cloudflare 가 바꾸면 조용히 끊긴다. 공식 실행 파일을 판 · SHA-256 으로 박아 받는 쪽이 고장 날 곳이 적다.

use crate::{Res, err};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// 앱이 받는 cloudflared 판. 판을 올릴 때 GitHub 릴리즈 자산의 digest(sha256)도 함께 바꾼다.
/// cloudflared 는 나온 지 1년 넘은 판을 지원하지 않는다 (2026.11.27 : 2026.11.2 · windows-amd64 · 55,470,800 바이트)
const CF_VERSION: &str = "2026.11.2";
const CF_SHA256: &str = "555b46c85582461d189cac30d14ad05480d612613801be9f110b8ce08c5b2113";

#[derive(Serialize, Clone)]
pub struct Tools {
	pub tailscale: Option<String>,
	pub cloudflared: Option<String>,
	/// 깔린 것이 없어도 앱이 cloudflared 를 받아 쓸 수 있나 — 받을 판이 있는 Windows x64 만
	pub fetch: bool,
}

/// 앱이 받아 둔 cloudflared 자리. 이름에 판을 넣어, 판을 올리면 새로 받는다
pub fn own_cloudflared() -> PathBuf {
	crate::control::data_dir().join("bin").join(format!("cloudflared-{CF_VERSION}.exe"))
}

/// 깔린 cloudflared 가 없을 때 받아 둔다. on 은 받은 비율(0~100)
async fn fetch_cloudflared(on: &(dyn Fn(u8) + Send + Sync)) -> Res<PathBuf> {
	let dest = own_cloudflared();
	let url = format!("https://github.com/cloudflare/cloudflared/releases/download/{CF_VERSION}/cloudflared-windows-amd64.exe");
	fetch(&url, CF_SHA256, &dest, on).await.map_err(|e| format!("cloudflared 를 받지 못했다: {e}"))?;
	// 지난 판은 지운다. 판을 올릴 때마다 55MB 씩 쌓이지 않게
	if let Ok(rd) = std::fs::read_dir(dest.parent().unwrap()) {
		for e in rd.flatten() {
			let n = e.file_name().to_string_lossy().to_string();
			if n.starts_with("cloudflared-") && e.path() != dest {
				let _ = std::fs::remove_file(e.path());
			}
		}
	}
	Ok(dest)
}

/// url 의 파일을 dest 로 받는다. 다 받은 뒤 SHA-256 이 맞을 때만 제자리에 둔다. 중간에 끊기거나 다른 파일이면 받던 것을 지운다.
/// 안 지우면 반쯤 받은 실행 파일이 다음 번에 「깔려 있는 것」으로 잡혀 띄우다 실패한다
async fn fetch(url: &str, sha256: &str, dest: &Path, on: &(dyn Fn(u8) + Send + Sync)) -> Res<()> {
	let dir = dest.parent().ok_or("받을 자리가 없다")?;
	tokio::fs::create_dir_all(dir).await.map_err(err)?;
	let part = dest.with_extension("part");
	let r = async {
		let client = reqwest::Client::builder().user_agent("ClaudePPT").connect_timeout(Duration::from_secs(20)).build().map_err(err)?;
		let mut res = client.get(url).send().await.map_err(err)?;
		if !res.status().is_success() {
			return Err(format!("서버가 {} 로 답했다", res.status()));
		}
		let total = res.content_length().unwrap_or(0);
		let mut f = tokio::fs::File::create(&part).await.map_err(err)?;
		let mut h = Sha256::new();
		let (mut got, mut last) = (0u64, u8::MAX);
		// 덩이마다 60초. 망이 끊겨도 영영 기다리지 않게 (전체 시간은 망 빠르기에 따라 달라 묶지 않는다)
		while let Some(c) = tokio::time::timeout(Duration::from_secs(60), res.chunk()).await.map_err(|_| "60초 동안 한 바이트도 오지 않았다".to_string())?.map_err(err)? {
			h.update(&c);
			f.write_all(&c).await.map_err(err)?;
			got += c.len() as u64;
			if total > 0 {
				let p = (got * 100 / total).min(100) as u8;
				if p != last {
					last = p;
					on(p);
				}
			}
		}
		f.flush().await.map_err(err)?;
		drop(f);
		let hex: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
		if hex != sha256 {
			return Err("받은 파일이 알려진 판과 다르다 (SHA-256 불일치)".into());
		}
		tokio::fs::rename(&part, dest).await.map_err(err)
	}
	.await;
	if r.is_err() {
		let _ = tokio::fs::remove_file(&part).await;
	}
	r
}

/// 실행 파일 찾기 — PATH 다음에 깐 방법마다 놓이는 자리
fn find(exe: &str, places: &[PathBuf]) -> Option<PathBuf> {
	let mut c = std::process::Command::new("where");
	crate::hidden(&mut c);
	if let Ok(o) = c.arg(exe).output() {
		if let Some(l) = String::from_utf8_lossy(&o.stdout).lines().map(str::trim).find(|l| l.to_ascii_lowercase().ends_with(".exe")) {
			return Some(PathBuf::from(l));
		}
	}
	places.iter().find(|p| p.is_file()).cloned()
}

fn env(k: &str) -> PathBuf {
	std::env::var_os(k).map(PathBuf::from).unwrap_or_default()
}

pub fn detect() -> Tools {
	let ts = find("tailscale.exe", &[env("ProgramFiles").join("Tailscale").join("tailscale.exe")]);
	let cf = find(
		"cloudflared.exe",
		&[
			env("ProgramFiles(x86)").join("cloudflared").join("cloudflared.exe"),
			env("ProgramFiles").join("cloudflared").join("cloudflared.exe"),
			env("LOCALAPPDATA").join("Microsoft").join("WinGet").join("Links").join("cloudflared.exe"),
			env("USERPROFILE").join("scoop").join("shims").join("cloudflared.exe"),
			own_cloudflared(),
		],
	);
	Tools {
		tailscale: ts.map(|p| p.to_string_lossy().into()),
		cloudflared: cf.map(|p| p.to_string_lossy().into()),
		fetch: cfg!(all(windows, target_arch = "x86_64")),
	}
}

/// cloudflared 가 찍는 줄에서 quick tunnel 주소를 찾는다
pub fn trycloudflare_url(line: &str) -> Option<String> {
	let i = line.find("https://")?;
	let url: String = line[i..].chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '/' | '.' | '-')).collect();
	let host = url.trim_start_matches("https://");
	(host.ends_with(".trycloudflare.com") && host.len() > ".trycloudflare.com".len() && !host.starts_with("api.")).then_some(url)
}

/// tailscale status --json 의 Self.DNSName → https 주소
pub fn tailscale_url(status_json: &str) -> Option<String> {
	let v: serde_json::Value = serde_json::from_str(status_json).ok()?;
	let dns = v["Self"]["DNSName"].as_str()?.trim_end_matches('.');
	(!dns.is_empty()).then(|| format!("https://{dns}"))
}

/// 열린 바깥 길
pub enum Open {
	Tailscale { exe: PathBuf },
	Cloudflare { child: tokio::process::Child },
}

pub struct Tunnel {
	pub url: String,
	pub kind: &'static str,
	pub open: Open,
}

/// 바깥 길을 연다 — Tailscale 이 있으면 먼저(주소가 바뀌지 않는다), 없으면 cloudflared. 그것도 없으면 받아서(on: 받은 비율) 쓴다
pub async fn start(port: u16, on: &(dyn Fn(u8) + Send + Sync)) -> Res<Tunnel> {
	let t = detect();
	if let Some(exe) = t.tailscale.map(PathBuf::from) {
		match tailscale_on(&exe, port).await {
			Ok(url) => return Ok(Tunnel { url, kind: "tailscale", open: Open::Tailscale { exe } }),
			Err(e) if t.cloudflared.is_none() && !t.fetch => return Err(format!("Tailscale Funnel 을 열지 못했다: {e}")),
			Err(_) => {}
		}
	}
	let exe = match t.cloudflared.map(PathBuf::from) {
		Some(p) => p,
		None if t.fetch => fetch_cloudflared(on).await?,
		None => return Err("Tailscale 도 cloudflared 도 깔려 있지 않다".into()),
	};
	cloudflare_on(&exe, port).await
}

async fn run(exe: &Path, args: &[&str]) -> Res<String> {
	let mut c = tokio::process::Command::new(exe);
	c.args(args).stdin(Stdio::null());
	#[cfg(windows)]
	c.creation_flags(0x0800_0000);
	let o = tokio::time::timeout(std::time::Duration::from_secs(30), c.output()).await.map_err(|_| "30초 안에 끝나지 않았다".to_string())?.map_err(err)?;
	if !o.status.success() {
		return Err(String::from_utf8_lossy(&o.stderr).trim().to_string());
	}
	Ok(String::from_utf8_lossy(&o.stdout).to_string())
}

async fn tailscale_on(exe: &Path, port: u16) -> Res<String> {
	run(exe, &["funnel", "--bg", "--https=443", &format!("http://127.0.0.1:{port}")]).await?;
	let status = run(exe, &["status", "--json"]).await?;
	tailscale_url(&status).ok_or("tailscale 주소를 읽지 못했다".into())
}

async fn cloudflare_on(exe: &Path, port: u16) -> Res<Tunnel> {
	let mut c = tokio::process::Command::new(exe);
	c.args(["tunnel", "--no-autoupdate", "--url", &format!("http://127.0.0.1:{port}")]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
	#[cfg(windows)]
	c.creation_flags(0x0800_0000);
	let mut child = c.spawn().map_err(|e| format!("cloudflared 를 띄우지 못했다: {e}"))?;
	crate::claude::adopt(&child);
	let mut lines = BufReader::new(child.stderr.take().unwrap()).lines();
	// 주소는 stderr 로 나온다. 30초 안에 안 나오면 접는다
	let found = tokio::time::timeout(std::time::Duration::from_secs(30), async {
		while let Ok(Some(l)) = lines.next_line().await {
			if let Some(u) = trycloudflare_url(&l) {
				return Some(u);
			}
		}
		None
	})
	.await
	.ok()
	.flatten();
	let Some(url) = found else {
		let _ = child.kill().await;
		return Err("cloudflared 가 주소를 내주지 않았다".into());
	};
	// 남은 출력은 버린다 — 읽지 않으면 파이프가 차서 cloudflared 가 멈춘다
	tauri::async_runtime::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
	Ok(Tunnel { url, kind: "cloudflare", open: Open::Cloudflare { child } })
}

/// 바깥 길을 닫는다
pub async fn stop(t: Tunnel) {
	match t.open {
		Open::Tailscale { exe } => {
			let _ = run(&exe, &["funnel", "--https=443", "off"]).await;
		}
		Open::Cloudflare { mut child } => {
			let _ = child.kill().await;
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn reads_quick_tunnel_address() {
		let l = "2026-11-25T11:00:00Z INF |  https://plain-dog-river-abc.trycloudflare.com                                  |";
		assert_eq!(trycloudflare_url(l).as_deref(), Some("https://plain-dog-river-abc.trycloudflare.com"));
		assert_eq!(trycloudflare_url("INF Requesting new quick Tunnel on trycloudflare.com..."), None);
		assert_eq!(trycloudflare_url("see https://api.trycloudflare.com/tunnel"), None);
		assert_eq!(trycloudflare_url("https://example.com"), None);
	}

	/// 가짜 cloudflared(.cmd) — 주소를 stderr 로 찍고 기다린다. 띄우기 · 주소 읽기 · 끄기 길을 깔린 도구 없이 본다
	#[cfg(windows)]
	#[tokio::test]
	async fn starts_reads_and_stops_a_quick_tunnel() {
		let d = std::env::temp_dir().join(format!("cppt-tunnel-{}", std::process::id()));
		std::fs::create_dir_all(&d).unwrap();
		let exe = d.join("fake-cloudflared.cmd");
		std::fs::write(&exe, "@echo off
echo INF Requesting new quick Tunnel on trycloudflare.com... 1>&2
echo INF ^|  https://quiet-fox-123.trycloudflare.com  ^| 1>&2
ping -n 20 127.0.0.1 > nul
").unwrap();
		let t = cloudflare_on(&exe, 47999).await.expect("주소를 읽어야 한다");
		assert_eq!(t.url, "https://quiet-fox-123.trycloudflare.com");
		assert_eq!(t.kind, "cloudflare");
		let Open::Cloudflare { ref child } = t.open else { panic!() };
		let pid = child.id().unwrap();
		stop(t).await;
		let alive = std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
		assert!(!String::from_utf8_lossy(&alive.stdout).contains(&pid.to_string()), "끈 뒤에도 남았다");
		let _ = std::fs::remove_dir_all(d);
	}

	/// 이 PC 안 HTTP 서버 하나가 body 를 한 번 내준다. 받기 · 비율 · 해시 확인 길을 망 없이 본다
	async fn serve_once(body: &'static [u8]) -> String {
		use tokio::io::AsyncReadExt;
		let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
		let port = l.local_addr().unwrap().port();
		tokio::spawn(async move {
			let (mut s, _) = l.accept().await.unwrap();
			let mut b = [0u8; 2048];
			let _ = s.read(&mut b).await;
			let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
			let _ = s.write_all(head.as_bytes()).await;
			let _ = s.write_all(body).await;
		});
		format!("http://127.0.0.1:{port}/cloudflared.exe")
	}

	#[tokio::test]
	async fn fetches_only_a_file_with_the_known_hash() {
		let d = std::env::temp_dir().join(format!("cppt-fetch-{}", std::process::id()));
		let dest = d.join("bin").join("cloudflared-x.exe");
		let body: &'static [u8] = b"pretend this is cloudflared";
		let sha: String = Sha256::digest(body).iter().map(|b| format!("{b:02x}")).collect();

		// 해시가 맞으면 제자리에 두고, 비율은 100 으로 끝난다
		let seen = std::sync::Mutex::new(Vec::new());
		fetch(&serve_once(body).await, &sha, &dest, &|p| seen.lock().unwrap().push(p)).await.expect("받아야 한다");
		assert_eq!(std::fs::read(&dest).unwrap(), body);
		assert_eq!(seen.lock().unwrap().last(), Some(&100));
		std::fs::remove_file(&dest).unwrap();

		// 해시가 다르면 받은 것을 남기지 않는다 (제자리에도 · 받던 파일도)
		let wrong = "0".repeat(64);
		assert!(fetch(&serve_once(body).await, &wrong, &dest, &|_| {}).await.is_err());
		assert!(!dest.exists());
		assert!(!dest.with_extension("part").exists());
		let _ = std::fs::remove_dir_all(d);
	}

	#[test]
	fn reads_tailscale_name() {
		let j = r#"{"Self":{"DNSName":"host-pc.tail1234.ts.net.","HostName":"host-pc"}}"#;
		assert_eq!(tailscale_url(j).as_deref(), Some("https://host-pc.tail1234.ts.net"));
		assert_eq!(tailscale_url(r#"{"Self":{"DNSName":""}}"#), None);
		assert_eq!(tailscale_url("not json"), None);
	}
}
