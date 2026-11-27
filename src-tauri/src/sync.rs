// 묶음 파일 · 제안 · 참여 요청 · 공유 폴더 우편함 (2026.11.27) : 분산 협업 2단계 (design/분산 협업).
// 서버 없이 사본끼리 변경을 넘긴다. 통로는 사람이 고른다: 메신저 · 메일 · USB 로 파일을 건네거나, 모두가 보는 공유 폴더(우편함)에 둔다.
// 누가 어떤 통로로 들고 오든 받는 쪽이 같은 검증(trust.rs)을 지나므로, 통로를 믿을 필요가 없다.
//
// 목차
//   꼴        Prop(제안) · Join(참여 요청) : 서명한 JSON 하나를 담은 커밋. 제안 커밋의 부모가 제안한 끝이라 ref 하나로 내용까지 딸려 온다
//   제안      make_prop(내 줄이 승인된 줄기보다 앞서 있으면 제안을 새로 쓴다) · read_prop · check_prop
//   묶음      export(git bundle: 사슬 · 승인된 줄기 · 제안 · 참여 요청) · import(격리 자리에 받고 검증한 것만 옮긴다)
//   줄기 받기  catch_up : 승인된 줄기를 내 줄(main)에 합친다. 승인자면 합친 것을 봉한다
//   승인      approve : 남의 제안을 내 줄에 합치고 그 제안을 적어 봉한다
//   우편함    mailbox_run : 바뀐 것이 있으면 내보내고, 남이 둔 묶음 중 안 본 것을 들인다
//   앱 명령   sync_status · sync_export · sync_import · sync_approve · sync_join · sync_admit · sync_mailbox_set · sync_mailbox_run · sync_open
//
// 덱 폴더의 main 은 「내 줄」이다. 승인된 줄기는 refs/cppt/trunk 다. 승인자는 판을 남길 때마다 저절로 승인하므로 둘이 늘 같고,
// 승인자가 아닌 사람의 main 은 줄기보다 앞서 있다(그 차이가 그 사람의 제안이다).
// 2026.11.27 : 설계 문서는 덱 폴더를 cppt/mine 으로 옮긴다고 했다. 그러면 판 목록 · 그래프 · 가지가 모두 흔들려, 이름만 그대로 두고 뜻을 나눴다

use crate::trust::{self, CHAIN, Git, Repo, Role, State, TRUNK};
use crate::{Res, err, vcs};
use iroh::{PublicKey, SecretKey, Signature};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const PROPS: &str = "refs/cppt/props/";
const JOINS: &str = "refs/cppt/join/";
/// 마지막으로 내보낸 ref 들 : 다음 묶음은 이것 뒤의 것만 담는다(증분). 이름은 원래 ref 에서 refs/cppt/ 를 뗀 것
const SENT: &str = "refs/cppt/sent/";
/// 손으로 내보낸 묶음 파일(sync_export)의 바탕 : 우편함(SENT)과 나눈다.
/// 2026.11.27 : 처음에는 같이 썼다. 한 사람에게 메일로 보낸 묶음이 바탕을 옮기면, 우편함 묶음이 그 사람만 가진 커밋을 빼고 만들어져
///              우편함만 보는 사람은 영영 들이지 못했다
const SENT_FILE: &str = "refs/cppt/sent-file/";
/// 앱끼리 상대에게 내준 ref 들 (peers.rs) : 「이 PC 에만 있음」을 가리는 데만 쓴다. 우편함의 증분 바탕(SENT)과 섞으면
/// 우편함만 보는 사람이 받지 못한 커밋을 빼고 보내게 된다
const GIVEN: &str = "refs/cppt/given/";
/// 받은 묶음을 검증하기 전에 두는 자리 : 검증을 지난 것만 제자리로 옮기고 지운다
const INBOX: &str = "refs/cppt/in/";
const PROP_FILE: &str = "prop.json";
const JOIN_FILE: &str = "join.json";
/// 앞선 묶음을 아직 받지 않아 들일 수 없다 : 우편함은 다음 차례에 다시 해 본다
pub const MISSING: &str = "앞선 묶음 파일을 먼저 들여야 한다";

// ── 꼴 ──

/// 제안 : 승인자가 아닌 사람(또는 「다른 승인자 확인 받기」를 켠 승인자)의 줄이 승인된 줄기보다 앞선 만큼
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Prop {
	pub v: u32,
	pub deck: String,
	/// 제안한 사람의 열쇠
	pub by: String,
	/// 한 사람의 제안 줄 이름 : 지금은 늘 main (그 사람의 줄 하나)
	pub id: String,
	/// 같은 줄의 몇 번째 제안인가 : 큰 것이 새것이다. 묶음이 늦게 도착해도 옛 제안이 새것을 덮지 않게
	pub seq: u64,
	/// 제안한 끝 커밋 (제안 커밋의 부모)
	pub tip: String,
	pub at: String,
	#[serde(default)]
	pub sig: String,
}

/// 참여 요청 : 묶음으로 덱을 처음 받은 사람이 자기 열쇠를 명부에 넣어 달라고 낸다
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Join {
	pub v: u32,
	pub deck: String,
	pub key: String,
	pub name: String,
	pub at: String,
	#[serde(default)]
	pub sig: String,
}

fn bytes_of(domain: &str, v: &impl Serialize) -> Vec<u8> {
	let mut j = serde_json::to_value(v).unwrap();
	j.as_object_mut().unwrap().shift_remove("sig");
	let mut s = domain.to_string();
	trust::canon(&j, &mut s);
	s.into_bytes()
}

fn sign_with(domain: &str, v: &impl Serialize, k: &SecretKey) -> String {
	base64::Engine::encode(&base64::engine::general_purpose::STANDARD, k.sign(&bytes_of(domain, v)).to_bytes())
}

fn check(domain: &str, v: &impl Serialize, key: &str, sig: &str) -> bool {
	let Ok(pk) = PublicKey::from_z32(key) else { return false };
	let Some(b) = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, sig).ok().and_then(|b| <[u8; 64]>::try_from(b).ok()) else { return false };
	pk.verify(&bytes_of(domain, v), &Signature::from_bytes(&b)).is_ok()
}

const PROP_DOMAIN: &str = "claudeppt/prop/1\n";
const JOIN_DOMAIN: &str = "claudeppt/join/1\n";

/// JSON 하나를 담은 커밋을 만든다. parent 를 주면 그 커밋을 부모로 (제안 : 내용이 ref 에 딸려 오게)
fn write_obj(d: &Path, file: &str, json: &str, parent: Option<&str>, msg: &str) -> Res<String> {
	let blob = trust::git_in(d, &["hash-object", "-w", "--stdin"], json.as_bytes())?;
	let tree = trust::git_in(d, &["mktree"], format!("100644 blob {blob}\t{file}\n").as_bytes())?;
	let mut args = vec!["commit-tree", tree.as_str(), "-m", msg];
	if let Some(p) = parent {
		args.extend(["-p", p]);
	}
	vcs::run(d, &args)
}

fn read_obj<T: for<'a> Deserialize<'a>>(d: &Path, r: &str, file: &str) -> Option<T> {
	let t = vcs::run(d, &["show", &format!("{r}:{file}")]).ok()?;
	serde_json::from_str(&t).ok()
}

/// ref 이름에 쓸 열쇠 : z32 52자. 다른 글자가 섞인 것은 받지 않는다
fn key_ok(k: &str) -> bool {
	k.len() == 52 && k.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) && PublicKey::from_z32(k).is_ok()
}

fn refs(d: &Path, prefix: &str) -> Vec<(String, String)> {
	vcs::run(d, &["for-each-ref", "--format=%(refname) %(objectname)", prefix])
		.unwrap_or_default()
		.lines()
		.filter_map(|l| l.split_once(' ').map(|(a, b)| (a.to_string(), b.to_string())))
		.collect()
}

fn rev(d: &Path, r: &str) -> Option<String> {
	vcs::run(d, &["rev-parse", "--verify", "-q", r]).ok()
}

// ── 제안 ──

