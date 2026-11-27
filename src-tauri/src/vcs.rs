// 판 관리 — 프로젝트 폴더마다 git 저장소를 둔다. 사용자는 git 을 몰라도 된다.
//
//   판(v<n>)      커밋 수. Claude 한 턴 · 직접 편집 한 묶음 · 되돌리기가 각각 한 판이 된다.
//   릴리즈(r<k>)  사용자가 「릴리즈」로 확정한 판. git 태그 r<k> 와 releases/r<k>-v<n>.pptx 가 남는다.
//   되돌리기      지난 판의 파일을 지금 위에 덮어 새 판으로 남긴다. 이력은 지우지 않는다 (앞으로만 간다).
//   작업 사본     Claude 턴은 세션마다 둔 작업 사본(git worktree)에서 돌고, 끝나면 변경 한 묶음을 덱 위에 3방향으로 얹는다.
//                 그 사이 남이 같은 곳을 고쳤으면 얹지 않고 보류 갈래로 남긴다 (아래 「작업 사본」)
//
// 사용자의 git 설정(이름 · 줄끝 변환)에 기대지 않도록 매번 -c 로 준다.
//
// 앱 명령은 #[tauri::command(async)] — 화면(메인) 스레드가 아니라 스레드 풀에서 돈다.
// git 을 여러 번 띄우고 다른 판 남기기를 최대 60초 기다리므로(lock), 화면 스레드에서 돌면 그동안 창 전체가 멈춘다.
// CLI(cli.rs)는 같은 함수를 그대로 동기로 부른다.

use crate::{Res, err, hidden};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

pub(crate) fn git(dir: &Path) -> Command {
	let mut c = Command::new("git");
	hidden(&mut c);
	c.current_dir(dir).args([
		"-c", "core.autocrlf=false",
		"-c", "core.quotepath=false",
		"-c", "user.name=ClaudePPT",
		"-c", "user.email=claudeppt@local",
		"-c", "commit.gpgsign=false",
		"-c", "tag.gpgsign=false",
		// 사용자 전역 설정이 덱 저장소에 끼어들지 않게.
		// 훅(전역 core.hooksPath · init 템플릿)이 판 남기기를 막거나 늦추고, fsmonitor 는 덱마다 상주 프로세스를 남기고,
		// log.showSignature · color.ui 는 git log 출력에 줄을 끼워 판 목록 읽기를 깬다
		"-c", "core.hooksPath=.git/claudeppt-no-hooks",
		"-c", "core.fsmonitor=false",
		"-c", "log.showSignature=false",
		"-c", "color.ui=false",
		"-c", "i18n.logOutputEncoding=utf-8",
	]);
	c
}

pub(crate) fn run(dir: &Path, args: &[&str]) -> Res<String> {
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

#[tauri::command(async)]
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
	pub(crate) n: u32,
	hash: String,
	short: String,
	date: String,
	pub(crate) subject: String,
	tags: Vec<String>,
	/// 남긴 이 — 팀원이 시킨 판은 그 사람 이름, 그 밖(직접 편집 · 바깥 CLI)은 ClaudePPT
	pub(crate) author: String,
}

/// 바뀐 것이 있으면 한 판으로 남기고 그 판을 돌려준다. 없으면 None.
/// author — 이 판을 시킨 팀원 이름. 주면 git 작성자로 남는다 (판을 남기는 이는 그대로 ClaudePPT)
#[tauri::command(async)]
pub fn vcs_commit(dir: String, message: String, author: Option<String>) -> Res<Option<Commit>> {
	vcs_init(dir.clone())?;
	let _l = lock(Path::new(&dir))?;
	commit_all(Path::new(&dir), &message, author.as_deref())
}

/// 판 남기기 잠금 — 앱과 앱 밖 CLI(Claude Code 세션마다 프로세스가 따로 돈다)가 덱 하나의 git 색인을 함께 쓴다.
/// 잠그지 않으면 같은 때 판을 남길 때 한쪽이 git 의 index.lock 에 걸려 실패하고, 되돌리기(남기기 → 덮기 → 남기기) 사이에 다른 판이 끼어든다
pub(crate) struct Lock(PathBuf);

impl Drop for Lock {
	fn drop(&mut self) {
		let _ = std::fs::remove_file(&self.0);
	}
}

