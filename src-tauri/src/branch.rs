// 갈래 — 시안(본안에 손대지 않고 따로 해 보는 줄) · 사본(덱째 떼어 간 것) · 변경 그래프.
// git 을 몰라도 되는 말로 git 의 갈래 · clone 을 그대로 쓴다 — 앱 밖 git 으로 열어도 같은 것이 보인다 (2026.11.27).
//
//   본안    덱의 본 줄 (git main). 모두가 보는 덱이다
//   변경    본안 · 시안에 쌓이는 하나하나 (git 커밋). 2026.11.27 전에는 「판 v<n>」이라 불렀다 — 고칠 때마다 판이 올라가 판이 뜻을 잃었다
//   시안    git 갈래 cppt/sian/<id> 와 그 작업 폴더(앱 데이터 sian/<덱 지문>/<id>). 작업 폴더는 그대로 덱이라
//           앱에서 열어 Claude 에 요청하고 손으로 고친다. 이름 · 만든 이는 갈래 설명(git config branch.<갈래>.description · cpptBy)
//   넣기    시안을 본안에 합친다 (git merge --no-ff). 겹치면 본안은 그대로 두고 겹친 파일을 알린다.
//           「본안 받기」는 거꾸로 본안의 변경을 시안에 합친다 — 오래 해 온 시안을 넣기 전에 맞춰 본다
//   치우기  시안 · 보류를 버리면 지우지 않고 cppt/old/ 로 옮긴다 — 목록에서 사라질 뿐 git 으로 되살린다
//   사본    덱을 통째로 떼어 간 다른 덱 (git clone). 원본과 이력이 이어져 있어 사본의 변경을 원본의 시안으로 보내고(push),
//           원본에서 사본 폴더(다른 PC 에서 받은 .cppt 를 푼 것도)를 시안으로 가져온다(fetch)
//   그래프  본안 · 시안 · 보류의 변경을 한 그림에 — 누가 어느 줄에서 무엇을 했는지 (화면 VersionGraph)

use crate::vcs::{OLD, Commit, commit_all, git, git_dir, head, lock, plain, run, vcs_init};
use crate::{Res, err};
use serde::Serialize;
use std::path::{Path, PathBuf};

const SIAN: &str = "cppt/sian/";
const HOLD: &str = "cppt/hold/";

