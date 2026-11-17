// 프로젝트 폴더 감시 — 파일이 바뀌면 화면에 「deck-fs」 사건으로 상대 경로 목록을 보낸다.
// Claude 가 한 번에 여러 파일을 고치므로 120ms 모았다가 한 번에 보낸다 (편집기 저장 이벤트도 여러 번 온다).
// .git · .claudeppt(앱 상태 · 핀 · 대화)는 빼다 — 핀을 찍을 때마다 슬라이드가 다시 그려지면 안 된다.

use crate::{Res, err};
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer, notify::RecommendedWatcher, notify::RecursiveMode};
use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub type Handle = Debouncer<RecommendedWatcher>;

#[derive(Serialize, Clone)]
struct Changed {
	id: String,
	paths: Vec<String>,
}

pub fn start(app: AppHandle, id: String, root: PathBuf) -> Res<Handle> {
	let base = root.clone();
	let mut d = new_debouncer(Duration::from_millis(120), move |res: DebounceEventResult| {
		let Ok(events) = res else { return };
		let mut paths: Vec<String> = events
			.iter()
			.filter_map(|e| e.path.strip_prefix(&base).ok())
			.map(|p| p.to_string_lossy().replace('\\', "/"))
			.filter(|p| !p.is_empty() && !p.starts_with(".git") && !p.starts_with(".claudeppt") && !p.starts_with("releases/"))
			.collect();
		paths.sort();
		paths.dedup();
		if !paths.is_empty() {
			let _ = app.emit("deck-fs", Changed { id: id.clone(), paths });
		}
	})
	.map_err(err)?;
	d.watcher().watch(&root, RecursiveMode::Recursive).map_err(err)?;
	Ok(d)
}