fn prop_ref(key: &str, id: &str) -> String {
	format!("{PROPS}{key}/{id}")
}

pub fn read_prop(d: &Path, r: &str) -> Option<Prop> {
	read_obj(d, r, PROP_FILE)
}

/// 제안이 이 덱 · 이 명부에서 맞는가 : 서명 · 덱 · 고칠 권한 · 제안 커밋의 부모가 tip
fn check_prop(d: &Path, st: &State, commit: &str, p: &Prop) -> Result<(), String> {
	if p.v != 1 || p.deck != st.deck {
		return Err("다른 덱의 제안".into());
	}
	if !check(PROP_DOMAIN, p, &p.by, &p.sig) {
		return Err("제안의 서명이 맞지 않는다".into());
	}
	let who = st.roster.person_of(&p.by).ok_or("명부에 없는 사람의 제안")?;
	if matches!(who.role, Role::Comment | Role::View) {
		return Err("고칠 권한이 없는 사람의 제안".into());
	}
	if rev(d, &format!("{commit}^")).as_deref() != Some(p.tip.as_str()) {
		return Err("제안 커밋이 제안한 끝을 가리키지 않는다".into());
	}
	Ok(())
}

/// 내 줄이 승인된 줄기보다 앞서 있으면 제안을 새로 쓴다. 승인자가 자기 것을 바로 봉하는 덱이면 쓰지 않는다
fn make_prop(d: &Path, st: &State) -> Res<()> {
	let k = trust::my_key();
	let me = trust::key_id(&k);
	let Some(p) = st.roster.person_of(&me) else { return Ok(()) };
	if matches!(p.role, Role::Comment | Role::View) || (p.role == Role::Approve && !st.roster.review) {
		return Ok(());
	}
	let Some(main) = rev(d, "HEAD") else { return Ok(()) };
	if Git(d).is_ancestor(&main, &st.head) {
		return Ok(());
	}
	let r = prop_ref(&me, "main");
	let old = read_prop(d, &r);
	if old.as_ref().is_some_and(|o| o.tip == main && o.deck == st.deck) {
		return Ok(());
	}
	let mut prop = Prop { v: 1, deck: st.deck.clone(), by: me, id: "main".into(), seq: old.map(|o| o.seq + 1).unwrap_or(1), tip: main.clone(), at: trust::now(), sig: String::new() };
	prop.sig = sign_with(PROP_DOMAIN, &prop, &k);
	let c = write_obj(d, PROP_FILE, &serde_json::to_string_pretty(&prop).map_err(err)?, Some(&main), "제안")?;
	vcs::run(d, &["update-ref", &r, &c]).map(|_| ())
}

// ── 묶음 ──

#[derive(Serialize, Deserialize, Default)]
struct SentNote {
	at: String,
	path: String,
}

fn note_file(d: &Path) -> PathBuf {
	vcs::git_dir(d).join("claudeppt-sent.json")
}

/// 묶음을 쓴다. full 이면 처음 받는 사람용(전 이력), 아니면 지난번 내보낸 뒤의 것만. 보낼 것이 없으면 None
fn export(d: &Path, out: &Path, full: bool, base: &str) -> Res<Option<PathBuf>> {
	let _l = vcs::lock(d)?;
	vcs::commit_all(d, "남아 있던 변경", None)?;
	trust::seal(d);
	let st = trust::load(d)?.ok_or("이 덱에는 아직 승인 기록이 없다")?;
	make_prop(d, &st)?;
	let names = names(d);
	let sent = refs(d, base);
	let changed = full || names.iter().any(|r| {
		let now = rev(d, r);
		let then = sent.iter().find(|(s, _)| s.strip_prefix(base) == r.strip_prefix("refs/cppt/")).map(|(_, h)| h.clone());
		now != then
	});
	if !changed {
		return Ok(None);
	}
	let not: Vec<String> = if full { vec![] } else { sent.iter().map(|(_, h)| h.clone()).collect() };
	if !write_bundle(d, &names, &not, out)? {
		return Ok(None);
	}
	for r in &names {
		if let (Some(h), Some(tail)) = (rev(d, r), r.strip_prefix("refs/cppt/")) {
			vcs::run(d, &["update-ref", &format!("{base}{tail}"), &h])?;
		}
	}
	let _ = std::fs::write(note_file(d), serde_json::to_string(&SentNote { at: trust::now(), path: out.to_string_lossy().into() }).unwrap_or_default());
	Ok(Some(out.to_path_buf()))
}

/// 묶음에 담는 ref : 사슬 · 승인된 줄기 · 제안 · 참여 요청
fn names(d: &Path) -> Vec<String> {
	let mut names = vec![CHAIN.to_string()];
	if rev(d, TRUNK).is_some() {
		names.push(TRUNK.into());
	}
	names.extend(refs(d, PROPS).into_iter().map(|(r, _)| r));
	names.extend(refs(d, JOINS).into_iter().map(|(r, _)| r));
	names.extend(refs(d, trust::PENDING).into_iter().map(|(r, _)| r));
	names
}

/// 묶음을 쓴다 : not 의 커밋은 받는 쪽에 있다고 보고 뺀다. 새로 담을 커밋이 없으면 쓰지 않고 false.
/// 다 쓴 뒤에 이름을 바꾼다 : 공유 폴더에서 반쯤 쓴 파일을 남이 읽지 않게
fn write_bundle(d: &Path, names: &[String], not: &[String], out: &Path) -> Res<bool> {
	// 빈 묶음인지는 git 의 오류 글이 아니라 개수로 본다(git 이 한국어로 말하면 글이 달라진다)
	let mut count_args: Vec<&str> = vec!["rev-list", "--count"];
	count_args.extend(names.iter().map(String::as_str));
	if !not.is_empty() {
		count_args.push("--not");
		count_args.extend(not.iter().map(String::as_str));
	}
	if vcs::run(d, &count_args)?.trim() == "0" {
		return Ok(false);
	}
	if let Some(p) = out.parent() {
		std::fs::create_dir_all(p).map_err(err)?;
	}
	let part = out.with_extension("part");
	let p = part.to_string_lossy().to_string();
	let mut args: Vec<&str> = vec!["bundle", "create", "-q", &p];
	args.extend(names.iter().map(String::as_str));
	if !not.is_empty() {
		args.push("--not");
		args.extend(not.iter().map(String::as_str));
	}
	if let Err(e) = vcs::run(d, &args) {
		let _ = std::fs::remove_file(&part);
		return Err(e);
	}
	std::fs::rename(&part, out).map_err(err)?;
	Ok(true)
}

// ── 앱끼리 (3단계, peers.rs) ──
// 켜져 있는 명부 사람에게 iroh 로 「내가 가진 것」(haves)을 보내면, 상대는 그 뒤의 것만 담은 묶음을 흘려 보낸다.
// 받은 묶음은 파일로 받은 것과 같은 import 를 지난다 : 검증이 하나라 통로가 늘어도 구멍이 늘지 않는다

/// 내가 가진 끝들 : 상대가 묶음에서 뺄 것
pub(crate) fn haves(d: &Path) -> Vec<String> {
	let mut out: Vec<String> = refs(d, "refs/cppt/").into_iter().filter(|(r, _)| ![INBOX, SENT, SENT_FILE, GIVEN].iter().any(|p| r.starts_with(p))).map(|(_, h)| h).collect();
	out.extend(rev(d, "HEAD"));
	out.sort();
	out.dedup();
	out
}

