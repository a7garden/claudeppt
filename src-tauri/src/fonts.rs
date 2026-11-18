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

/// 글꼴의 다른 나라 이름 → 영어 이름. PowerPoint 는 한글 이름(「에스코어 드림 5 Medium」)으로 저장하는데,
/// 웹뷰(Chromium)는 글꼴 파일의 영어 이름(「S-Core Dream 5 Medium」)만 알아본다. 맑은 고딕처럼 둘 다 되는 글꼴도 있지만
/// 그렇지 않은 글꼴이 많아, 가져온 쪽이 통째로 기본 글꼴로 바뀌어 보였다 (2026.11.18 에스코어 드림으로 확인).
/// 글꼴 파일의 name 표(이름 1 · 4)를 읽어 영어 이름과 다른 이름만 담는다.
#[tauri::command]
pub async fn font_aliases() -> Res<std::collections::HashMap<String, String>> {
	tokio::task::spawn_blocking(|| {
		let mut out = std::collections::HashMap::new();
		let mut dirs = vec![std::path::PathBuf::from(std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into())).join("Fonts")];
		if let Ok(l) = std::env::var("LOCALAPPDATA") {
			dirs.push(std::path::PathBuf::from(l).join(r"Microsoft\Windows\Fonts"));
		}
		for d in dirs {
			let Ok(rd) = std::fs::read_dir(d) else { continue };
			for e in rd.flatten() {
				let p = e.path();
				let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
				if !matches!(ext.as_str(), "ttf" | "otf" | "ttc") {
					continue;
				}
				// 글꼴 파일 하나가 깨져 있어도 나머지는 읽는다
				let _ = names_of(&p, &mut out);
			}
		}
		Ok(out)
	})
	.await
	.map_err(err)?
}

/// 글꼴 파일(묶음 ttc 포함)의 각 글꼴에서 이름을 읽어 out 에 「다른 이름 → 영어 이름」 으로 담는다.
/// 이름 표만 필요하므로 파일 전체를 읽지 않고 머리와 name 표만 읽는다 (CJK 글꼴은 수십 MB 다).
fn names_of(p: &std::path::Path, out: &mut std::collections::HashMap<String, String>) -> std::io::Result<()> {
	use std::io::{Read, Seek, SeekFrom};
	let mut f = std::fs::File::open(p)?;
	let mut at = |off: u64, n: usize| -> std::io::Result<Vec<u8>> {
		let mut b = vec![0u8; n];
		f.seek(SeekFrom::Start(off))?;
		f.read_exact(&mut b)?;
		Ok(b)
	};
	let be16 = |b: &[u8], i: usize| u16::from_be_bytes([b[i], b[i + 1]]) as usize;
	let be32 = |b: &[u8], i: usize| u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) as u64;
	let head = at(0, 12)?;
	let faces: Vec<u64> = if &head[0..4] == b"ttcf" {
		let n = be32(&head, 8).min(64) as usize;
		let offs = at(12, n * 4)?;
		(0..n).map(|i| be32(&offs, i * 4)).collect()
	} else {
		vec![0]
	};
	for base in faces {
		let h = at(base, 12)?;
		let n = be16(&h, 4);
		let recs = at(base + 12, n * 16)?;
		let Some(i) = (0..n).find(|i| &recs[i * 16..i * 16 + 4] == b"name") else { continue };
		let (off, len) = (be32(&recs, i * 16 + 8), be32(&recs, i * 16 + 12) as usize);
		let t = at(off, len.min(1 << 20))?;
		let (count, store) = (be16(&t, 2), be16(&t, 4));
		let mut english: Option<String> = None;
		let mut others: Vec<String> = vec![];
		for r in 0..count {
			let o = 6 + r * 12;
			if o + 12 > t.len() {
				break;
			}
			// Windows 이름(플랫폼 3)만 본다 — UTF-16BE 이고, 웹뷰도 이 이름으로 찾는다
			let (plat, lang, id, l, so) = (be16(&t, o), be16(&t, o + 4), be16(&t, o + 6), be16(&t, o + 8), be16(&t, o + 10));
			if plat != 3 || !(id == 1 || id == 4) || store + so + l > t.len() {
				continue;
			}
			let u: Vec<u16> = t[store + so..store + so + l].chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
			let s = String::from_utf16_lossy(&u).trim().to_string();
			if s.is_empty() {
				continue;
			}
			if id == 1 && lang == 0x409 {
				english = Some(s);
			} else if lang != 0x409 {
				others.push(s);
			}
		}
		if let Some(en) = english {
			for o in others {
				if o != en {
					out.entry(o).or_insert_with(|| en.clone());
				}
			}
		}
	}
	Ok(())
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

#[cfg(test)]
mod tests {
	// 한국어 Windows 라면 맑은 고딕은 늘 깔려 있다 — 한글 이름이 영어 이름으로 이어지는지 본다
	#[test]
	fn korean_name_maps_to_english() {
		let m = tauri::async_runtime::block_on(super::font_aliases()).unwrap();
		assert_eq!(m.get("맑은 고딕").map(String::as_str), Some("Malgun Gothic"));
		for k in ["에스코어 드림 5 Medium", "에스코어 드림 6 Bold"] {
			if let Some(v) = m.get(k) {
				println!("{k} → {v}");
			}
		}
		println!("이름 {} 개", m.len());
	}
}
