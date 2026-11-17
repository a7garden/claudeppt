// 판 관리 — 프로젝트 폴더마다 git 저장소를 둔다. 사용자는 git 을 몰라도 된다.
//
//   판(v<n>)      커밋 수. Claude 한 턴 · 직접 편집 한 묶음 · 되돌리기가 각각 한 판이 된다.
//   릴리즈(r<k>)  사용자가 「릴리즈」로 확정한 판. git 태그 r<k> 와 releases/r<k>-v<n>.pptx 가 남는다.
//   되돌리기      지난 판의 파일을 지금 위에 덮어 새 판으로 남긴다. 이력은 지우지 않는다 (앞으로만 간다).
//
// 사용자의 git 설정(이름 · 줄끝 변환)에 기대지 않도록 매번 -c 로 준다.

use crate::{Res, err, hidden};
use serde::Serialize;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path) -> Command {
	let mut c = Command::new("git");
	hidden(&mut c);
	c.current_dir(dir).args([
		"-c", "core.autocrlf=false",
		"-c", "core.quotepath=false",
		"-c", "user.name=ClaudePPT",
		"-c", "user.email=claudeppt@local",
		"-c", "commit.gpgsign=false",
		"-c", "tag.gpgsign=false",
	]);
	c
}

fn run(dir: &Path, args: &[&str]) -> Res<String> {
	let o = git(dir).args(args).output().map_err(|e| format!("git 을 띄우지 못했다 ({e}) — git 이 설치되어 있어야 판 관리가 된다"))?;
	if !o.status.success() {
		return Err(String::from_utf8_lossy(&o.stderr).trim().to_string());
	}
	Ok(String::from_utf8_lossy(&o.stdout).trim_end().to_string())
}

pub fn show_file(dir: &Path, rev: &str, rel: &str) -> Option<Vec<u8>> {
	if !rev.chars().all(|c| c.is_ascii_hexdigit()) {
		return None;
	}
	let o = git(dir).args(["show", &format!("{rev}:{rel}")]).output().ok()?;
	o.status.success().then_some(o.stdout)
}

const IGNORE: &str = "# 앱이 쓰는 상태(핀 · 대화 · 임시 파일) — 판에 넣지 않는다
.claudeppt/
";

#[tauri::command]
pub fn vcs_init(dir: String) -> Res<()> {
	let d = Path::new(&dir);
	std::fs::create_dir_all(d).map_err(err)?;
	if !d.join(".git").exists() {
		run(d, &["init", "-q", "-b", "main"])?;
	}
	if !d.join(".gitignore").exists() {
		std::fs::write(d.join(".gitignore"), IGNORE).map_err(err)?;
	}
	Ok(())
}

#[derive(Serialize)]
pub struct Commit {
	n: u32,
	hash: String,
	short: String,
	date: String,
	subject: String,
	tags: Vec<String>,
}

/// 바뀐 것이 있으면 한 판으로 남기고 그 판을 돌려준다. 없으면 None.
#[tauri::command]
pub fn vcs_commit(dir: String, message: String) -> Res<Option<Commit>> {
	let d = Path::new(&dir);
	vcs_init(dir.clone())?;
	run(d, &["add", "-A"])?;
	let changed = !git(d).args(["diff", "--cached", "--quiet"]).status().map_err(err)?.success();
	let first = run(d, &["rev-parse", "--verify", "-q", "HEAD"]).is_err();
	if !changed && !first {
		return Ok(None);
	}
	run(d, &["commit", "-q", "--allow-empty", "-m", &message])?;
	Ok(head(d).ok())
}

fn head(d: &Path) -> Res<Commit> {
	Ok(vcs_log(d.to_string_lossy().into(), Some(1))?.into_iter().next().ok_or("판이 없다")?)
}

#[tauri::command]
pub fn vcs_log(dir: String, limit: Option<u32>) -> Res<Vec<Commit>> {
	let d = Path::new(&dir);
	if run(d, &["rev-parse", "--verify", "-q", "HEAD"]).is_err() {
		return Ok(vec![]);
	}
	let total: u32 = run(d, &["rev-list", "--count", "HEAD"])?.trim().parse().unwrap_or(0);
	let mut tags: std::collections::HashMap<String, Vec<String>> = Default::default();
	if let Ok(t) = run(d, &["show-ref", "--tags"]) {
		for line in t.lines() {
			if let Some((h, r)) = line.split_once(' ') {
				tags.entry(h.to_string()).or_default().push(r.trim_start_matches("refs/tags/").to_string());
			}
		}
	}
	let mut args = vec!["log".to_string(), "--format=%H%x09%h%x09%ci%x09%s".to_string()];
	if let Some(l) = limit {
		args.push(format!("-{l}"));
	}
	let args: Vec<&str> = args.iter().map(String::as_str).collect();
	let out = run(d, &args)?;
	Ok(out
		.lines()
		.enumerate()
		.filter_map(|(i, l)| {
			let mut p = l.splitn(4, '\t');
			let hash = p.next()?.to_string();
			Some(Commit {
				n: total - i as u32,
				short: p.next()?.to_string(),
				date: p.next()?.get(..16)?.to_string(),
				subject: p.next().unwrap_or("").to_string(),
				tags: tags.remove(&hash).unwrap_or_default(),
				hash,
			})
		})
		.collect())
}

/// 그 판에서 바뀐 파일 — 「A path」 「M path」 「D path」 줄.
#[tauri::command]
pub fn vcs_files(dir: String, hash: String) -> Res<Vec<String>> {
	let out = run(Path::new(&dir), &["show", "--name-status", "--format=", &hash])?;
	Ok(out.lines().filter(|l| !l.is_empty()).map(|l| l.replacen('\t', " ", 1)).collect())
}

#[tauri::command]
pub fn vcs_tag(dir: String, name: String) -> Res<()> {
	run(Path::new(&dir), &["tag", &name]).map(|_| ())
}

/// 지난 판으로 되돌린다 — 지금 남지 않은 변경을 먼저 한 판으로 남기고, 그 판 뒤에 생긴 파일은 지운 뒤
/// 그 판의 파일을 덮어 새 판으로 남긴다.
#[tauri::command]
pub fn vcs_restore(dir: String, hash: String, message: String) -> Res<Option<Commit>> {
	let d = Path::new(&dir);
	vcs_commit(dir.clone(), "되돌리기 전 변경을 남긴다".into())?;
	let added = run(d, &["diff", "--name-only", "--diff-filter=A", &hash, "HEAD"])?;
	for rel in added.lines().filter(|l| !l.is_empty()) {
		let _ = std::fs::remove_file(d.join(rel));
	}
	run(d, &["checkout", &hash, "--", "."])?;
	vcs_commit(dir, message)
}

#[tauri::command]
pub fn vcs_dirty(dir: String) -> Res<bool> {
	Ok(!run(Path::new(&dir), &["status", "--porcelain"])?.is_empty())
}