/// 이 작업 폴더의 git 폴더 — 덱이면 .git, 시안 · 작업 사본(worktree)이면 .git 파일이 가리키는 곳.
/// 2026.11.27 : 시안 폴더를 덱으로 열게 되며 더했다 — .git 이 파일이라 그 안에 잠금 · 상태 파일을 둘 수 없다
pub(crate) fn git_dir(d: &Path) -> PathBuf {
	let g = d.join(".git");
	if g.is_file() {
		if let Some(p) = std::fs::read_to_string(&g).ok().and_then(|s| s.trim().strip_prefix("gitdir:").map(|x| PathBuf::from(x.trim()))) {
			return if p.is_absolute() { p } else { d.join(p) };
		}
	}
	g
}

pub(crate) fn lock(d: &Path) -> Res<Lock> {
	let p = git_dir(d).join("claudeppt-commit.lock");
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

/// 덱 폴더 안 상대 경로인가
fn safe_rel(p: &str) -> bool {
	!p.is_empty() && !p.starts_with('/') && !p.contains(':') && !p.split('/').any(|c| c == "..")
}

pub(crate) fn commit_all(d: &Path, message: &str, author: Option<&str>) -> Res<Option<Commit>> {
	run(d, &["add", "-A"])?;
	finish(d, message, author)
}

/// 색인에 담긴 것을 한 판으로 (바뀐 것이 없으면 None, 첫 판은 비어 있어도 남긴다)
fn finish(d: &Path, message: &str, author: Option<&str>) -> Res<Option<Commit>> {
	let changed = !git(d).args(["diff", "--cached", "--quiet"]).status().map_err(err)?.success();
	let first = run(d, &["rev-parse", "--verify", "-q", "HEAD"]).is_err();
	if !changed && !first {
		return Ok(None);
	}
	// git 작성자 꼴은 「이름 <메일>」 — 이름에 꺾쇠가 있으면 꼴이 깨지므로 뺀다
	let by = author.map(|a| a.replace(['<', '>'], "").trim().to_string()).filter(|a| !a.is_empty()).map(|a| format!("--author={a} <member@claudeppt>"));
	let mut args = vec!["commit", "-q", "--allow-empty", "-m", message];
	if let Some(b) = &by {
		args.push(b);
	}
	run(d, &args)?;
	Ok(head(d).ok())
}

pub(crate) fn head(d: &Path) -> Res<Commit> {
	Ok(vcs_log(d.to_string_lossy().into(), Some(1))?.into_iter().next().ok_or("판이 없다")?)
}

#[tauri::command(async)]
pub fn vcs_log(dir: String, limit: Option<u32>) -> Res<Vec<Commit>> {
	let d = Path::new(&dir);
	if run(d, &["rev-parse", "--verify", "-q", "HEAD"]).is_err() {
		return Ok(vec![]);
	}
	// 본 줄만 센다 (2026.11.27) — 시안을 넣으면(merge) 시안의 변경은 「넣음」 하나로 보이고, 번호가 시안의 변경 수만큼 건너뛰지 않는다
	let total: u32 = run(d, &["rev-list", "--count", "--first-parent", "HEAD"])?.trim().parse().unwrap_or(0);
	let mut tags: std::collections::HashMap<String, Vec<String>> = Default::default();
	if let Ok(t) = run(d, &["show-ref", "--tags"]) {
		for line in t.lines() {
			if let Some((h, r)) = line.split_once(' ') {
				tags.entry(h.to_string()).or_default().push(r.trim_start_matches("refs/tags/").to_string());
			}
		}
	}
	let mut args = vec!["log".to_string(), "--first-parent".to_string(), "--format=%H%x09%h%x09%ci%x09%an%x09%s".to_string()];
	if let Some(l) = limit {
		args.push(format!("-{l}"));
	}
	let args: Vec<&str> = args.iter().map(String::as_str).collect();
	let out = run(d, &args)?;
	Ok(out
		.lines()
		.enumerate()
		.filter_map(|(i, l)| {
			let mut p = l.splitn(5, '\t');
			let hash = p.next()?.to_string();
			Some(Commit {
				n: total - i as u32,
				short: p.next()?.to_string(),
				date: p.next()?.get(..16)?.to_string(),
				author: p.next()?.to_string(),
				subject: p.next().unwrap_or("").to_string(),
				tags: tags.remove(&hash).unwrap_or_default(),
				hash,
			})
		})
		.collect())
}

#[tauri::command(async)]
pub fn vcs_tag(dir: String, name: String) -> Res<()> {
	run(Path::new(&dir), &["tag", &name]).map(|_| ())
}

/// 지난 판으로 되돌린다 — 지금 남지 않은 변경을 먼저 한 판으로 남기고, 그 판 뒤에 생긴 파일은 지운 뒤
/// 그 판의 파일을 덮어 새 판으로 남긴다.
/// releases/ · source/ 는 덱 내용이 아니라 기록이다 — 되돌려도 지우거나 옛것으로 바꾸지 않는다.
/// (지우면 릴리즈 PPTX · 원본 쪽 그림이 사라지고, 다음 릴리즈가 같은 r<k> 를 다시 단다)
#[tauri::command(async)]
pub fn vcs_restore(dir: String, hash: String, message: String, author: Option<String>) -> Res<Option<Commit>> {
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
	commit_all(d, &message, author.as_deref())
}

// ── 작업 사본 (2026.11.27) ──
// Claude 턴은 덱 원본이 아니라 세션마다 둔 작업 사본(git worktree)에서 돈다. 끝나면 그 턴의 변경을 묶음(커밋) 하나로 만들어
// 덱 위에 3방향으로 얹는다(cherry-pick). 그 사이 손 편집 · 다른 턴이 같은 곳을 고쳤으면 얹지 않고 보류 갈래로 남긴다.
//   그래서   어떤 변경도 남의 변경을 모른 채 덮어쓰지 못한다 — 덮을 것 같으면 들어가지 않고, 들어가지 못한 것도 버리지 않는다
//   전에는   여러 세션의 턴이 같은 덱 폴더에 바로 썼다. 같은 파일(테마 · 덱 목차 · 요청에 없던 쪽)을 둘이 고치면 늦게 쓴 쪽이 이겼고,
//            그래서 손 편집은 턴이 도는 동안 아예 받지 않았다
//   자리     앱 데이터 work/<덱 지문>/<세션> — 덱 폴더 밖이라 .cppt 묶음 · 폴더 감시에 들지 않는다. 같은 세션은 차례로 돌아 세션마다 하나면 되고,
//            자리가 늘 같아 Claude 세션 기록(작업 폴더마다 따로 둔다)이 턴 사이에 이어진다
//   보류     refs/heads/cppt/hold/<턴 id> — 보통 git 갈래라 앱 밖 git 으로도 보인다. 덱에 들어간 변경은 본 줄(main)에 곧게 쌓인다

const HOLD: &str = "cppt/hold/";

/// 이름(세션 · 턴 id)은 화면에서 온다 — 경로 · 갈래 이름에 쓰므로 영문 · 숫자만
pub(crate) fn plain(s: &str) -> Res<&str> {
	(!s.is_empty() && s.len() <= 40 && s.chars().all(|c| c.is_ascii_alphanumeric())).then_some(s).ok_or_else(|| format!("이름이 맞지 않다: {s}"))
}

fn work_dir(d: &Path, key: &str) -> Res<PathBuf> {
	let deck = crate::invite::hash(&d.to_string_lossy().to_lowercase());
	Ok(crate::control::data_dir().join("work").join(&deck[..16]).join(plain(key)?))
}

#[derive(Serialize)]
pub struct Work {
	path: String,
	base: String,
}

/// 그 세션의 작업 사본을 덱의 지금 판으로 맞춘다. 손 편집이 판으로 남지 않았으면 사본에 들지 않는다 — 화면이 먼저 남긴다
#[tauri::command(async)]
pub fn vcs_work_prepare(dir: String, key: String) -> Res<Work> {
	vcs_init(dir.clone())?;
	let d = Path::new(&dir);
	let w = work_dir(d, &key)?;
	let _l = lock(d)?;
	if run(d, &["rev-parse", "--verify", "-q", "HEAD"]).is_err() {
		commit_all(d, "새로 만듦", None)?;
	}
	let base = run(d, &["rev-parse", "HEAD"])?;
	// 이 덱의 사본인가 — 덱을 옮겼거나 사본이 망가졌으면 새로 만든다. 지우는 곳은 앱 데이터 안 사본 자리뿐이다
	let common = |p: &Path| run(p, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).ok().and_then(|g| std::fs::canonicalize(g.trim()).ok());
	let mine = w.join(".git").is_file() && common(&w).is_some() && common(&w) == common(d);
	// 끝나지 않은 턴이 남긴 것(앱이 꺼졌다 · 얹기 전에 오류)이 있으면 지우기 전에 보류로 남긴다 — Claude 가 한 일을 소리 없이 잃지 않게
	if mine && !run(&w, &["status", "--porcelain"]).unwrap_or_default().trim().is_empty() {
		let _ = run(&w, &["add", "-A"]).and_then(|_| finish(&w, "끝나지 않은 턴의 변경", None));
		if let Ok(c) = run(&w, &["rev-parse", "HEAD"]) {
			let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
			let _ = run(d, &["branch", "-f", &format!("{HOLD}{key}x{t}"), &c]);
		}
	}
	let reset = || -> Res<()> {
		run(&w, &["reset", "-q", "--hard", &base])?;
		run(&w, &["clean", "-fdxq"]).map(|_| ())
	};
	if !mine || reset().is_err() {
		let _ = std::fs::remove_dir_all(&w);
		let _ = run(d, &["worktree", "prune"]);
		std::fs::create_dir_all(w.parent().unwrap()).map_err(err)?;
		run(d, &["worktree", "add", "-q", "--detach", &w.to_string_lossy(), &base])?;
	}
	Ok(Work { path: w.to_string_lossy().into(), base })
}

/// 턴이 읽을 앱 파일(첨부 · 표시 그림)을 덱에서 사본으로 — .claudeppt 는 판에 들지 않아 사본에 없다
#[tauri::command(async)]
pub fn vcs_work_bring(dir: String, key: String, paths: Vec<String>) -> Res<()> {
	let d = Path::new(&dir);
	let w = work_dir(d, &key)?;
	for p in paths.iter().map(|p| p.replace('\\', "/")).filter(|p| safe_rel(p) && p.starts_with(".claudeppt/")) {
		let to = w.join(&p);
		std::fs::create_dir_all(to.parent().unwrap()).map_err(err)?;
		std::fs::copy(d.join(&p), to).map_err(err)?;
	}
	Ok(())
}

/// 얹은 결과
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Landed {
	/// 고친 것이 없다 (또는 이미 같은 내용이 들어가 있다)
	None,
	/// 덱에 들어가 판이 되었다
	Applied { commit: Commit, files: Vec<String> },
	/// 그 사이 같은 곳을 남이 고쳐 얹지 않았다 — 보류 갈래로 남겼다
	Held { hold: Hold },
}

/// 보류 갈래 하나 — 덱에 들어가지 못한 변경 묶음
#[derive(Serialize)]
pub struct Hold {
	/// 턴 id (갈래 이름 cppt/hold/<name>)
	name: String,
	hash: String,
	author: String,
	subject: String,
	date: String,
	/// 이 묶음이 고친 파일
	files: Vec<String>,
	/// 얹으려다 겹친 파일 — 얹을 때만 안다 (목록에서는 빈다)
	conflicts: Vec<String>,
}

/// 턴이 끝났다 — 사본의 변경을 묶음 하나로 만들어 덱에 얹는다
#[tauri::command(async)]
pub fn vcs_work_finish(dir: String, key: String, turn: String, message: String, author: Option<String>) -> Res<Landed> {
	let d = Path::new(&dir);
	let w = work_dir(d, &key)?;
	plain(&turn)?;
	run(&w, &["add", "-A"])?;
	if git(&w).args(["diff", "--cached", "--quiet"]).status().map_err(err)?.success() {
		return Ok(Landed::None);
	}
	finish(&w, &message, author.as_deref())?;
	let c = run(&w, &["rev-parse", "HEAD"])?;
	// 얹기 전에 보류 갈래부터 — 얹다가 오류가 나도 묶음이 남는다. 들어가면 land 가 걷는다
	run(d, &["branch", "-f", &format!("{HOLD}{turn}"), &c])?;
	let _l = lock(d)?;
	land(d, &c, &turn)
}

/// 묶음 하나를 덱 위에 얹는다 (잠근 채로 부른다). 못 얹으면 덱은 그대로 두고 보류 갈래로 남긴다
fn land(d: &Path, c: &str, name: &str) -> Res<Landed> {
	// 덱에 판으로 남지 않은 것(앱 밖에서 고친 것)이 있으면 먼저 — 얹기는 깨끗한 덱 위에서만 한다. 섞이면 되돌릴 때 함께 날아간다
	commit_all(d, "덱에 남아 있던 변경", None)?;
	let files = files_of(d, c)?;
	let hold = format!("{HOLD}{name}");
	match run(d, &["cherry-pick", c]) {
		Ok(_) => {
			let _ = run(d, &["branch", "-D", &hold]);
			Ok(Landed::Applied { commit: head(d)?, files })
		}
		Err(e) => {
			let picking = git_dir(d).join("CHERRY_PICK_HEAD").exists();
			let conflicts: Vec<String> = run(d, &["diff", "--name-only", "--diff-filter=U"]).unwrap_or_default().lines().map(String::from).collect();
			if picking && conflicts.is_empty() {
				// 같은 내용이 이미 들어가 있다 — 얹을 것이 없다
				let _ = run(d, &["cherry-pick", "--skip"]);
				let _ = run(d, &["branch", "-D", &hold]);
				return Ok(Landed::None);
			}
			if picking {
				run(d, &["cherry-pick", "--abort"])?;
			}
			run(d, &["branch", "-f", &hold, c])?;
			let mut h = hold_of(d, name)?;
			h.conflicts = if conflicts.is_empty() { vec![e] } else { conflicts };
			Ok(Landed::Held { hold: h })
		}
	}
}

/// 묶음 하나가 고친 파일
fn files_of(d: &Path, c: &str) -> Res<Vec<String>> {
	Ok(run(d, &["diff-tree", "--no-commit-id", "--name-only", "-r", c])?.lines().filter(|l| !l.is_empty()).map(String::from).collect())
}

fn hold_of(d: &Path, name: &str) -> Res<Hold> {
	let r = format!("{HOLD}{}", plain(name)?);
	let line = run(d, &["log", "-1", "--format=%H%x09%an%x09%ci%x09%s", &r])?;
	let mut p = line.splitn(4, '\t');
	let hash = p.next().unwrap_or("").to_string();
	let author = p.next().unwrap_or("").to_string();
	let date = p.next().unwrap_or("").get(..16).unwrap_or("").to_string();
	let subject = p.next().unwrap_or("").to_string();
	Ok(Hold { name: name.to_string(), files: files_of(d, &hash)?, hash, author, subject, date, conflicts: vec![] })
}

/// 보류 갈래 목록 — 새것부터
#[tauri::command(async)]
pub fn vcs_holds(dir: String) -> Res<Vec<Hold>> {
	let d = Path::new(&dir);
	if !d.join(".git").exists() {
		return Ok(vec![]);
	}
	let refs = run(d, &["for-each-ref", "--sort=-creatordate", "--format=%(refname:short)", &format!("refs/heads/{HOLD}")])?;
	Ok(refs.lines().filter_map(|r| r.strip_prefix(HOLD)).filter_map(|n| hold_of(d, n).ok()).collect())
}

/// 보류한 것을 다시 얹어 본다 — 그 사이 겹친 쪽이 되돌려졌거나 손으로 맞췄으면 들어간다
#[tauri::command(async)]
pub fn vcs_hold_retry(dir: String, name: String) -> Res<Landed> {
	let d = Path::new(&dir);
	let c = run(d, &["rev-parse", &format!("{HOLD}{}", plain(&name)?)])?;
	let _l = lock(d)?;
	land(d, &c, &name)
}

/// 보류한 것으로 바꾼다 — 그 묶음이 고친 파일을 묶음의 내용 그대로 덱에 놓고 새 판으로. 덮인 지금 내용은 지난 판에 남는다
#[tauri::command(async)]
pub fn vcs_hold_take(dir: String, name: String, message: String, author: Option<String>) -> Res<Option<Commit>> {
	let d = Path::new(&dir);
	let r = format!("{HOLD}{}", plain(&name)?);
	let c = run(d, &["rev-parse", &r])?;
	let _l = lock(d)?;
	commit_all(d, "덱에 남아 있던 변경", None)?;
	for line in run(d, &["diff-tree", "--no-commit-id", "--name-status", "-r", &c])?.lines() {
		let Some((st, rel)) = line.split_once('\t') else { continue };
		if st.starts_with('D') {
			let _ = std::fs::remove_file(d.join(rel));
		} else {
			run(d, &["checkout", &c, "--", &format!(":(literal){rel}")])?;
		}
	}
	let made = commit_all(d, &message, author.as_deref())?;
	run(d, &["branch", "-D", &r])?;
	Ok(made)
}

/// 보류한 것을 버린다 — 사람이 고른 때만. 지우지 않고 치워 둔다(cppt/old/…) — 잘못 눌러도 git 으로 되살린다
#[tauri::command(async)]
pub fn vcs_hold_drop(dir: String, name: String) -> Res<()> {
	let n = plain(&name)?;
	run(Path::new(&dir), &["branch", "-M", &format!("{HOLD}{n}"), &format!("{OLD}hold-{n}")]).map(|_| ())
}

/// 버린 보류 · 시안을 치워 두는 자리 — 목록 · 그래프에 나오지 않는다
pub(crate) const OLD: &str = "cppt/old/";

#[cfg(test)]
mod tests {
	use super::*;

	fn tmp(name: &str) -> String {
		let d = std::env::temp_dir().join(format!("cppt-vcs-{name}-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&d);
		std::fs::create_dir_all(&d).unwrap();
		d.to_string_lossy().into()
	}

	#[test]
	fn author_is_kept_on_each_version() {
		let dir = tmp("author");
		let p = Path::new(&dir);
		std::fs::write(p.join("a.txt"), "1").unwrap();
		let c = vcs_commit(dir.clone(), "first".into(), Some("민수".into())).unwrap().unwrap();
		assert_eq!(c.author, "민수");
		assert_eq!(c.n, 1);
		// 바뀐 것이 없으면 판을 남기지 않는다
		assert!(vcs_commit(dir.clone(), "same".into(), Some("민수".into())).unwrap().is_none());
		// 이름이 없으면 ClaudePPT · 꺾쇠는 빼고 · 빈 이름은 없는 것으로
		std::fs::write(p.join("a.txt"), "2").unwrap();
		assert_eq!(vcs_commit(dir.clone(), "no name".into(), None).unwrap().unwrap().author, "ClaudePPT");
		std::fs::write(p.join("a.txt"), "3").unwrap();
		assert_eq!(vcs_commit(dir.clone(), "brackets".into(), Some("<은지>".into())).unwrap().unwrap().author, "은지");
		std::fs::write(p.join("a.txt"), "4").unwrap();
		assert_eq!(vcs_commit(dir.clone(), "blank".into(), Some("  ".into())).unwrap().unwrap().author, "ClaudePPT");
		// 제목에 탭이 있어도 작성자 · 제목이 섞이지 않는다
		std::fs::write(p.join("a.txt"), "5").unwrap();
		let t = vcs_commit(dir.clone(), "tab\there".into(), Some("지호".into())).unwrap().unwrap();
		assert_eq!((t.author.as_str(), t.subject.as_str()), ("지호", "tab\there"));
		let log = vcs_log(dir.clone(), None).unwrap();
		assert_eq!(log.iter().map(|c| c.author.as_str()).collect::<Vec<_>>(), ["지호", "ClaudePPT", "은지", "ClaudePPT", "민수"]);
		let _ = std::fs::remove_dir_all(p);
	}

	/// 덱 하나 — 쪽 두 개, a 는 여러 줄 (줄이 다르면 겹치지 않는다)
	fn deck(name: &str) -> String {
		let dir = tmp(name);
		let p = Path::new(&dir);
		std::fs::create_dir_all(p.join("slides")).unwrap();
		std::fs::write(p.join("slides/a.html"), "a1\na2\na3\na4\na5\n").unwrap();
		std::fs::write(p.join("slides/b.html"), "b1\n").unwrap();
		vcs_commit(dir.clone(), "첫 판".into(), None).unwrap();
		dir
	}
	fn wipe(dir: &str) {
		// 이 시험 덱의 사본 자리째 — 앱 데이터에 빈 폴더가 쌓이지 않게
		let _ = std::fs::remove_dir_all(work_dir(Path::new(dir), "s1").unwrap().parent().unwrap());
		let _ = std::fs::remove_dir_all(dir);
	}
	fn put(w: &Work, rel: &str, text: &str) {
		std::fs::write(Path::new(&w.path).join(rel), text).unwrap();
	}
	fn read(dir: &str, rel: &str) -> String {
		std::fs::read_to_string(Path::new(dir).join(rel)).unwrap()
	}

	#[test]
	fn turns_in_copies_land_side_by_side() {
		let dir = deck("land");
		let (w1, w2) = (vcs_work_prepare(dir.clone(), "s1".into()).unwrap(), vcs_work_prepare(dir.clone(), "s2".into()).unwrap());
		assert_eq!(w1.base, w2.base);
		put(&w1, "slides/a.html", "a1\nA2\na3\na4\na5\n");
		put(&w2, "slides/b.html", "B1\n");
		assert_eq!(read(&dir, "slides/a.html"), "a1\na2\na3\na4\na5\n", "턴이 도는 동안 덱은 그대로다");
		let Landed::Applied { commit, files } = vcs_work_finish(dir.clone(), "s1".into(), "t1".into(), "a 고침".into(), Some("민수".into())).unwrap() else { panic!("첫 턴이 들어가야 한다") };
		assert_eq!((commit.author.as_str(), files), ("민수", vec!["slides/a.html".to_string()]));
		// 둘째 턴은 옛 판에서 시작했지만 다른 파일이라 그대로 들어간다
		assert!(matches!(vcs_work_finish(dir.clone(), "s2".into(), "t2".into(), "b 고침".into(), Some("은지".into())).unwrap(), Landed::Applied { .. }));
		assert_eq!((read(&dir, "slides/a.html"), read(&dir, "slides/b.html")), ("a1\nA2\na3\na4\na5\n".into(), "B1\n".into()));
		// 사본은 다음 턴에 지금 판으로 맞춰진다 · 고친 것이 없는 턴은 판을 남기지 않는다
		let w1 = vcs_work_prepare(dir.clone(), "s1".into()).unwrap();
		assert_eq!(read(&w1.path, "slides/b.html"), "B1\n");
		assert!(matches!(vcs_work_finish(dir.clone(), "s1".into(), "t3".into(), "없음".into(), None).unwrap(), Landed::None));
		assert_eq!(vcs_log(dir.clone(), None).unwrap().len(), 3);
		wipe(&dir);
	}

	#[test]
	fn same_file_different_lines_merges() {
		let dir = deck("merge");
		let w = vcs_work_prepare(dir.clone(), "s1".into()).unwrap();
		// 턴이 도는 동안 손으로 고친 것 (다른 줄)
		std::fs::write(Path::new(&dir).join("slides/a.html"), "a1\na2\na3\na4\nA5\n").unwrap();
		vcs_commit(dir.clone(), "손 편집".into(), Some("은지".into())).unwrap();
		put(&w, "slides/a.html", "A1\na2\na3\na4\na5\n");
		assert!(matches!(vcs_work_finish(dir.clone(), "s1".into(), "t1".into(), "턴".into(), None).unwrap(), Landed::Applied { .. }));
		assert_eq!(read(&dir, "slides/a.html"), "A1\na2\na3\na4\nA5\n", "둘 다 남는다");
		wipe(&dir);
	}

	#[test]
	fn overlap_is_held_not_overwritten() {
		let dir = deck("hold");
		let p = Path::new(&dir);
		let w = vcs_work_prepare(dir.clone(), "s1".into()).unwrap();
		std::fs::write(p.join("slides/a.html"), "a1\n손\na3\na4\na5\n").unwrap();
		vcs_commit(dir.clone(), "손 편집".into(), Some("은지".into())).unwrap();
		put(&w, "slides/a.html", "a1\nClaude\na3\na4\na5\n");
		put(&w, "slides/b.html", "B1\n");
		let Landed::Held { hold } = vcs_work_finish(dir.clone(), "s1".into(), "t1".into(), "턴".into(), Some("민수".into())).unwrap() else { panic!("겹치면 보류") };
		assert_eq!(hold.conflicts, ["slides/a.html"]);
		// 덱은 손 편집 그대로 · 겹치지 않은 b 도 묶음째 보류 (반쯤 들어가지 않는다) · 얹다 만 흔적이 없다
		assert_eq!((read(&dir, "slides/a.html"), read(&dir, "slides/b.html")), ("a1\n손\na3\na4\na5\n".into(), "b1\n".into()));
		assert!(!p.join(".git/CHERRY_PICK_HEAD").exists());
		assert!(run(p, &["status", "--porcelain"]).unwrap().is_empty());
		let list = vcs_holds(dir.clone()).unwrap();
		assert_eq!((list.len(), list[0].author.as_str(), list[0].files.len()), (1, "민수", 2));
		// 그대로 다시 얹으면 또 보류 · 「이것으로 바꾸기」는 묶음 내용으로 새 판, 손 편집은 지난 판에 남는다
		assert!(matches!(vcs_hold_retry(dir.clone(), "t1".into()).unwrap(), Landed::Held { .. }));
		let c = vcs_hold_take(dir.clone(), "t1".into(), "보류한 것으로".into(), Some("민수".into())).unwrap().unwrap();
		assert_eq!((read(&dir, "slides/a.html"), read(&dir, "slides/b.html")), ("a1\nClaude\na3\na4\na5\n".into(), "B1\n".into()));
		assert_eq!(c.author, "민수");
		assert!(vcs_holds(dir.clone()).unwrap().is_empty());
		assert_eq!(vcs_log(dir.clone(), None).unwrap()[1].subject, "손 편집");
		wipe(&dir);
	}

	#[test]
	fn unfinished_turn_is_kept_not_wiped() {
		let dir = deck("left");
		let w = vcs_work_prepare(dir.clone(), "s1".into()).unwrap();
		put(&w, "slides/b.html", "끝나기 전에 꺼짐
");
		// 다음 턴이 사본을 맞춘다 — 남은 것은 보류로
		let w = vcs_work_prepare(dir.clone(), "s1".into()).unwrap();
		assert_eq!(read(&w.path, "slides/b.html"), "b1
");
		let list = vcs_holds(dir.clone()).unwrap();
		assert_eq!((list.len(), list[0].files.as_slice()), (1, ["slides/b.html".to_string()].as_slice()));
		assert!(list[0].name.starts_with("s1x"));
		wipe(&dir);
	}

	#[test]
	fn names_must_be_plain() {
		assert!(plain("s1").is_ok() && plain("t1abc").is_ok());
		for bad in ["", "../x", "s 1", "a/b", "한"] {
			assert!(plain(bad).is_err(), "{bad}");
		}
	}

	#[test]
	fn restore_keeps_author() {
		let dir = tmp("restore");
		let p = Path::new(&dir);
		std::fs::write(p.join("a.txt"), "1").unwrap();
		let v1 = vcs_commit(dir.clone(), "v1".into(), Some("민수".into())).unwrap().unwrap();
		std::fs::write(p.join("a.txt"), "2").unwrap();
		std::fs::write(p.join("b.txt"), "new").unwrap();
		vcs_commit(dir.clone(), "v2".into(), Some("은지".into())).unwrap();
		let r = vcs_restore(dir.clone(), v1.hash.clone(), "back".into(), Some("지호".into())).unwrap().unwrap();
		assert_eq!(r.author, "지호");
		assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "1");
		assert!(!p.join("b.txt").exists());
		// 잠금 파일이 남지 않는다
		assert!(!p.join(".git").join("claudeppt-commit.lock").exists());
		let _ = std::fs::remove_dir_all(p);
	}


	/// 저장소 설정에 훅 · 서명 표시 · 색을 켜 두어도 (사용자 전역 설정과 같은 효과) 판 남기기 · 판 목록이 그대로 된다
	#[test]
	fn user_git_config_does_not_leak_in() {
		let dir = tmp("isolate");
		let p = Path::new(&dir);
		vcs_init(dir.clone()).unwrap();
		let hooks = p.join(".git").join("hooks");
		std::fs::create_dir_all(&hooks).unwrap();
		std::fs::write(hooks.join("pre-commit"), "#!/bin/sh\necho blocked >&2\nexit 1\n").unwrap();
		std::fs::write(hooks.join("commit-msg"), "#!/bin/sh\nexit 1\n").unwrap();
		for (k, v) in [("core.hooksPath", ".git/hooks"), ("log.showSignature", "true"), ("color.ui", "always"), ("core.fsmonitor", "true")] {
			let ok = Command::new("git").current_dir(p).args(["config", k, v]).status().unwrap().success();
			assert!(ok, "git config {k}");
		}
		std::fs::write(p.join("a.txt"), "1").unwrap();
		let c = vcs_commit(dir.clone(), "첫 판".into(), None).unwrap().expect("훅이 판 남기기를 막았다");
		assert_eq!((c.n, c.subject.as_str()), (1, "첫 판"));
		std::fs::write(p.join("a.txt"), "2").unwrap();
		vcs_commit(dir.clone(), "둘째 판".into(), None).unwrap().unwrap();
		vcs_tag(dir.clone(), "r1".into()).unwrap();
		let log = vcs_log(dir.clone(), None).unwrap();
		assert_eq!(log.iter().map(|c| (c.n, c.subject.as_str())).collect::<Vec<_>>(), [(2, "둘째 판"), (1, "첫 판")]);
		assert_eq!(log[0].tags, ["r1"]);
		assert_eq!(log[0].hash.len(), 40);
		let r = vcs_restore(dir.clone(), log[1].hash.clone(), "v1 로".into(), None).unwrap().unwrap();
		assert_eq!(r.n, 3);
		assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "1");
		let _ = std::fs::remove_dir_all(p);
	}
}
