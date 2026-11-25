// 판 관리 — 프로젝트 폴더마다 git 저장소를 둔다. 사용자는 git 을 몰라도 된다.
//
//   판(v<n>)      커밋 수. Claude 한 턴 · 직접 편집 한 묶음 · 되돌리기가 각각 한 판이 된다.
//   릴리즈(r<k>)  사용자가 「릴리즈」로 확정한 판. git 태그 r<k> 와 releases/r<k>-v<n>.pptx 가 남는다.
//   되돌리기      지난 판의 파일을 지금 위에 덮어 새 판으로 남긴다. 이력은 지우지 않는다 (앞으로만 간다).
//
// 사용자의 git 설정(이름 · 줄끝 변환)에 기대지 않도록 매번 -c 로 준다.

use crate::{Res, err, hidden};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

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
	/// 남긴 이 — 앱이 남긴 판은 ClaudePPT, 담당이 남긴 판은 그 담당 이름 (seats.rs)
	author: String,
	/// 담당이 남긴 판이면 그 번호 — 작성자 메일(seat-<n>@claudeppt)에서 읽는다
	seat: Option<u32>,
}

/// 바뀐 것이 있으면 한 판으로 남기고 그 판을 돌려준다. 없으면 None.
/// exclude — 판에 넣지 않을 파일. 담당이 「지금 고치는 중」이라고 알린 쪽은 앱의 판(대화 턴 · 직접 편집)에 섞지 않는다
#[tauri::command]
pub fn vcs_commit(dir: String, message: String, exclude: Option<Vec<String>>) -> Res<Option<Commit>> {
	vcs_init(dir.clone())?;
	let _l = lock(Path::new(&dir))?;
	commit_all(Path::new(&dir), &message, exclude)
}

/// 판 남기기 잠금 — 담당 세션 여럿(CLI 프로세스 각각)과 앱이 덱 하나의 git 색인을 함께 쓴다.
/// 잠그지 않으면 한 담당이 맡은 파일을 올린 사이 다른 담당이 색인을 비우고 제 파일을 올려, 남의 파일이 내 이름의 판으로 남는다.
/// 2026.11.25 : 두 세션이 동시에 commit 하는 시험에서 찾았다
struct Lock(PathBuf);

impl Drop for Lock {
	fn drop(&mut self) {
		let _ = std::fs::remove_file(&self.0);
	}
}

fn lock(d: &Path) -> Res<Lock> {
	let p = d.join(".git").join("claudeppt-commit.lock");
	let t0 = Instant::now();
	loop {
		match std::fs::OpenOptions::new().write(true).create_new(true).open(&p) {
			Ok(_) => return Ok(Lock(p)),
			Err(_) => {
				// 죽은 프로세스가 남긴 잠금 — 판 하나 남기기는 몇 초면 끝나므로 2분 넘게 묵었으면 걷는다
				let stale = p.metadata().and_then(|m| m.modified()).ok().and_then(|m| m.elapsed().ok()).is_some_and(|e| e > Duration::from_secs(120));
				if stale {
					let _ = std::fs::remove_file(&p);
					continue;
				}
				if t0.elapsed() > Duration::from_secs(60) {
					return Err("다른 판 남기기가 60초 넘게 끝나지 않는다 — 잠시 뒤 다시 한다".into());
				}
				std::thread::sleep(Duration::from_millis(50));
			}
		}
	}
}

fn commit_all(d: &Path, message: &str, exclude: Option<Vec<String>>) -> Res<Option<Commit>> {
	run(d, &["add", "-A"])?;
	for x in exclude.unwrap_or_default() {
		let _ = run(d, &["reset", "-q", "--", &x]);
	}
	finish(d, message, None)
}