fn new_id() -> String {
	uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

/// 본안 갈래 — 덱 폴더(본 작업 폴더)가 쥔 갈래. 보통 main
fn main_branch(main: &Path) -> String {
	run(main, &["symbolic-ref", "--short", "-q", "HEAD"]).unwrap_or_else(|_| "main".into())
}

fn sian_dir(main: &Path, id: &str) -> Res<PathBuf> {
	let deck = crate::invite::hash(&main.to_string_lossy().to_lowercase());
	Ok(crate::control::data_dir().join("sian").join(&deck[..16]).join(plain(id)?))
}

/// 시안 이름 · 사람 이름 — 한 줄로, 너무 길지 않게
fn clean(s: &str) -> String {
	s.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(60).collect()
}

fn conf(main: &Path, id: &str, key: &str) -> Option<String> {
	run(main, &["config", "--get", &format!("branch.{SIAN}{id}.{key}")]).ok().filter(|s| !s.is_empty())
}

#[derive(Serialize)]
pub struct Where {
	/// 본 덱 폴더 — 시안 폴더면 그 시안이 나온 덱
	main: String,
	/// 이 폴더가 시안이면 그 id · 이름
	sian: Option<String>,
	name: Option<String>,
	/// 사본이면 원본 덱 폴더 (git remote origin)
	origin: Option<String>,
}

/// 이 폴더는 어느 덱의 어느 줄인가
#[tauri::command(async)]
pub fn vcs_where(dir: String) -> Res<Where> {
	let d = Path::new(&dir);
	let common = run(d, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
	let main = Path::new(common.trim()).parent().ok_or("덱 폴더를 찾지 못했다")?.to_path_buf();
	let sian = run(d, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().and_then(|b| b.strip_prefix(SIAN).map(String::from));
	let name = sian.as_deref().and_then(|id| conf(&main, id, "description"));
	let origin = run(&main, &["remote", "get-url", "origin"]).ok().filter(|s| !s.is_empty());
	Ok(Where { main: main.to_string_lossy().into(), sian, name, origin })
}

#[derive(Serialize)]
pub struct Sian {
	id: String,
	name: String,
	/// 만든 사람
	by: String,
	hash: String,
	/// 마지막 변경 때
	date: String,
	/// 본안에 없는 이 시안의 변경 수 · 이 시안이 받지 않은 본안의 변경 수
	ahead: u32,
	behind: u32,
	/// 열어 둔 작업 폴더 — 없으면 아직 열지 않았다(사본에서 보내 온 시안)
	path: Option<String>,
}

/// 갈래 → 그 갈래를 쥔 작업 폴더 (git worktree list)
fn worktrees(main: &Path) -> Vec<(String, String)> {
	let mut out = vec![];
	let mut cur: Option<String> = None;
	for l in run(main, &["worktree", "list", "--porcelain"]).unwrap_or_default().lines() {
		if let Some(p) = l.strip_prefix("worktree ") {
			cur = Some(p.to_string());
		} else if let (Some(b), Some(p)) = (l.strip_prefix("branch refs/heads/"), cur.as_ref()) {
			out.push((b.to_string(), p.clone()));
		}
	}
	out
}

fn sian_of(main: &Path, id: &str, wt: &[(String, String)]) -> Res<Sian> {
	let b = format!("{SIAN}{}", plain(id)?);
	let line = run(main, &["log", "-1", "--format=%H%x09%ci", &b])?;
	let (hash, date) = line.split_once('\t').unwrap_or((&line, ""));
	let counts = run(main, &["rev-list", "--left-right", "--count", &format!("{}...{b}", main_branch(main))]).unwrap_or_default();
	let mut c = counts.split_whitespace().map(|x| x.parse::<u32>().unwrap_or(0));
	let (behind, ahead) = (c.next().unwrap_or(0), c.next().unwrap_or(0));
	Ok(Sian {
		id: id.to_string(),
		name: conf(main, id, "description").unwrap_or_else(|| id.to_string()),
		by: conf(main, id, "cpptBy").unwrap_or_default(),
		hash: hash.to_string(),
		date: date.get(..16).unwrap_or("").to_string(),
		ahead,
		behind,
		path: wt.iter().find(|(x, _)| *x == b).map(|(_, p)| p.clone()),
	})
}

/// 시안 목록 — 새것부터
#[tauri::command(async)]
pub fn vcs_sians(dir: String) -> Res<Vec<Sian>> {
	let d = Path::new(&dir);
	if !d.join(".git").exists() {
		return Ok(vec![]);
	}
	let wt = worktrees(d);
	let refs = run(d, &["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", &format!("refs/heads/{SIAN}")])?;
	Ok(refs.lines().filter_map(|r| r.strip_prefix(SIAN)).filter_map(|id| sian_of(d, id, &wt).ok()).collect())
}

/// 시안을 만든다 — from(변경 하나)에서, 없으면 본안의 지금에서. 작업 폴더까지 열어 돌려준다
#[tauri::command(async)]
pub fn vcs_sian_new(dir: String, name: String, by: Option<String>, from: Option<String>) -> Res<Sian> {
	vcs_init(dir.clone())?;
	let d = Path::new(&dir);
	if let Some(f) = from.as_deref() {
		if !f.chars().all(|c| c.is_ascii_hexdigit()) {
			return Err("변경이 맞지 않다".into());
		}
	}
	let id = new_id();
	let b = format!("{SIAN}{id}");
	{
		let _l = lock(d)?;
		commit_all(d, "남아 있던 변경", None)?;
		run(d, &["branch", &b, from.as_deref().unwrap_or("HEAD")])?;
	}
	let name = clean(&name);
	run(d, &["config", &format!("branch.{b}.description"), if name.is_empty() { &id } else { &name }])?;
	if let Some(by) = by.map(|x| clean(&x)).filter(|x| !x.is_empty()) {
		run(d, &["config", &format!("branch.{b}.cpptBy"), &by])?;
	}
	vcs_sian_open(dir.clone(), id.clone())?;
	sian_of(d, &id, &worktrees(d))
}

/// 시안의 작업 폴더 — 없으면 연다 (사본이 보내 온 시안 · 지운 폴더)
#[tauri::command(async)]
pub fn vcs_sian_open(dir: String, id: String) -> Res<String> {
	let d = Path::new(&dir);
	let b = format!("{SIAN}{}", plain(&id)?);
	if let Some((_, p)) = worktrees(d).into_iter().find(|(x, p)| *x == b && Path::new(p).join("deck.json").is_file()) {
		return Ok(p);
	}
	let p = sian_dir(d, &id)?;
	// 지우는 곳은 앱 데이터 안 시안 자리뿐이다
	let _ = std::fs::remove_dir_all(&p);
	let _ = run(d, &["worktree", "prune"]);
	std::fs::create_dir_all(p.parent().unwrap()).map_err(err)?;
	run(d, &["worktree", "add", "-q", &p.to_string_lossy(), &b])?;
	Ok(p.to_string_lossy().into())
}

#[derive(Serialize)]
pub struct Merged {
	/// 합쳤다 (겹치지 않았다)
	ok: bool,
	/// 새로 생긴 변경 — 이미 다 들어가 있었으면 없다
	commit: Option<Commit>,
	conflicts: Vec<String>,
}

/// 겹친 곳을 어느 쪽 것으로 — "ours"(받는 쪽) · "theirs"(들어오는 쪽). 사람이 겹친 것을 보고 고른 때만 준다
fn prefer_arg(prefer: Option<&str>) -> Res<Option<&'static str>> {
	match prefer {
		None => Ok(None),
		Some("ours") => Ok(Some("-Xours")),
		Some("theirs") => Ok(Some("-Xtheirs")),
		Some(x) => Err(format!("고를 수 없는 쪽: {x}")),
	}
}

/// other 를 into 작업 폴더에 합친다. 겹치면 into 는 그대로 두고 겹친 파일을 돌려준다.
/// prefer 를 주면 겹친 곳만 그쪽 것으로 하고 합친다 — 겹치지 않은 곳은 양쪽이 다 남는다
fn merge_into(into: &Path, other: &str, message: &str, author: Option<&str>, prefer: Option<&str>) -> Res<Merged> {
	let x = prefer_arg(prefer)?;
	let _l = lock(into)?;
	commit_all(into, "남아 있던 변경", None)?;
	let before = run(into, &["rev-parse", "HEAD"])?;
	let mut c = git(into);
	if let Some(a) = author.map(clean).filter(|a| !a.is_empty()) {
		c.env("GIT_AUTHOR_NAME", a.replace(['<', '>'], "")).env("GIT_AUTHOR_EMAIL", "member@claudeppt");
	}
	c.args(["merge", "--no-ff", "--no-edit", "-m", message]);
	if let Some(x) = x {
		c.arg(x);
	}
	let o = c.arg(other).output().map_err(err)?;
	if o.status.success() {
		let changed = run(into, &["rev-parse", "HEAD"])? != before;
		return Ok(Merged { ok: true, commit: if changed { head(into).ok() } else { None }, conflicts: vec![] });
	}
	let conflicts: Vec<String> = run(into, &["diff", "--name-only", "--diff-filter=U"]).unwrap_or_default().lines().map(String::from).collect();
	if git_dir(into).join("MERGE_HEAD").exists() {
		run(into, &["merge", "--abort"])?;
	}
	let why = String::from_utf8_lossy(&o.stderr).trim().to_string();
	Ok(Merged { ok: false, commit: None, conflicts: if conflicts.is_empty() { vec![why] } else { conflicts } })
}

/// 시안을 본안에 넣는다 — 시안 폴더에 판으로 남지 않은 것이 있으면 먼저 남겨 함께 넣는다
#[tauri::command(async)]
pub fn vcs_sian_merge(dir: String, id: String, message: String, author: Option<String>, prefer: Option<String>) -> Res<Merged> {
	let d = Path::new(&dir);
	let b = format!("{SIAN}{}", plain(&id)?);
	if let Some((_, p)) = worktrees(d).into_iter().find(|(x, _)| *x == b) {
		let p = Path::new(&p);
		let _l = lock(p)?;
		commit_all(p, "시안에 남아 있던 변경", None)?;
	}
	merge_into(d, &b, &message, author.as_deref(), prefer.as_deref())
}

/// 본안의 변경을 시안에 받는다
#[tauri::command(async)]
pub fn vcs_sian_update(dir: String, id: String, author: Option<String>, prefer: Option<String>) -> Res<Merged> {
	let d = Path::new(&dir);
	let p = PathBuf::from(vcs_sian_open(dir.clone(), id)?);
	merge_into(&p, &main_branch(d), "본안의 변경을 받음", author.as_deref(), prefer.as_deref())
}

/// 시안을 치운다 — 작업 폴더를 닫고 갈래를 cppt/old/ 로 옮긴다 (지우지 않는다)
#[tauri::command(async)]
pub fn vcs_sian_drop(dir: String, id: String) -> Res<()> {
	let d = Path::new(&dir);
	let id = plain(&id)?.to_string();
	let b = format!("{SIAN}{id}");
	if let Some((_, p)) = worktrees(d).into_iter().find(|(x, _)| *x == b) {
		// 남은 것은 판으로 남겨 함께 치운다
		let pp = Path::new(&p);
		if let Ok(_l) = lock(pp) {
			let _ = commit_all(pp, "시안에 남아 있던 변경", None);
		}
		let _ = run(d, &["worktree", "remove", "--force", &p]);
	}
	let _ = std::fs::remove_dir_all(sian_dir(d, &id)?);
	let _ = run(d, &["worktree", "prune"]);
	run(d, &["branch", "-M", &b, &format!("{OLD}sian-{id}")]).map(|_| ())
}

// ── 그래프 ──

#[derive(Serialize)]
pub struct Node {
	hash: String,
	short: String,
	parents: Vec<String>,
	author: String,
	date: String,
	subject: String,
	tags: Vec<String>,
}

/// 줄 하나의 끝 — main(본안) · sian · hold
#[derive(Serialize)]
pub struct Head {
	kind: &'static str,
	id: String,
	name: String,
	hash: String,
}

#[derive(Serialize)]
pub struct Graph {
	/// 새것부터, 부모보다 늘 위 (topo-order)
	nodes: Vec<Node>,
	heads: Vec<Head>,
}

/// 본안 · 시안 · 보류의 변경 그래프 — 치운 것(cppt/old)과 턴의 작업 사본(떠 있는 HEAD)은 뺀다
#[tauri::command(async)]
pub fn vcs_graph(dir: String, limit: Option<u32>) -> Res<Graph> {
	let d = Path::new(&dir);
	if run(d, &["rev-parse", "--verify", "-q", "HEAD"]).is_err() {
		return Ok(Graph { nodes: vec![], heads: vec![] });
	}
	let main = main_branch(d);
	let mut heads = vec![Head { kind: "main", id: main.clone(), name: main.clone(), hash: run(d, &["rev-parse", &main])? }];
	for line in run(d, &["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads/cppt/"])?.lines() {
		let Some((r, h)) = line.split_once('\t') else { continue };
		if let Some(id) = r.strip_prefix(SIAN) {
			heads.push(Head { kind: "sian", id: id.into(), name: conf(d, id, "description").unwrap_or_else(|| id.into()), hash: h.into() });
		} else if let Some(id) = r.strip_prefix(HOLD) {
			let subject = run(d, &["log", "-1", "--format=%s", h]).unwrap_or_default();
			heads.push(Head { kind: "hold", id: id.into(), name: subject, hash: h.into() });
		}
	}
	let mut tags: std::collections::HashMap<String, Vec<String>> = Default::default();
	for line in run(d, &["show-ref", "--tags"]).unwrap_or_default().lines() {
		if let Some((h, r)) = line.split_once(' ') {
			tags.entry(h.to_string()).or_default().push(r.trim_start_matches("refs/tags/").to_string());
		}
	}
	let n = format!("-{}", limit.unwrap_or(300).min(2000));
	let mut args = vec!["log", "--topo-order", &n, "--format=%H%x09%h%x09%P%x09%an%x09%ci%x09%s"];
	let hs: Vec<String> = heads.iter().map(|h| h.hash.clone()).collect();
	args.extend(hs.iter().map(String::as_str));
	let nodes = run(d, &args)?
		.lines()
		.filter_map(|l| {
			let mut p = l.splitn(6, '\t');
			let hash = p.next()?.to_string();
			Some(Node {
				short: p.next()?.to_string(),
				parents: p.next()?.split_whitespace().map(String::from).collect(),
				author: p.next()?.to_string(),
				date: p.next()?.get(..16)?.to_string(),
				subject: p.next().unwrap_or("").to_string(),
				tags: tags.remove(&hash).unwrap_or_default(),
				hash,
			})
		})
		.collect();
	Ok(Graph { nodes, heads })
}

// ── 사본 ──

/// 덱을 사본으로 떼어 간다 — dest 는 없거나 빈 폴더. 판으로 남지 않은 것이 있으면 먼저 남긴다(사본에 들게)
#[tauri::command(async)]
pub fn vcs_fork(dir: String, dest: String) -> Res<()> {
	let d = Path::new(&dir);
	let to = Path::new(&dest);
	if to.exists() && std::fs::read_dir(to).map_err(err)?.next().is_some() {
		return Err("사본을 둘 폴더가 비어 있지 않다".into());
	}
	{
		let _l = lock(d)?;
		commit_all(d, "남아 있던 변경", None)?;
	}
	// 윈도의 canonicalize 는 \\?\C:\… 꼴을 준다 — git 이 그 앞머리를 호스트 이름으로 읽어 원본 주소가 깨진다(보내기 실패)
	let src = std::fs::canonicalize(d).map_err(err)?;
	let src = src.to_string_lossy();
	let src = src.strip_prefix(r"\\?\").unwrap_or(&src).to_string();
	let parent = to.parent().ok_or("사본 자리가 맞지 않다")?;
	std::fs::create_dir_all(parent).map_err(err)?;
	run(parent, &["clone", "-q", "--no-hardlinks", &src, &to.to_string_lossy()]).map(|_| ())
}

/// 사본의 변경을 원본 덱의 시안으로 보낸다 — 같은 PC 에 원본 덱이 있을 때. 없으면 CPPT 로 보내 원본에서 가져온다
#[tauri::command(async)]
pub fn vcs_fork_send(dir: String, name: String, by: Option<String>) -> Res<String> {
	let d = Path::new(&dir);
	let origin = run(d, &["remote", "get-url", "origin"]).map_err(|_| "원본을 모르는 덱이다 (사본이 아니다)".to_string())?;
	let o = Path::new(origin.trim());
	if !o.join(".git").exists() {
		return Err("원본 덱을 이 PC 에서 찾지 못했다. CPPT 로 보내 원본에서 「사본에서 가져오기」로 받는다".into());
	}
	{
		let _l = lock(d)?;
		commit_all(d, "남아 있던 변경", None)?;
	}
	let id = new_id();
	let b = format!("{SIAN}{id}");
	run(d, &["push", "-q", "origin", &format!("HEAD:refs/heads/{b}")])?;
	name_sian(o, &b, &name, by.as_deref(), &id)?;
	Ok(id)
}

fn name_sian(main: &Path, b: &str, name: &str, by: Option<&str>, id: &str) -> Res<()> {
	let name = clean(name);
	run(main, &["config", &format!("branch.{b}.description"), if name.is_empty() { id } else { &name }])?;
	if let Some(by) = by.map(clean).filter(|x| !x.is_empty()) {
		run(main, &["config", &format!("branch.{b}.cpptBy"), &by])?;
	}
	Ok(())
}

/// 사본 폴더의 변경을 이 덱의 시안으로 가져온다 — 이력이 이어지지 않은 덱(사본이 아닌 덱)이면 받지 않는다
#[tauri::command(async)]
pub fn vcs_fork_fetch(dir: String, from: String, name: String, by: Option<String>) -> Res<Sian> {
	let d = Path::new(&dir);
	let f = Path::new(&from);
	if !f.join(".git").exists() || !f.join("deck.json").is_file() {
		return Err("덱 폴더가 아니다".into());
	}
	let id = new_id();
	let b = format!("{SIAN}{id}");
	run(d, &["fetch", "-q", "--no-tags", &f.to_string_lossy(), &format!("HEAD:refs/heads/{b}")])?;
	if run(d, &["merge-base", &main_branch(d), &b]).is_err() {
		let _ = run(d, &["branch", "-D", &b]);
		return Err("이 덱과 이력이 이어지지 않은 덱이다 — 이 덱에서 떼어 간 사본만 가져온다".into());
	}
	name_sian(d, &b, &name, by.as_deref(), &id)?;
	sian_of(d, &id, &worktrees(d))
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::vcs::vcs_commit;

	fn deck(name: &str) -> String {
		let d = std::env::temp_dir().join(format!("cppt-branch-{name}-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&d);
		std::fs::create_dir_all(d.join("slides")).unwrap();
		std::fs::write(d.join("deck.json"), "{}").unwrap();
		std::fs::write(d.join("slides/a.html"), "a1\na2\na3\na4\na5\n").unwrap();
		let dir = d.to_string_lossy().to_string();
		vcs_commit(dir.clone(), "첫 변경".into(), None).unwrap();
		dir
	}
	fn wipe(dir: &str, ids: &[&str]) {
		for id in ids {
			let _ = std::fs::remove_dir_all(sian_dir(Path::new(dir), id).unwrap());
		}
		let _ = std::fs::remove_dir_all(dir);
	}
	fn put(dir: &str, text: &str) {
		std::fs::write(Path::new(dir).join("slides/a.html"), text).unwrap();
	}
	fn read(dir: &str) -> String {
		std::fs::read_to_string(Path::new(dir).join("slides/a.html")).unwrap()
	}

	#[test]
	fn sian_is_a_deck_that_merges_back() {
		let dir = deck("sian");
		let s = vcs_sian_new(dir.clone(), " 표지\nA안 ".into(), Some("민수".into()), None).unwrap();
		assert_eq!((s.name.as_str(), s.by.as_str(), s.ahead, s.behind), ("표지 A안", "민수", 0, 0));
		let p = s.path.clone().unwrap();
		// 시안 폴더는 그대로 덱 — 판 남기기(잠금 · 커밋)가 된다
		put(&p, "A1\na2\na3\na4\na5\n");
		vcs_commit(p.clone(), "시안에서 고침".into(), Some("민수".into())).unwrap().unwrap();
		let w = vcs_where(p.clone()).unwrap();
		assert_eq!((w.sian.as_deref(), w.name.as_deref()), (Some(s.id.as_str()), Some("표지 A안")));
		assert_eq!(std::fs::canonicalize(&w.main).unwrap(), std::fs::canonicalize(&dir).unwrap());
		assert_eq!(vcs_where(dir.clone()).unwrap().sian, None);
		// 그사이 본안은 다른 줄을 고쳤다 — 겹치지 않으니 둘 다 남는다
		put(&dir, "a1\na2\na3\na4\nA5\n");
		vcs_commit(dir.clone(), "본안에서 고침".into(), None).unwrap();
		let l = vcs_sians(dir.clone()).unwrap();
		assert_eq!((l.len(), l[0].ahead, l[0].behind), (1, 1, 1));
		let m = vcs_sian_merge(dir.clone(), s.id.clone(), "시안 「표지 A안」 넣음".into(), Some("은지".into()), None).unwrap();
		assert!(m.ok && m.commit.as_ref().unwrap().author == "은지");
		assert_eq!(read(&dir), "A1\na2\na3\na4\nA5\n");
		// 본안의 변경 번호는 본 줄만 센다 — 시안의 변경은 「넣음」 하나
		let log = crate::vcs::vcs_log(dir.clone(), None).unwrap();
		assert_eq!(log.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["시안 「표지 A안」 넣음", "본안에서 고침", "첫 변경"]);
		assert_eq!(log[0].n, 3);
		// 그래프에는 시안의 변경과 합친 자리(부모 둘)가 보인다
		let g = vcs_graph(dir.clone(), None).unwrap();
		assert!(g.nodes.iter().any(|n| n.subject == "시안에서 고침"));
		assert_eq!(g.nodes[0].parents.len(), 2);
		assert!(g.heads.iter().any(|h| h.kind == "sian" && h.name == "표지 A안"));
		// 치우면 목록 · 그래프에서 빠지지만 갈래는 남는다
		vcs_sian_drop(dir.clone(), s.id.clone()).unwrap();
		assert!(vcs_sians(dir.clone()).unwrap().is_empty());
		assert!(!vcs_graph(dir.clone(), None).unwrap().heads.iter().any(|h| h.kind == "sian"));
		assert!(run(Path::new(&dir), &["rev-parse", "--verify", &format!("{OLD}sian-{}", s.id)]).is_ok());
		wipe(&dir, &[&s.id]);
	}

	#[test]
	fn overlapping_sian_leaves_main_alone() {
		let dir = deck("clash");
		let s = vcs_sian_new(dir.clone(), "B안".into(), None, None).unwrap();
		let p = s.path.clone().unwrap();
		put(&p, "a1\n시안\na3\na4\na5\n");
		vcs_commit(p.clone(), "시안".into(), None).unwrap();
		put(&dir, "a1\n본안\na3\na4\na5\n");
		vcs_commit(dir.clone(), "본안".into(), None).unwrap();
		let m = vcs_sian_merge(dir.clone(), s.id.clone(), "넣음".into(), None, None).unwrap();
		assert!(!m.ok);
		assert_eq!(m.conflicts, ["slides/a.html"]);
		assert_eq!(read(&dir), "a1\n본안\na3\na4\na5\n");
		assert!(!git_dir(Path::new(&dir)).join("MERGE_HEAD").exists());
		assert!(run(Path::new(&dir), &["status", "--porcelain"]).unwrap().is_empty());
		// 본안 받기도 겹치면 시안은 그대로
		let u = vcs_sian_update(dir.clone(), s.id.clone(), None, None).unwrap();
		assert!(!u.ok);
		assert_eq!(read(&p), "a1\n시안\na3\na4\na5\n");
		// 사람이 고르면 겹친 곳만 그쪽 것으로 합친다 — 겹치지 않은 시안의 변경은 남는다
		put(&p, "a1\n시안\na3\na4\n시안5\n");
		vcs_commit(p.clone(), "시안 둘째".into(), None).unwrap();
		let m = vcs_sian_merge(dir.clone(), s.id.clone(), "넣음".into(), None, Some("theirs".into())).unwrap();
		assert!(m.ok);
		assert_eq!(read(&dir), "a1\n시안\na3\na4\n시안5\n");
		assert!(vcs_sian_merge(dir.clone(), s.id.clone(), "넣음".into(), None, Some("-s evil".into())).is_err());
		wipe(&dir, &[&s.id]);
	}

	#[test]
	fn fork_sends_back_as_sian_and_strangers_are_refused() {
		let dir = deck("fork");
		let fork = format!("{dir}-사본");
		let _ = std::fs::remove_dir_all(&fork);
		vcs_fork(dir.clone(), fork.clone()).unwrap();
		assert_eq!(read(&fork), "a1\na2\na3\na4\na5\n");
		put(&fork, "a1\na2\n사본\na4\na5\n");
		vcs_commit(fork.clone(), "사본에서 고침".into(), Some("지호".into())).unwrap();
		assert!(vcs_where(fork.clone()).unwrap().origin.is_some() && vcs_where(dir.clone()).unwrap().origin.is_none());
		let id = vcs_fork_send(fork.clone(), "지호 제안".into(), Some("지호".into())).unwrap();
		let l = vcs_sians(dir.clone()).unwrap();
		assert_eq!((l.len(), l[0].id.as_str(), l[0].name.as_str(), l[0].ahead, l[0].path.is_none()), (1, id.as_str(), "지호 제안", 1, true));
		// 가져오기도 된다 (다른 PC 에서 받은 사본) · 이력이 이어지지 않은 덱은 받지 않는다
		let s2 = vcs_fork_fetch(dir.clone(), fork.clone(), "가져온 것".into(), None).unwrap();
		assert_eq!(s2.ahead, 1);
		let stranger = deck("stranger");
		assert!(vcs_fork_fetch(dir.clone(), stranger.clone(), "남".into(), None).is_err());
		assert_eq!(vcs_sians(dir.clone()).unwrap().len(), 2);
		// 보내 온 시안을 열면 작업 폴더가 생긴다
		let p = vcs_sian_open(dir.clone(), id.clone()).unwrap();
		assert_eq!(read(&p), "a1\na2\n사본\na4\na5\n");
		assert!(vcs_fork(dir.clone(), fork.clone()).is_err(), "빈 폴더가 아니면 받지 않는다");
		wipe(&dir, &[&id, &s2.id]);
		let _ = std::fs::remove_dir_all(&fork);
		let _ = std::fs::remove_dir_all(&stranger);
	}
}
