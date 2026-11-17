// 이 PC 에 깔린 글꼴 이름 — PPTX 내보내기가 굵기마다 글꼴 이름을 고르고(「Pretendard SemiBold」),
// 깔리지 않은 글꼴을 비교 검사에 알리는 데 쓴다. PowerPoint 는 깔린 글꼴로만 그린다 — 웹은 덱에 넣은 글꼴 파일로 그리므로
// 깔리지 않았으면 PPT 에서 다른 글꼴로 보인다.
//
// 레지스트리의 글꼴 목록(시스템 · 사용자)에서 이름을 읽는다. 값 이름은 「Pretendard SemiBold (TrueType)」 꼴이고,
// 한 파일에 여럿이면 「A & B (TrueType)」 꼴이다.

use crate::{Res, err, hidden};

#[tauri::command]
pub async fn fonts_list() -> Res<Vec<String>> {
	tokio::task::spawn_blocking(|| {
		let mut out: Vec<String> = vec![];
		for key in [r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts", r"HKCU\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"] {
			let mut c = std::process::Command::new("reg");
			hidden(&mut c);
			let Ok(o) = c.args(["query", key]).output() else { continue };
			// reg 는 콘솔 코드 페이지(한국어 Windows 는 CP949)로 쓴다 — 글꼴 이름이 한글이면 UTF-8 로 읽히지 않는다
			let text = decode(&o.stdout);
			for line in text.lines() {
				let line = line.trim();
				let Some(at) = line.find("    REG_") else { continue };
				let name = line[..at].trim();
				let name = name.rsplit_once(" (").map(|(n, _)| n).unwrap_or(name);
				for part in name.split(" & ") {
					let p = part.trim().to_string();
					if !p.is_empty() && !out.contains(&p) {
						out.push(p);
					}
				}
			}
		}
		out.sort();
		Ok(out)
	})
	.await
	.map_err(err)?
}

/// UTF-8 이 아니면 CP949 로 본다. 한글 글꼴 이름(「맑은 고딕」)이 깨지지 않게.
pub fn decode(b: &[u8]) -> String {
	if let Ok(s) = std::str::from_utf8(b) {
		return s.to_string();
	}
	#[cfg(windows)]
	{
		use std::os::windows::ffi::OsStringExt;
		unsafe extern "system" {
			fn MultiByteToWideChar(cp: u32, flags: u32, src: *const u8, n: i32, dst: *mut u16, m: i32) -> i32;
		}
		// CP_OEMCP(1) — reg 가 쓰는 콘솔 코드 페이지
		let n = unsafe { MultiByteToWideChar(1, 0, b.as_ptr(), b.len() as i32, std::ptr::null_mut(), 0) };
		if n > 0 {
			let mut w = vec![0u16; n as usize];
			unsafe { MultiByteToWideChar(1, 0, b.as_ptr(), b.len() as i32, w.as_mut_ptr(), n) };
			return std::ffi::OsString::from_wide(&w).to_string_lossy().into_owned();
		}
	}
	String::from_utf8_lossy(b).into_owned()
}