/// 담당의 판 — only 에 든 파일만 넣고 작성자를 담당으로 남긴다. 다른 담당이 고치는 중인 파일이 섞이지 않게
pub fn commit_only(dir: &Path, message: &str, only: &[String], author: (&str, &str)) -> Res<Option<Commit>> {
	vcs_init(dir.to_string_lossy().into())?;
	let _l = lock(dir)?;
	// 색인을 비우고 맡은 파일만 올린다 — 작업 파일은 건드리지 않는다
	if run(dir, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok() {
		run(dir, &["reset", "-q"])?;
	}
	for x in only {
		run(dir, &["add", "-A", "--", x])?;
	}
	finish(dir, message, Some(author))
}

/// 바뀐 파일 — 덱 폴더 기준 상대 경로 (지운 파일 포함)
pub fn changed(dir: &Path) -> Res<Vec<String>> {
	let out = run(dir, &["status", "--porcelain", "-uall", "-z"])?;
	let mut v = vec![];
	let mut it = out.split('\0').filter(|x| x.len() > 3);
	while let Some(e) = it.next() {
		// 옮긴 파일은 「새 이름\0옛 이름」 — 옛 이름도 바뀐 파일이다
		if e.starts_with('R') || e.as_bytes().get(1) == Some(&b'R') {
			v.push(e[3..].to_string());
			if let Some(old) = it.next() {
				v.push(old.to_string());
			}
		} else {
			v.push(e[3..].to_string());
		}
	}
	Ok(v)
}

fn finish(d: &Path, message: &str, author: Option<(&str, &str)>) -> Res<Option<Commit>> {
	let changed = !git(d).args(["diff", "--cached", "--quiet"]).status().map_err(err)?.success();
	let first = run(d, &["rev-parse", "--verify", "-q", "HEAD"]).is_err();
	if !changed && !first {
		return Ok(None);
	}
	let by = author.map(|(n, m)| format!("--author={n} <{m}>"));
	let mut args = vec!["commit", "-q", "--allow-empty", "-m", message];
	if let Some(b) = &by {
		args.push(b);
	}
	run(d, &args)?;
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
	let mut args = vec!["log".to_string(), "--format=%H%x09%h%x09%ci%x09%an%x09%ae%x09%s".to_string()];
	if let Some(l) = limit {
		args.push(format!("-{l}"));
	}
	let args: Vec<&str> = args.iter().map(String::as_str).collect();
	let out = run(d, &args)?;
	Ok(out
		.lines()
		.enumerate()
		.filter_map(|(i, l)| {
			let mut p = l.splitn(6, '\t');
			let hash = p.next()?.to_string();
			let short = p.next()?.to_string();
			let date = p.next()?.get(..16)?.to_string();
			let author = p.next()?.to_string();
			let seat = p.next()?.strip_prefix("seat-").and_then(|m| m.split('@').next()).and_then(|n| n.parse().ok());
			Some(Commit {
				n: total - i as u32,
				short,
				date,
				author,
				seat,
				subject: p.next().unwrap_or("").to_string(),
				tags: tags.remove(&hash).unwrap_or_default(),
				hash,
			})
		})
		.collect())
}

#[tauri::command]
pub fn vcs_tag(dir: String, name: String) -> Res<()> {
	run(Path::new(&dir), &["tag", &name]).map(|_| ())
}

/// 지난 판으로 되돌린다 — 지금 남지 않은 변경을 먼저 한 판으로 남기고, 그 판 뒤에 생긴 파일은 지운 뒤
/// 그 판의 파일을 덮어 새 판으로 남긴다.
/// releases/ · source/ 는 덱 내용이 아니라 기록이다 — 되돌려도 지우거나 옛것으로 바꾸지 않는다.
/// (지우면 릴리즈 PPTX · 원본 쪽 그림이 사라지고, 다음 릴리즈가 같은 r<k> 를 다시 단다)
#[tauri::command]
pub fn vcs_restore(dir: String, hash: String, message: String) -> Res<Option<Commit>> {
	let d = Path::new(&dir);
	vcs_init(dir.clone())?;
	let _l = lock(d)?;
	commit_all(d, "되돌리기 전 변경을 남긴다", None)?;
	let keep = |p: &str| p.starts_with("releases/") || p.starts_with("source/");
	let added = run(d, &["diff", "--name-only", "--diff-filter=A", &hash, "HEAD"])?;
	for rel in added.lines().filter(|l| !l.is_empty() && !keep(l)) {
		let _ = std::fs::remove_file(d.join(rel));
	}
	run(d, &["checkout", &hash, "--", ".", ":(exclude)releases", ":(exclude)source"])?;
	commit_all(d, &message, None)
}