/// 상대(key)에게 줄 묶음을 쓴다. 상대가 이 덱의 명부에서 사본을 받는 사람이 아니면 Err. 줄 것이 없으면 false
pub(crate) fn serve_bundle(d: &Path, key: &str, haves: &[String], out: &Path) -> Res<bool> {
	let st = trust::load(d)?.ok_or("승인 기록이 없는 덱")?;
	if !st.roster.person_of(key).is_some_and(|p| p.replica) {
		return Err("명부에 없는 사람".into());
	}
	{
		// 내 최신 제안까지 실어 보낸다. 덱 폴더에 판으로 남지 않은 것은 건드리지 않는다(남의 요청 때문에 내 손 편집을 판으로 끊지 않게)
		let _l = vcs::lock(d)?;
		make_prop(d, &st)?;
	}
	let not: Vec<String> = haves.iter().filter(|h| h.len() == 40 && h.chars().all(|c| c.is_ascii_hexdigit()) && vcs::run(d, &["cat-file", "-e", &format!("{h}^{{commit}}")]).is_ok()).cloned().collect();
	let names = names(d);
	let made = write_bundle(d, &names, &not, out)?;
	// 줄 것이 없었으면 상대가 이미 다 가졌다. 줄 것이 있었으면 상대가 다 받아 들였다고 알려 올 때(acknowledge) 적는다
	// 2026.11.27 : 처음에는 묶음을 쓰자마자 적었다. 보내다 끊겨도 「이 PC 에만 있음」 경고와 창 닫기 붙잡기가 꺼졌다
	if !made {
		mark_given(d, &names, haves);
	}
	Ok(made)
}

/// 상대가 가진 끝(haves) 중 내 ref 와 같거나 그 뒤인 것이 있으면 「다른 PC 에도 있음」으로 적는다
fn mark_given(d: &Path, names: &[String], haves: &[String]) {
	let known: Vec<&String> = haves.iter().filter(|h| h.len() == 40 && h.chars().all(|c| c.is_ascii_hexdigit()) && vcs::run(d, &["cat-file", "-e", &format!("{h}^{{commit}}")]).is_ok()).collect();
	for r in names {
		let (Some(v), Some(tail)) = (rev(d, r), r.strip_prefix("refs/cppt/")) else { continue };
		if known.iter().any(|h| **h == v || Git(d).is_ancestor(&v, h)) {
			let _ = vcs::run(d, &["update-ref", &format!("{GIVEN}{tail}"), &v]);
		}
	}
}

/// 상대가 묶음을 받아 들인 뒤 알려 온 끝들 : 이제 그 PC 에도 있는 것을 적는다
pub(crate) fn acknowledge(d: &Path, key: &str, haves: &[String]) -> Res<()> {
	let st = trust::load(d)?.ok_or("승인 기록이 없는 덱")?;
	if !st.roster.person_of(key).is_some_and(|p| p.replica) {
		return Err("명부에 없는 사람".into());
	}
	mark_given(d, &names(d), haves);
	Ok(())
}

/// 사본을 주고받을 사람의 열쇠 : 명부에서 사본을 받는 사람 모두(같은 사람의 다른 기기 포함), 이 앱 열쇠만 빼고
pub(crate) fn peers_of(d: &Path) -> Vec<String> {
	let me = trust::key_id(&trust::my_key());
	let Ok(Some(st)) = trust::load(d) else { return vec![] };
	st.roster.people.iter().filter(|p| p.replica).flat_map(|p| p.keys.iter().cloned()).filter(|k| *k != me).collect()
}

/// 덱 id → 덱 폴더 : 상대가 덱 id 로 물으면 이것으로 찾는다. 덱을 열 때마다 적는다 (앱 데이터 sync-decks.json)
fn registry_file() -> PathBuf {
	#[cfg(test)]
	return std::env::temp_dir().join(format!("cppt-test-sync-decks-{}.json", std::process::id()));
	#[cfg(not(test))]
	crate::control::data_dir().join("sync-decks.json")
}

