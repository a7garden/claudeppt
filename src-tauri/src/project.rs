// 앱 설정 · 프로젝트 열고 닫기 · 저장 폴더(덱 폴더 모음) · 한 파일 묶음(.cppt) 내보내기와 풀기.
//
// 프로젝트 = deck.json 이 있는 폴더 하나. 파일 꼴은 화면 쪽 src/lib/deck.ts 머리말에 적었다.
// .cppt 는 그 폴더를 zip 으로 묶은 것 — 주고받거나 보관할 때 쓴다. 판 이력(.git)까지 함께 담긴다.

use crate::{AppState, Res, err, watch};
use serde::Serialize;
use serde_json::Value;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

#[derive(Serialize)]
pub struct Paths {
	data: String,
	library: String,
}

fn data_dir(app: &AppHandle) -> Res<PathBuf> {
	let d = app.path().app_data_dir().map_err(err)?;
	std::fs::create_dir_all(&d).map_err(err)?;
	Ok(d)
}

#[tauri::command]
pub fn app_paths(app: AppHandle) -> Res<Paths> {
	let lib = dirs::document_dir().unwrap_or_else(|| dirs::home_dir().unwrap_or_default()).join("ClaudePPT");
	Ok(Paths { data: data_dir(&app)?.to_string_lossy().into(), library: lib.to_string_lossy().into() })
}

/// 설정은 화면 쪽이 모양을 정한다 — 여기서는 JSON 한 덩이로 읽고 쓰기만 한다.
#[tauri::command]
pub fn settings_load(app: AppHandle) -> Res<Value> {
	let p = data_dir(&app)?.join("settings.json");
	Ok(std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null))
}

#[tauri::command]
pub fn settings_save(app: AppHandle, value: Value) -> Res<()> {
	let p = data_dir(&app)?.join("settings.json");
	let tmp = p.with_extension("json.tmp");
	std::fs::write(&tmp, serde_json::to_string_pretty(&value).map_err(err)?).map_err(err)?;
	std::fs::rename(tmp, p).map_err(err)
}

/// 프로젝트를 deck:// 에 올리고 폴더 감시를 건다. 같은 폴더면 같은 id 를 돌려준다.
#[tauri::command]
pub fn project_open(app: AppHandle, state: State<AppState>, dir: String) -> Res<String> {
	let root = PathBuf::from(&dir);
	if !root.join("deck.json").exists() {
		return Err("deck.json 이 없는 폴더다".into());
	}
	let id = {
		let mut map = state.projects.lock().unwrap();
		if let Some((id, _)) = map.iter().find(|(_, p)| **p == root) {
			id.clone()
		} else {
			let id = uuid::Uuid::new_v4().simple().to_string()[..10].to_string();
			map.insert(id.clone(), root.clone());
			id
		}
	};
	let mut ws = state.watchers.lock().unwrap();
	if !ws.contains_key(&id) {
		ws.insert(id.clone(), watch::start(app, id.clone(), root)?);
	}
	Ok(id)
}

#[tauri::command]
pub fn project_close(state: State<AppState>, id: String) -> Res<()> {
	state.watchers.lock().unwrap().remove(&id);
	Ok(())
}

#[derive(Serialize)]
pub struct LibItem {
	dir: String,
	deck: Value,
	modified: i64,
}

/// 저장 폴더 바로 아래에서 deck.json 이 있는 폴더를 찾는다.
#[tauri::command(async)]
pub fn library_list(dir: String) -> Res<Vec<LibItem>> {
	let mut out = vec![];
	let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(out) };
	for e in rd.flatten() {
		let p = e.path();
		let f = p.join("deck.json");
		let Ok(text) = std::fs::read_to_string(&f) else { continue };
		let deck = serde_json::from_str(&text).unwrap_or(Value::Null);
		let modified = std::fs::metadata(&f).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0);
		out.push(LibItem { dir: p.to_string_lossy().into(), deck, modified });
	}
	out.sort_by(|a, b| b.modified.cmp(&a.modified));
	Ok(out)
}

/// 프로젝트 폴더를 .cppt 한 파일로 묶는다. 앱이 쓰는 임시 상태(.claudeppt/run) 는 뺀다.
#[tauri::command(async)]
pub fn pack_deck(dir: String, out: String) -> Res<()> {
	let root = PathBuf::from(&dir);
	let file = std::fs::File::create(&out).map_err(err)?;
	let mut zw = zip::ZipWriter::new(file);
	let opt = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
	let mut stack = vec![root.clone()];
	while let Some(d) = stack.pop() {
		for e in std::fs::read_dir(&d).map_err(err)?.flatten() {
			let p = e.path();
			let rel = p.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
			if rel.starts_with(".claudeppt/run") {
				continue;
			}
			if p.is_dir() {
				zw.add_directory(format!("{rel}/"), opt).map_err(err)?;
				stack.push(p);
			} else {
				zw.start_file(rel, opt).map_err(err)?;
				let mut buf = vec![];
				std::fs::File::open(&p).map_err(err)?.read_to_end(&mut buf).map_err(err)?;
				zw.write_all(&buf).map_err(err)?;
			}
		}
	}
	zw.finish().map_err(err)?;
	Ok(())
}

