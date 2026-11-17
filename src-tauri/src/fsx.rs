// 프로젝트 폴더 안 파일 읽기 · 쓰기. 모든 경로는 프로젝트 폴더(root) 기준 상대 경로이고, 밖으로 나가지 못한다.
// abs_* 두 개만 사용자가 대화 상자로 고른 절대 경로(PPTX 가져오기 · 내보내기)를 다룬다.

use crate::{Res, err};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use std::path::{Component, Path, PathBuf};

pub fn inside(root: &str, rel: &str) -> Res<PathBuf> {
	let rel = Path::new(rel);
	if rel.is_absolute() || rel.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_))) {
		return Err(format!("프로젝트 밖 경로: {}", rel.display()));
	}
	Ok(Path::new(root).join(rel))
}

fn ensure_parent(p: &Path) -> Res<()> {
	if let Some(d) = p.parent() {
		std::fs::create_dir_all(d).map_err(err)?;
	}
	Ok(())
}

#[tauri::command]
pub fn fs_read_text(root: String, rel: String) -> Res<String> {
	std::fs::read_to_string(inside(&root, &rel)?).map_err(err)
}

#[tauri::command]
pub fn fs_write_text(root: String, rel: String, text: String) -> Res<()> {
	let p = inside(&root, &rel)?;
	ensure_parent(&p)?;
	std::fs::write(p, text).map_err(err)
}

#[tauri::command]
pub fn fs_write_base64(root: String, rel: String, data: String) -> Res<()> {
	let p = inside(&root, &rel)?;
	ensure_parent(&p)?;
	std::fs::write(p, B64.decode(data).map_err(err)?).map_err(err)
}

#[tauri::command]
pub fn fs_exists(root: String, rel: String) -> Res<bool> {
	Ok(inside(&root, &rel)?.exists())
}

#[tauri::command]
pub fn abs_read_base64(path: String) -> Res<String> {
	Ok(B64.encode(std::fs::read(path).map_err(err)?))
}

#[tauri::command]
pub fn abs_write_base64(path: String, data: String) -> Res<()> {
	let p = PathBuf::from(path);
	ensure_parent(&p)?;
	std::fs::write(p, B64.decode(data).map_err(err)?).map_err(err)
}