pub(crate) fn register(d: &Path) -> Option<String> {
	let st = trust::load(d).ok()??;
	let mut m: std::collections::BTreeMap<String, String> = std::fs::read_to_string(registry_file()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
	let dir = d.to_string_lossy().to_string();
	if m.get(&st.deck) != Some(&dir) {
		m.insert(st.deck.clone(), dir);
		let _ = std::fs::write(registry_file(), serde_json::to_string_pretty(&m).unwrap_or_default());
	}
	Some(st.deck)
}

pub(crate) fn deck_dir(deck: &str) -> Option<PathBuf> {
	let m: std::collections::BTreeMap<String, String> = std::fs::read_to_string(registry_file()).ok().and_then(|t| serde_json::from_str(&t).ok())?;
	let p = PathBuf::from(m.get(deck)?);
	// 옮겼거나 지운 덱 · 다른 덱이 그 자리에 생긴 경우를 거른다
	(trust::load(&p).ok()??.deck == deck).then_some(p)
}

#[derive(Serialize, Default, Debug)]
pub struct Imported {
	/// 받은 사슬과 내 사슬의 사이 : none · same · ahead · behind · diverged · foreign · invalid
	pub(crate) chain: &'static str,
	/// 받은 사슬을 내 것으로 삼았나
	pub(crate) adopted: bool,
	pub(crate) props: usize,
	pub(crate) joins: usize,
	/// 승인된 줄기를 내 줄에 합치다 겹친 파일 : 비어 있으면 합쳤다
	pub(crate) conflicts: Vec<String>,
}

/// 묶음 머리에 적힌 선행 커밋 : 이 묶음을 들이려면 받는 쪽에 있어야 하는 것. 머리는 빈 줄까지다 (git bundle 꼴 v2 · v3)
fn prerequisites(file: &Path) -> Res<Vec<String>> {
	use std::io::BufRead;
	const NL: u8 = 10;
	let f =std::fs::File::open(file).map_err(|e| format!("묶음 파일을 열지 못했다: {e}"))?;
	let mut r = std::io::BufReader::new(f);
	let mut first = vec![];
	r.read_until(NL, &mut first).map_err(err)?;
	if !first.starts_with(b"# v2 git bundle") && !first.starts_with(b"# v3 git bundle") {
		return Err("묶음 파일이 아니다".into());
	}
	let mut out = vec![];
	loop {
		let mut line = vec![];
		if r.read_until(NL, &mut line).map_err(err)? == 0 || line == [NL] {
			break;
		}
		if let Some(rest) = line.strip_prefix(b"-") {
			let sha: String = String::from_utf8_lossy(rest).chars().take_while(|c| c.is_ascii_hexdigit()).collect();
			if sha.len() >= 40 {
				out.push(sha);
			}
		}
	}
	Ok(out)
}

/// 묶음 하나를 들인다
pub(crate) fn import(d: &Path, file: &Path) -> Res<Imported> {
	let f = file.to_string_lossy().to_string();
	// 앞선 묶음이 빠졌는지는 git 의 오류 글로 가리지 않는다(git 이 한국어로 말하면 글이 달라진다) : 묶음 머리의 선행 커밋을 직접 본다
	if prerequisites(file)?.iter().any(|c| vcs::run(d, &["cat-file", "-e", &format!("{c}^{{commit}}")]).is_err()) {
		return Err(MISSING.into());
	}
	if let Err(e) = vcs::run(d, &["bundle", "verify", "-q", &f]) {
		return Err(format!("묶음 파일을 읽지 못했다: {e}"));
	}
	let tag = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
	let inbox = format!("{INBOX}{tag}/");
	let mut got = Imported::default();
	let r = (|| -> Res<()> {
		vcs::run(d, &["fetch", "-q", "--no-tags", &f, &format!("+refs/cppt/*:{inbox}*")])?;
		let _l = vcs::lock(d)?;
		// 사슬 : 받은 것이 내 것을 이어 가거나, 갈라졌는데 규칙으로 저쪽이 이기면 저쪽을 삼는다
		let theirs_ref = format!("{inbox}chain");
		got.chain = "none";
		if rev(d, &theirs_ref).is_some() {
			let theirs = trust::read_chain(d, &theirs_ref)?;
			let tv = trust::verify(&theirs, &Git(d));
			got.chain = "invalid";
			if tv.bad.is_none() && !theirs.is_empty() {
				let mine = trust::read_chain(d, CHAIN)?;
				let rel = if mine.is_empty() { trust::Relation::Behind } else { trust::relate(&mine, &theirs, &Git(d)) };
				got.chain = match rel {
					trust::Relation::Same => "same",
					trust::Relation::Ahead => "ahead",
					trust::Relation::Behind => "behind",
					trust::Relation::Diverged { .. } => "diverged",
					trust::Relation::Foreign => "foreign",
				};
				let take = matches!(rel, trust::Relation::Behind | trust::Relation::Diverged { winner: trust::Side::Theirs, .. });
				if take {
					let c = rev(d, &theirs_ref).unwrap();
					vcs::run(d, &["update-ref", CHAIN, &c])?;
					let _ = std::fs::remove_file(vcs::git_dir(d).join("claudeppt-chain.json"));
					trust::load(d)?;
					got.adopted = true;
				}
			}
		}
		// 제안 · 참여 요청은 이 덱의 지금 명부로 검증한다. 사슬이 다른 덱이면 아무것도 받지 않는다
		let Some(st) = trust::load(d)?.filter(|_| !matches!(got.chain, "foreign" | "invalid")) else { return Ok(()) };
		// 내 참여 요청이 받아들여졌으면 걷는다 : 다음 묶음에 다시 실려 가지 않게
		let me = trust::key_id(&trust::my_key());
		if st.roster.person_of(&me).is_some() {
			let _ = vcs::run(d, &["update-ref", "-d", &format!("{JOINS}{me}")]);
		}
		for (r, c) in refs(d, &format!("{inbox}props/")) {
			let Some(tail) = r.strip_prefix(&format!("{inbox}props/")) else { continue };
			let Some((key, id)) = tail.split_once('/') else { continue };
			if !key_ok(key) || vcs::plain(id).is_err() {
				continue;
			}
			let Some(p) = read_prop(d, &c) else { continue };
			if p.by != key || p.id != id || check_prop(d, &st, &c, &p).is_err() {
				continue;
			}
			let mine = prop_ref(key, id);
			if read_prop(d, &mine).is_some_and(|o| o.seq >= p.seq) {
				continue;
			}
			vcs::run(d, &["update-ref", &mine, &c])?;
			got.props += 1;
		}
		// 서명 대기 명부 판 : 내 것과 서명을 합친다. 과반이 되면 여기서 사슬에 붙는다
		for (_, c) in refs(d, &format!("{inbox}pending/")) {
			if let Some(e) = vcs::run(d, &["show", &format!("{c}:entry.json")]).ok().and_then(|t| serde_json::from_str::<trust::Entry>(&t).ok()) {
				trust::merge_pending(d, &e)?;
			}
		}
		let st = trust::load(d)?.unwrap_or(st);
		for (r, c) in refs(d, &format!("{inbox}join/")) {
			let Some(key) = r.strip_prefix(&format!("{inbox}join/")) else { continue };
			if !key_ok(key) || st.roster.person_of(key).is_some() {
				continue;
			}
			let Some(j) = read_obj::<Join>(d, &c, JOIN_FILE) else { continue };
			if j.v != 1 || j.key != key || j.deck != st.deck || !check(JOIN_DOMAIN, &j, &j.key, &j.sig) {
				continue;
			}
			vcs::run(d, &["update-ref", &format!("{JOINS}{key}"), &c])?;
			got.joins += 1;
		}
		Ok(())
	})();
	for (x, _) in refs(d, &inbox) {
		let _ = vcs::run(d, &["update-ref", "-d", &x]);
	}
	r?;
	got.conflicts = catch_up(d)?;
	Ok(got)
}

/// 승인된 줄기를 내 줄(main)에 합친다. 겹치면 내 줄은 그대로 두고 겹친 파일을 돌려준다. 승인자면 합친 것을 봉한다
fn catch_up(d: &Path) -> Res<Vec<String>> {
	let Some(trunk) = rev(d, TRUNK) else { return Ok(vec![]) };
	let Some(main) = rev(d, "HEAD") else {
		// 묶음으로 처음 받은 덱 : 내 줄을 줄기에서 시작한다
		let _l = vcs::lock(d)?;
		vcs::run(d, &["update-ref", "refs/heads/main", &trunk])?;
		vcs::run(d, &["reset", "-q", "--hard", "main"])?;
		return Ok(vec![]);
	};
	if Git(d).is_ancestor(&trunk, &main) {
		return Ok(vec![]);
	}
	{
		let _l = vcs::lock(d)?;
		vcs::commit_all(d, "남아 있던 변경", None)?;
		let main = rev(d, "HEAD").unwrap_or(main);
		if Git(d).is_ancestor(&main, &trunk) {
			vcs::run(d, &["merge", "-q", "--ff-only", &trunk])?;
			trust::seal(d);
			return Ok(vec![]);
		}
	}
	let m = crate::branch::merge_into(d, &trunk, "승인된 줄기를 받음", None, None)?;
	let _l = vcs::lock(d)?;
	trust::seal(d);
	Ok(if m.ok { vec![] } else { m.conflicts })
}

/// 남의 제안을 승인한다 : 승인된 줄기를 먼저 받고, 제안을 내 줄에 합친 뒤 그 제안을 적어 봉한다
fn approve(d: &Path, key: &str, id: &str) -> Res<Vec<String>> {
	if !key_ok(key) {
		return Err("제안을 찾지 못했다".into());
	}
	let r = prop_ref(key, vcs::plain(id)?);
	let c = rev(d, &r).ok_or("제안을 찾지 못했다")?;
	let p = read_prop(d, &r).ok_or("제안을 읽지 못했다")?;
	let st = trust::load(d)?.ok_or("이 덱에는 아직 승인 기록이 없다")?;
	check_prop(d, &st, &c, &p)?;
	let me = trust::key_id(&trust::my_key());
	if st.roster.person_of(&me).is_none_or(|x| x.role != Role::Approve) {
		return Err("이 PC 는 이 덱의 승인자가 아니다".into());
	}
	if Git(d).is_ancestor(&p.tip, &st.head) {
		return Err("이미 줄기에 들어간 제안이다".into());
	}
	// 승인된 줄기 위에서 따로(작업 폴더 하나를 잠깐 열어) 합친다. 내 줄(main)에 합치면 내가 아직 승인받지 않은 변경
	// (「다른 승인자 확인 받기」를 켠 덱)이 남의 제안에 묻어 줄기에 들어간다
	let name = st.roster.person_of(&p.by).map(|x| x.name.clone()).unwrap_or_default();
	let wt = crate::control::data_dir().join("approve").join(uuid::Uuid::new_v4().simple().to_string());
	std::fs::create_dir_all(wt.parent().unwrap()).map_err(err)?;
	vcs::run(d, &["worktree", "add", "-q", "--detach", &wt.to_string_lossy(), &st.head])?;
	let merged = (|| -> Res<Result<String, Vec<String>>> {
		let o = vcs::git(&wt)
			.env("GIT_AUTHOR_NAME", name.replace(['<', '>'], ""))
			.env("GIT_AUTHOR_EMAIL", "member@claudeppt")
			.args(["merge", "--no-ff", "--no-edit", "-m", &format!("{name} 의 제안을 승인함"), &p.tip])
			.output()
			.map_err(err)?;
		if o.status.success() {
			return Ok(Ok(vcs::run(&wt, &["rev-parse", "HEAD"])?));
		}
		let files: Vec<String> = vcs::run(&wt, &["diff", "--name-only", "--diff-filter=U"]).unwrap_or_default().lines().map(String::from).collect();
		let _ = vcs::run(&wt, &["merge", "--abort"]);
		Ok(Err(if files.is_empty() { vec![String::from_utf8_lossy(&o.stderr).trim().to_string()] } else { files }))
	})();
	let _ = vcs::run(d, &["worktree", "remove", "--force", &wt.to_string_lossy()]);
	let _ = std::fs::remove_dir_all(&wt);
	let head = match merged? {
		Ok(h) => h,
		Err(files) => return Ok(files),
	};
	{
		let _l = vcs::lock(d)?;
		trust::approve_at(d, &head, trust::Proposal { by: p.by.clone(), id: p.id.clone(), tip: p.tip.clone() })?;
	}
	// 승인된 줄기를 내 줄에도 : 겹치면 내 줄은 그대로 두고 한 줄 경고(줄기를 아직 합치지 못함)로 남는다
	let _ = catch_up(d)?;
	Ok(vec![])
}

// ── 우편함 ──
// 모두가 보는 폴더(OneDrive · 사내 공유 폴더) 하나. 덱마다 <폴더>/<덱 id 앞 12자>/ 에 보낸 사람 · 때마다 새 파일을 쓴다.
// 한 파일을 여럿이 고치면 동기화 도구가 충돌 사본을 만들고 자리 표시 파일 문제가 생긴다 : 그래서 쓴 파일은 다시 고치지 않고,
// 다 쓴 뒤 이름을 바꾸고, 읽는 쪽은 읽음 표시를 그 폴더에 쓰지 않는다(.git 안에 둔다)

#[derive(Serialize, Deserialize, Default)]
struct MailboxConf {
	dir: Option<String>,
}

fn conf_file(d: &Path) -> PathBuf {
	d.join(".claudeppt").join("mailbox.json")
}

fn mailbox(d: &Path) -> Option<PathBuf> {
	let c: MailboxConf = std::fs::read_to_string(conf_file(d)).ok().and_then(|t| serde_json::from_str(&t).ok())?;
	c.dir.map(PathBuf::from)
}

fn seen_file(d: &Path) -> PathBuf {
	vcs::git_dir(d).join("claudeppt-mailbox-seen.json")
}

#[derive(Serialize, Default, Debug)]
pub struct Ran {
	sent: Option<String>,
	received: usize,
	/// 앞선 묶음을 기다리는 파일 수
	waiting: usize,
	errors: Vec<String>,
	conflicts: Vec<String>,
}

fn mailbox_run(d: &Path) -> Res<Ran> {
	let root = mailbox(d).ok_or("우편함 폴더를 정하지 않았다")?;
	let st = trust::load(d)?.ok_or("이 덱에는 아직 승인 기록이 없다")?;
	let folder = root.join(&st.deck[..12]);
	std::fs::create_dir_all(&folder).map_err(|e| format!("우편함 폴더를 열지 못했다: {e}"))?;
	let me = trust::key_id(&trust::my_key());
	let mine = &me[..12];
	let mut ran = Ran::default();
	let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
	let name = format!("{mine}-{stamp}-{}.cpptb", &uuid::Uuid::new_v4().simple().to_string()[..4]);
	ran.sent = export(d, &folder.join(name), false, SENT)?.map(|p| p.to_string_lossy().into());
	let mut book: Seen = std::fs::read_to_string(seen_file(d)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
	let seen = &mut book.seen;
	let mut todo: Vec<String> = std::fs::read_dir(&folder)
		.map_err(err)?
		.filter_map(|e| e.ok()?.file_name().into_string().ok())
		.filter(|n| n.ends_with(".cpptb") && !n.starts_with(mine) && !seen.contains(n))
		.collect();
	todo.sort();
	// 앞선 묶음이 다른 사람 파일에 있을 수 있다 : 한 바퀴에 하나라도 들어가면 남은 것을 다시 돈다
	loop {
		let mut progress = false;
		let mut left = vec![];
		for n in todo {
			match import(d, &folder.join(&n)) {
				Ok(r) => {
					ran.received += 1;
					ran.conflicts.extend(r.conflicts);
					seen.push(n);
					progress = true;
				}
				Err(e) if e == MISSING => left.push(n),
				// 클라우드 자리 표시 파일 · 동기화 중 잠긴 파일은 다음 차례에 읽힌다 : 열 번까지 다시 해 보고 그 뒤에 넘긴다.
				// 2026.11.27 : 처음에는 한 번 실패하면 넘겼다. 그러면 그 사람의 다음 묶음들이 모두 앞선 묶음을 기다리며 멈췄다
				Err(e) => {
					let t = book.tries.entry(n.clone()).or_insert(0);
					*t += 1;
					if *t >= 10 {
						ran.errors.push(format!("{n}: {e}"));
						seen.push(n);
					}
				}
			}
		}
		todo = left;
		if !progress || todo.is_empty() {
			break;
		}
	}
	ran.waiting = todo.len();
	book.tries.retain(|n, _| !book.seen.contains(n));
	let _ = std::fs::write(seen_file(d), serde_json::to_string(&book).unwrap_or_default());
	Ok(ran)
}

/// 우편함에서 읽은 파일 · 읽다 실패한 횟수
#[derive(Serialize, Default)]
struct Seen {
	seen: Vec<String>,
	tries: std::collections::BTreeMap<String, u32>,
}

impl<'de> Deserialize<'de> for Seen {
	/// 처음 꼴(파일 이름 목록)도 읽는다
	fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
		#[derive(Deserialize)]
		#[serde(untagged)]
		enum Any {
			Old(Vec<String>),
			New { seen: Vec<String>, #[serde(default)] tries: std::collections::BTreeMap<String, u32> },
		}
		Ok(match Any::deserialize(d)? {
			Any::Old(seen) => Seen { seen, tries: Default::default() },
			Any::New { seen, tries } => Seen { seen, tries },
		})
	}
}

/// 같은 덱을 두 번 겹쳐 주고받지 않는다 : 1분 주고받기가 앞 차례(꺼진 팀원 기다리기 · 큰 묶음)가 끝나기 전에 다시 돌 수 있다
static BUSY: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

pub(crate) struct Busy(String);

impl Drop for Busy {
	fn drop(&mut self) {
		BUSY.lock().unwrap().retain(|x| *x != self.0);
	}
}

/// 이 덱을 주고받는 중이 아니면 표를 받는다
pub(crate) fn busy(d: &Path) -> Option<Busy> {
	let k = d.to_string_lossy().to_lowercase();
	let mut b = BUSY.lock().unwrap();
	if b.contains(&k) {
		return None;
	}
	b.push(k.clone());
	Some(Busy(k))
}

// ── 앱 명령 ──

#[derive(Serialize)]
pub struct PropView {
	key: String,
	id: String,
	name: String,
	at: String,
	/// 줄기에 없는 변경 수
	ahead: u32,
	mine: bool,
}

#[derive(Serialize)]
pub struct JoinView {
	key: String,
	name: String,
	at: String,
}

#[derive(Serialize)]
pub struct Status {
	/// 이 PC 가 명부에 있나
	member: bool,
	approver: bool,
	/// 명부에서 사본을 주고받을 다른 사람(기기) 수 : 0 이면 혼자 쓰는 덱이라 「이 PC 에만 있음」을 따지지 않는다
	peers: usize,
	/// 내보내지 않은 것이 있다 (이 PC 에만 있다)
	pub(crate) unsent: bool,
	/// 마지막으로 내보낸 때 · 곳
	sent_at: Option<String>,
	sent_to: Option<String>,
	/// 내 줄이 승인된 줄기를 아직 품지 않았다 (받았는데 겹쳐 합치지 못했다)
	behind: bool,
	/// 내 줄 중 아직 승인받지 않은 변경 수
	pending: u32,
	props: Vec<PropView>,
	joins: Vec<JoinView>,
	mailbox: Option<String>,
}

fn count(d: &Path, range: &str) -> u32 {
	vcs::run(d, &["rev-list", "--count", range]).ok().and_then(|x| x.trim().parse().ok()).unwrap_or(0)
}

fn status(d: &Path) -> Res<Option<Status>> {
	let Some(st) = trust::load(d)? else { return Ok(None) };
	let me = trust::key_id(&trust::my_key());
	let who = st.roster.person_of(&me);
	let main = rev(d, "HEAD").unwrap_or_default();
	let behind = !main.is_empty() && !st.head.is_empty() && !Git(d).is_ancestor(&st.head, &main);
	let pending = if main.is_empty() { 0 } else { count(d, &format!("{}..{main}", st.head)) };
	// 이 PC 에만 있는 것 : 사슬이 보낸 뒤 바뀌었거나, 승인받지 않은 내 변경이 마지막으로 보낸 제안에 없다
	// 묶음 · 우편함으로 보냈거나(SENT) 켜져 있던 팀원이 받아 갔으면(GIVEN) 다른 PC 에도 있다
	let chain_now = rev(d, CHAIN);
	let chain_out = [SENT, SENT_FILE, GIVEN].iter().any(|b| rev(d, &format!("{b}chain")) == chain_now);
	let prop_out = [SENT, SENT_FILE, GIVEN].iter().any(|b| rev(d, &format!("{b}props/{me}/main")).is_some_and(|p| Git(d).is_ancestor(&main, &p)));
	let peers = peers_of(d).len();
	let unsent = peers > 0 && (!chain_out || (pending > 0 && who.is_some() && !prop_out));
	let note: Option<SentNote> = std::fs::read_to_string(note_file(d)).ok().and_then(|t| serde_json::from_str(&t).ok());
	let mut props = vec![];
	for (r, c) in refs(d, PROPS) {
		let Some(p) = read_prop(d, &r) else { continue };
		if check_prop(d, &st, &c, &p).is_err() || Git(d).is_ancestor(&p.tip, &st.head) {
			continue;
		}
		props.push(PropView { name: st.roster.person_of(&p.by).map(|x| x.name.clone()).unwrap_or_default(), ahead: count(d, &format!("{}..{}", st.head, p.tip)), mine: p.by == me, key: p.by, id: p.id, at: p.at });
	}
	let joins = refs(d, JOINS)
		.into_iter()
		.filter_map(|(_, c)| read_obj::<Join>(d, &c, JOIN_FILE))
		.filter(|j| st.roster.person_of(&j.key).is_none())
		.map(|j| JoinView { key: j.key, name: j.name, at: j.at })
		.collect();
	Ok(Some(Status {
		peers,
		member: who.is_some(),
		approver: who.is_some_and(|p| p.role == Role::Approve),
		unsent,
		sent_at: note.as_ref().map(|n| n.at.clone()),
		sent_to: note.map(|n| n.path),
		behind,
		pending,
		props,
		joins,
		mailbox: mailbox(d).map(|p| p.to_string_lossy().into()),
	}))
}

#[tauri::command(async)]
pub fn sync_status(dir: String) -> Res<Option<Status>> {
	let d = Path::new(&dir);
	if !trust::is_main_checkout(d) {
		return Ok(None);
	}
	status(d)
}

/// 묶음 파일로 내보낸다. 보낼 것이 없으면 None
#[tauri::command(async)]
pub fn sync_export(dir: String, out: String, full: bool) -> Res<Option<String>> {
	Ok(export(Path::new(&dir), Path::new(&out), full, SENT_FILE)?.map(|p| p.to_string_lossy().into()))
}

#[tauri::command(async)]
pub fn sync_import(dir: String, file: String) -> Res<Imported> {
	import(Path::new(&dir), Path::new(&file))
}

/// 제안을 승인한다. 겹치면 겹친 파일을 돌려준다(내 줄은 그대로)
#[tauri::command(async)]
pub fn sync_approve(dir: String, key: String, id: String) -> Res<Vec<String>> {
	approve(Path::new(&dir), &key, &id)
}

/// 참여 요청을 만든다 : 다음 묶음에 실려 간다
#[tauri::command(async)]
pub fn sync_join(dir: String, name: String) -> Res<()> {
	let d = Path::new(&dir);
	let st = trust::load(d)?.ok_or("이 덱에는 아직 승인 기록이 없다")?;
	let k = trust::my_key();
	let key = trust::key_id(&k);
	if st.roster.person_of(&key).is_some() {
		return Err("이 PC 는 이미 명부에 있다".into());
	}
	let name: String = name.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(40).collect();
	if name.is_empty() {
		return Err("이름이 비었다".into());
	}
	let mut j = Join { v: 1, deck: st.deck.clone(), key: key.clone(), name, at: trust::now(), sig: String::new() };
	j.sig = sign_with(JOIN_DOMAIN, &j, &k);
	let c = write_obj(d, JOIN_FILE, &serde_json::to_string_pretty(&j).map_err(err)?, None, "참여 요청")?;
	vcs::run(d, &["update-ref", &format!("{JOINS}{key}"), &c]).map(|_| ())
}

/// 참여 요청을 받아 명부에 넣는다
#[tauri::command(async)]
pub fn sync_admit(dir: String, key: String, role: Role) -> Res<()> {
	let d = Path::new(&dir);
	if !key_ok(&key) {
		return Err("참여 요청을 찾지 못했다".into());
	}
	let c = rev(d, &format!("{JOINS}{key}")).ok_or("참여 요청을 찾지 못했다")?;
	let j = read_obj::<Join>(d, &c, JOIN_FILE).ok_or("참여 요청을 읽지 못했다")?;
	if j.key != key || !check(JOIN_DOMAIN, &j, &j.key, &j.sig) {
		return Err("참여 요청의 서명이 맞지 않는다".into());
	}
	trust::change(d, &trust::my_key(), |r| {
		if r.person_of(&key).is_some() {
			return Err("이미 명부에 있다".into());
		}
		r.people.push(trust::Person { id: uuid::Uuid::new_v4().simple().to_string()[..8].to_string(), name: j.name.clone(), keys: vec![key.clone()], role, slides: vec![], replica: true });
		Ok(())
	})?;
	let _ = vcs::run(d, &["update-ref", "-d", &format!("{JOINS}{key}")]);
	Ok(())
}

/// 우편함 폴더를 정한다 (None 이면 끈다)
#[tauri::command(async)]
pub fn sync_mailbox_set(dir: String, folder: Option<String>) -> Res<()> {
	let d = Path::new(&dir);
	let p = conf_file(d);
	std::fs::create_dir_all(p.parent().unwrap()).map_err(err)?;
	std::fs::write(p, serde_json::to_string(&MailboxConf { dir: folder.filter(|f| !f.trim().is_empty()) }).map_err(err)?).map_err(err)
}

#[tauri::command(async)]
pub fn sync_mailbox_run(dir: String) -> Res<Ran> {
	let d = Path::new(&dir);
	let Some(_b) = busy(d) else { return Ok(Ran::default()) };
	mailbox_run(d)
}

/// 묶음 파일로 덱을 처음 받는다 : dest 는 없거나 빈 폴더
#[tauri::command(async)]
pub fn sync_open(file: String, dest: String) -> Res<String> {
	let to = Path::new(&dest);
	if to.exists() && std::fs::read_dir(to).map_err(err)?.next().is_some() {
		return Err("덱을 둘 폴더가 비어 있지 않다".into());
	}
	std::fs::create_dir_all(to).map_err(err)?;
	let r = (|| -> Res<()> {
		vcs::run(to, &["init", "-q", "-b", "main"])?;
		let got = import(to, Path::new(&file))?;
		if !got.adopted {
			return Err("묶음 파일에 덱의 승인 기록이 없거나 맞지 않는다".into());
		}
		if !to.join("deck.json").is_file() {
			return Err("묶음 파일에 덱이 없다".into());
		}
		Ok(())
	})();
	if let Err(e) = r {
		let _ = std::fs::remove_dir_all(to);
		return Err(e);
	}
	Ok(to.to_string_lossy().into())
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::trust::TEST_KEY;
	use crate::vcs::vcs_commit;

	fn tmp(name: &str) -> PathBuf {
		let d = std::env::temp_dir().join(format!("cppt-sync-{name}-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&d);
		d
	}
	fn as_(n: u8) {
		TEST_KEY.with(|k| k.replace(SecretKey::from_bytes(&[n; 32])));
	}
	fn key(n: u8) -> String {
		trust::key_id(&SecretKey::from_bytes(&[n; 32]))
	}
	fn put(d: &Path, rel: &str, text: &str) {
		let p = d.join(rel);
		std::fs::create_dir_all(p.parent().unwrap()).unwrap();
		std::fs::write(p, text).unwrap();
		vcs_commit(d.to_string_lossy().into(), format!("{rel} 고침"), None).unwrap();
	}
	fn read(d: &Path, rel: &str) -> String {
		std::fs::read_to_string(d.join(rel)).unwrap_or_default()
	}
	fn s(p: &Path) -> String {
		p.to_string_lossy().into()
	}

	/// 승인자 가(1) 와 새 사람 나(2): 파일만으로 들어오고, 고치고, 승인받는다
	#[test]
	fn files_carry_a_new_member_from_join_to_approval() {
		let (a, b, box_) = (tmp("a"), tmp("b"), tmp("box"));
		std::fs::create_dir_all(&a).unwrap();
		as_(1);
		put(&a, "deck.json", "{}");
		put(&a, "slides/s1.html", "가 1");
		let f1 = box_.join("1.cpptb");
		assert!(sync_export(s(&a), s(&f1), true).unwrap().is_some());
		assert!(sync_export(s(&a), s(&box_.join("x.cpptb")), false).unwrap().is_none(), "바뀐 것이 없으면 보내지 않는다");

		// 나 : 묶음으로 덱을 받는다: 명부에 없다
		as_(2);
		sync_open(s(&f1), s(&b)).unwrap();
		assert_eq!(read(&b, "slides/s1.html"), "가 1");
		let st = status(&b).unwrap().unwrap();
		assert!(!st.member && !st.approver);
		sync_join(s(&b), "나".into()).unwrap();
		let f2 = box_.join("2.cpptb");
		sync_export(s(&b), s(&f2), false).unwrap().unwrap();

		// 가 : 참여 요청을 받아 편집 권한으로 넣는다
		as_(1);
		let got = sync_import(s(&a), s(&f2)).unwrap();
		assert_eq!((got.chain, got.joins), ("same", 1));
		assert_eq!(status(&a).unwrap().unwrap().joins.len(), 1);
		sync_admit(s(&a), key(2), Role::Edit).unwrap();
		assert!(status(&a).unwrap().unwrap().joins.is_empty());
		let f3 = box_.join("3.cpptb");
		sync_export(s(&a), s(&f3), false).unwrap().unwrap();

		// 나 : 명부에 들어갔다 · 고친 것은 승인 전까지 제안이다
		as_(2);
		let got = sync_import(s(&b), s(&f3)).unwrap();
		assert!(got.adopted && got.chain == "behind");
		put(&b, "slides/s2.html", "나 1");
		let st = status(&b).unwrap().unwrap();
		assert!(st.member && !st.approver && st.unsent && st.pending == 1);
		let f4 = box_.join("4.cpptb");
		sync_export(s(&b), s(&f4), false).unwrap().unwrap();
		assert!(!status(&b).unwrap().unwrap().unsent, "보낸 뒤에는 이 PC 에만 있는 것이 없다");

		// 가 : 그 사이 자기 것도 고쳤다 · 제안을 받아 승인한다
		as_(1);
		put(&a, "slides/s1.html", "가 2");
		assert_eq!(sync_import(s(&a), s(&f4)).unwrap().props, 1);
		let props = status(&a).unwrap().unwrap().props;
		assert_eq!((props.len(), props[0].name.as_str(), props[0].ahead), (1, "나", 1));
		assert!(sync_approve(s(&a), key(2), "main".into()).unwrap().is_empty());
		assert_eq!((read(&a, "slides/s1.html"), read(&a, "slides/s2.html")), ("가 2".into(), "나 1".into()));
		let st = status(&a).unwrap().unwrap();
		assert!(st.props.is_empty() && st.pending == 0);
		let chain = trust::read_chain(&a, CHAIN).unwrap();
		assert!(matches!(&chain.last().unwrap().body, trust::Body::Approve { proposal: Some(p), .. } if p.by == key(2)), "제안을 적어 봉했다");
		let f5 = box_.join("5.cpptb");
		sync_export(s(&a), s(&f5), false).unwrap().unwrap();

		// 나 : 승인된 줄기를 받는다
		as_(2);
		assert!(sync_import(s(&b), s(&f5)).unwrap().conflicts.is_empty());
		assert_eq!(read(&b, "slides/s1.html"), "가 2");
		let st = status(&b).unwrap().unwrap();
		assert!(st.pending == 0 && !st.behind);
		assert!(trust::verify(&trust::read_chain(&b, CHAIN).unwrap(), &Git(&b)).bad.is_none());

		as_(7);
		for p in [&a, &b, &box_] {
			let _ = std::fs::remove_dir_all(p);
		}
	}

	#[test]
	fn bundles_need_their_predecessors_and_forged_props_are_dropped() {
		let (a, b, box_) = (tmp("pa"), tmp("pb"), tmp("pbox"));
		std::fs::create_dir_all(&a).unwrap();
		as_(1);
		put(&a, "deck.json", "{}");
		let f1 = box_.join("1.cpptb");
		sync_export(s(&a), s(&f1), true).unwrap();
		put(&a, "a.txt", "1");
		let f2 = box_.join("2.cpptb");
		sync_export(s(&a), s(&f2), false).unwrap();
		put(&a, "a.txt", "2");
		let f3 = box_.join("3.cpptb");
		sync_export(s(&a), s(&f3), false).unwrap();
		// 3 만으로는 덱을 열지 못한다 · 1 로 열고 2 를 건너 3 을 들이면 기다린다
		as_(2);
		assert!(sync_open(s(&f3), s(&b)).is_err());
		assert!(!b.exists(), "실패하면 만든 폴더를 걷는다");
		sync_open(s(&f1), s(&b)).unwrap();
		assert_eq!(sync_import(s(&b), s(&f3)).unwrap_err(), MISSING);
		sync_import(s(&b), s(&f2)).unwrap();
		sync_import(s(&b), s(&f3)).unwrap();
		assert_eq!(read(&b, "a.txt"), "2");
		// 명부에 없는 사람(나)이 가의 이름으로 제안을 꾸민다: 서명이 맞지 않아 버려진다
		put(&b, "evil.txt", "x");
		let st = trust::load(&b).unwrap().unwrap();
		let tip = rev(&b, "HEAD").unwrap();
		let mut p = Prop { v: 1, deck: st.deck.clone(), by: key(1), id: "main".into(), seq: 9, tip: tip.clone(), at: "t".into(), sig: String::new() };
		p.sig = sign_with(PROP_DOMAIN, &p, &SecretKey::from_bytes(&[2; 32]));
		let c = write_obj(&b, PROP_FILE, &serde_json::to_string(&p).unwrap(), Some(&tip), "꾸민 제안").unwrap();
		vcs::run(&b, &["update-ref", &prop_ref(&key(1), "main"), &c]).unwrap();
		let f4 = box_.join("4.cpptb");
		sync_export(s(&b), s(&f4), false).unwrap();
		as_(1);
		assert_eq!(sync_import(s(&a), s(&f4)).unwrap().props, 0);
		assert!(status(&a).unwrap().unwrap().props.is_empty());
		as_(7);
		for p in [&a, &b, &box_] {
			let _ = std::fs::remove_dir_all(p);
		}
	}

	/// 승인자가 둘(가 1 · 다 3)이면 명부를 바꾸는 판은 둘 다 서명해야 선다 : 가가 내고, 다가 묶음으로 받아 서명을 더한다
	#[test]
	fn roster_changes_collect_signatures_across_copies() {
		let (a, c, box_) = (tmp("ra"), tmp("rc"), tmp("rbox"));
		std::fs::create_dir_all(&a).unwrap();
		as_(1);
		put(&a, "deck.json", "{}");
		trust::change(&a, &SecretKey::from_bytes(&[1; 32]), |r| {
			r.people.push(trust::Person { id: "c".into(), name: "다".into(), keys: vec![key(3)], role: Role::Approve, slides: vec![], replica: true });
			Ok(())
		})
		.unwrap();
		let f1 = box_.join("1.cpptb");
		sync_export(s(&a), s(&f1), true).unwrap();
		as_(3);
		sync_open(s(&f1), s(&c)).unwrap();
		// 가 : 나(2)를 더하려 한다 : 둘 중 하나라 서명 대기
		as_(1);
		let n0 = trust::load(&a).unwrap().unwrap().n;
		trust::change(&a, &SecretKey::from_bytes(&[1; 32]), |r| {
			r.people.push(trust::Person { id: "b".into(), name: "나".into(), keys: vec![key(2)], role: Role::Edit, slides: vec![], replica: true });
			Ok(())
		})
		.unwrap();
		assert_eq!(trust::load(&a).unwrap().unwrap().n, n0, "아직 서지 않았다");
		// 서명을 모으는 동안 판을 남겨 승인 칸이 붙어도 대기 판은 살아 있다
		put(&a, "slides/x.html", "가");
		assert_eq!(trust::load(&a).unwrap().unwrap().n, n0 + 1);
		let v = serde_json::to_value(trust::trust_state(s(&a)).unwrap().unwrap()).unwrap();
		assert_eq!((v["pending"].as_array().unwrap().len(), v["pending"][0]["mine"].as_bool(), v["pending"][0]["changes"][0]["kind"].as_str()), (1, Some(true), Some("add")));
		let f2 = box_.join("2.cpptb");
		sync_export(s(&a), s(&f2), false).unwrap().unwrap();
		// 다 : 받아 서명을 더한다 : 과반이 되어 선다
		as_(3);
		sync_import(s(&c), s(&f2)).unwrap();
		put(&c, "slides/y.html", "다");
		let v = serde_json::to_value(trust::trust_state(s(&c)).unwrap().unwrap()).unwrap();
		assert_eq!(v["pending"][0]["mine"].as_bool(), Some(false));
		let h = v["pending"][0]["hash"].as_str().unwrap().to_string();
		let v = serde_json::to_value(trust::trust_cosign(s(&c), h).unwrap()).unwrap();
		assert_eq!((v["people"].as_array().unwrap().len(), v["pending"].as_array().unwrap().len()), (3, 0));
		let f3 = box_.join("3.cpptb");
		sync_export(s(&c), s(&f3), false).unwrap().unwrap();
		// 가 : 선 명부를 받는다 : 대기 판은 낡아 사라진다
		as_(1);
		assert!(sync_import(s(&a), s(&f3)).unwrap().adopted);
		let v = serde_json::to_value(trust::trust_state(s(&a)).unwrap().unwrap()).unwrap();
		assert_eq!((v["people"].as_array().unwrap().len(), v["pending"].as_array().unwrap().len()), (3, 0));
		as_(7);
		for p in [&a, &c, &box_] {
			let _ = std::fs::remove_dir_all(p);
		}
	}

	/// 「다른 승인자 확인 받기」를 켠 덱 : 승인자의 제안 승인은 줄기에 들어가고, 승인자 자신의 승인받지 않은 변경은 묻어 들어가지 않는다
	#[test]
	fn review_mode_approves_proposals_without_the_approvers_own_changes() {
		let (a, b, box_) = (tmp("va"), tmp("vb"), tmp("vbox"));
		std::fs::create_dir_all(&a).unwrap();
		as_(1);
		put(&a, "deck.json", "{}");
		trust::change(&a, &SecretKey::from_bytes(&[1; 32]), |r| {
			r.review = true;
			r.people.push(trust::Person { id: "b".into(), name: "나".into(), keys: vec![key(2)], role: Role::Edit, slides: vec![], replica: true });
			Ok(())
		})
		.unwrap();
		let f1 = box_.join("1.cpptb");
		sync_export(s(&a), s(&f1), true).unwrap();
		as_(2);
		sync_open(s(&f1), s(&b)).unwrap();
		put(&b, "slides/b.html", "나");
		let f2 = box_.join("2.cpptb");
		sync_export(s(&b), s(&f2), false).unwrap().unwrap();
		as_(1);
		// 가 자신의 변경 : 확인 모드라 봉하지 않는다
		put(&a, "slides/a.html", "가 혼자");
		assert_eq!(status(&a).unwrap().unwrap().pending, 1);
		sync_import(s(&a), s(&f2)).unwrap();
		let n0 = trust::load(&a).unwrap().unwrap().n;
		assert!(sync_approve(s(&a), key(2), "main".into()).unwrap().is_empty());
		let st = trust::load(&a).unwrap().unwrap();
		assert_eq!(st.n, n0 + 1, "승인이 줄기에 들어갔다");
		let files = vcs::run(&a, &["ls-tree", "-r", "--name-only", &st.head]).unwrap();
		assert!(files.contains("slides/b.html") && !files.contains("slides/a.html"), "{files}");
		// 내 줄에는 둘 다 · 내 변경은 아직 승인 대기
		assert_eq!((read(&a, "slides/a.html"), read(&a, "slides/b.html")), ("가 혼자".into(), "나".into()));
		assert_eq!(status(&a).unwrap().unwrap().pending, 2, "내 변경과, 줄기를 내 줄에 합친 판");
		as_(7);
		for p in [&a, &b, &box_] {
			let _ = std::fs::remove_dir_all(p);
		}
	}

	/// 우편함에서 읽지 못한 파일은 바로 넘기지 않고 다시 해 본다 (클라우드 자리 표시 · 잠김)
	#[test]
	fn mailbox_retries_unreadable_files() {
		let (a, shared) = (tmp("ya"), tmp("yshared"));
		std::fs::create_dir_all(&a).unwrap();
		as_(1);
		put(&a, "deck.json", "{}");
		sync_mailbox_set(s(&a), Some(s(&shared))).unwrap();
		let st = trust::load(&a).unwrap().unwrap();
		let folder = shared.join(&st.deck[..12]);
		std::fs::create_dir_all(&folder).unwrap();
		std::fs::write(folder.join("zzzzzzzzzzzz-1.cpptb"), "아직 내려받는 중").unwrap();
		for _ in 0..9 {
			assert!(mailbox_run(&a).unwrap().errors.is_empty());
		}
		assert_eq!(mailbox_run(&a).unwrap().errors.len(), 1, "열 번째에야 넘기며 알린다");
		assert!(mailbox_run(&a).unwrap().errors.is_empty(), "그 뒤로는 읽지 않는다");
		as_(7);
		for p in [&a, &shared] {
			let _ = std::fs::remove_dir_all(p);
		}
	}

	#[test]
	fn mailbox_moves_changes_both_ways() {
		let (a, b, shared) = (tmp("ma"), tmp("mb"), tmp("mshared"));
		std::fs::create_dir_all(&a).unwrap();
		as_(1);
		put(&a, "deck.json", "{}");
		put(&a, "slides/s1.html", "1");
		let first = tmp("mfirst").join("first.cpptb");
		sync_export(s(&a), s(&first), true).unwrap();
		as_(2);
		sync_open(s(&first), s(&b)).unwrap();
		sync_join(s(&b), "나".into()).unwrap();
		for (n, d) in [(1, &a), (2, &b)] {
			as_(n);
			sync_mailbox_set(s(d), Some(s(&shared))).unwrap();
		}
		// 나 → 우편함 → 가 : 참여 요청
		as_(2);
		assert!(mailbox_run(&b).unwrap().sent.is_some());
		as_(1);
		let r = mailbox_run(&a).unwrap();
		assert_eq!((r.received, r.errors.len()), (1, 0));
		sync_admit(s(&a), key(2), Role::Edit).unwrap();
		put(&a, "slides/s1.html", "2");
		assert!(mailbox_run(&a).unwrap().sent.is_some());
		// 가 → 우편함 → 나 : 명부와 줄기
		as_(2);
		let r = mailbox_run(&b).unwrap();
		assert!(r.received >= 1 && r.errors.is_empty(), "{r:?}");
		assert_eq!(read(&b, "slides/s1.html"), "2");
		assert!(status(&b).unwrap().unwrap().member);
		// 같은 파일을 두 번 들이지 않는다 · 받은 기록은 한 번 다시 보내고(다른 사람에게 날라 준다), 그 뒤로는 보낼 것이 없다
		assert_eq!(mailbox_run(&b).unwrap().received, 0);
		let r = mailbox_run(&b).unwrap();
		assert_eq!((r.received, r.sent.is_some()), (0, false));
		as_(7);
		for p in [&a, &b, &shared, &tmp("mfirst")] {
			let _ = std::fs::remove_dir_all(p);
		}
	}
}