/// .cppt 를 dest 폴더에 푼다. dest 가 이미 있으면 뒤에 번호를 붙인다. 푼 폴더 경로를 돌려준다.
#[tauri::command(async)]
pub fn unpack_deck(file: String, dest: String) -> Res<String> {
	let mut target = PathBuf::from(&dest);
	let mut n = 2;
	while target.exists() {
		target = PathBuf::from(format!("{dest} {n}"));
		n += 1;
	}
	let mut za = zip::ZipArchive::new(std::fs::File::open(&file).map_err(err)?).map_err(err)?;
	for i in 0..za.len() {
		let mut f = za.by_index(i).map_err(err)?;
		let Some(name) = f.enclosed_name() else { continue };
		let p = target.join(name);
		if f.is_dir() {
			std::fs::create_dir_all(&p).map_err(err)?;
			continue;
		}
		if let Some(d) = p.parent() {
			std::fs::create_dir_all(d).map_err(err)?;
		}
		let mut buf = vec![];
		f.read_to_end(&mut buf).map_err(err)?;
		std::fs::write(&p, buf).map_err(err)?;
	}
	if !target.join("deck.json").exists() {
		return Err("묶음 안에 deck.json 이 없다".into());
	}
	// 풀어 낸 덱은 원본과 다른 덱이다 : 원본의 서명 기록 · 명부를 걷어, 첫 판에서 이 PC 를 승인자로 둔 새 기록을 시작하게 한다.
	// 그대로 두면 같은 덱 id 로 원본 자리를 차지해 팀원에게 이 사본을 내줄 수 있다 (sync.rs register). 팀원과 함께 쓰는 덱은 .cpptb 로 받는다
	if target.join(".git").is_dir() {
		let refs = crate::vcs::run(&target, &["for-each-ref", "--format=%(refname)", "refs/cppt/chain", "refs/cppt/trunk", "refs/cppt/pending", "refs/cppt/props", "refs/cppt/join", "refs/cppt/sent", "refs/cppt/sent-file", "refs/cppt/given", "refs/cppt/peers"]).unwrap_or_default();
		for r in refs.lines().filter(|l| !l.is_empty()) {
			let _ = crate::vcs::run(&target, &["update-ref", "-d", r]);
		}
		for f in ["claudeppt-chain.json", "claudeppt-sent.json", "claudeppt-mailbox-seen.json"] {
			let _ = std::fs::remove_file(target.join(".git").join(f));
		}
	}
	Ok(target.to_string_lossy().into())
}

/// 덱 폴더를 휴지통으로 보낸다 (2026.11.27 홈 「최근 덱」 관리). 바로 지우지 않는 것은 잘못 눌러도 휴지통에서 판 이력째 되살리게.
/// deck.json 이 있는 폴더만 받는다 — 화면이 다른 경로를 넘겨도 아무 폴더나 지우지 못하게
#[tauri::command(async)]
pub fn deck_trash(app: AppHandle, dir: String) -> Res<()> {
	let root = PathBuf::from(&dir);
	if !root.is_dir() || !root.join("deck.json").is_file() {
		return Err("deck.json 이 없는 폴더다".into());
	}
	// 감시를 먼저 끈다 — 감시가 폴더 핸들을 쥐고 있으면 옮기기가 「사용 중」으로 막힌다 (미리보기 카드가 잠깐 연 덱도 id 는 남는다)
	let state = app.state::<AppState>();
	let ids: Vec<String> = state.projects.lock().unwrap().iter().filter(|(_, p)| **p == root).map(|(id, _)| id.clone()).collect();
	{
		let mut ws = state.watchers.lock().unwrap();
		for id in &ids {
			ws.remove(id);
		}
	}
	trash(&root)
}

#[cfg(windows)]
fn trash(root: &Path) -> Res<()> {
	// 경로는 환경 변수로 넘긴다 — 명령 글에 끼워 넣으면 폴더 이름의 따옴표 · $ 가 PowerShell 글로 읽힌다
	let ps = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:CPPT_TRASH, 'OnlyErrorDialogs', 'SendToRecycleBin')";
	let mut c = std::process::Command::new("powershell");
	crate::hidden(&mut c);
	let out = c.args(["-NoProfile", "-NonInteractive", "-Command", ps]).env("CPPT_TRASH", root).output().map_err(|e| format!("PowerShell 을 띄우지 못했다: {e}"))?;
	if out.status.success() && !root.exists() {
		return Ok(());
	}
	Err(crate::fonts::decode(&out.stderr).lines().find(|l| !l.trim().is_empty()).unwrap_or("휴지통으로 옮기지 못했다").to_string())
}

#[cfg(not(windows))]
fn trash(_root: &Path) -> Res<()> {
	Err("휴지통 보내기는 Windows 에서만 된다".into())
}

/// 탐색기에서 폴더를 연다.
#[tauri::command]
pub fn reveal(path: String) -> Res<()> {
	let p = Path::new(&path);
	let mut cmd = std::process::Command::new("explorer");
	if p.is_file() { cmd.arg(format!("/select,{}", p.display())) } else { cmd.arg(p) };
	cmd.spawn().map_err(err)?;
	Ok(())
}
