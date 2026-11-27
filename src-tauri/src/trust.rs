// 서명 사슬 (2026.11.27): 덱마다 「누가 어떤 권한인가(명부)」와 「줄기를 어디까지 승인했나」를 서명한 기록 한 줄로 쌓는다.
// 분산 협업 1단계 (design/분산 협업/1단계 설계.md). 늘 켜진 서버 없이 모두가 사본을 갖게 되면, 줄기는 자리가 아니라
// 「승인 권한이 있는 사람이 서명한 기록」으로 정해진다. 받는 쪽마다 이 사슬을 처음부터 따라가 같은 결론을 낸다.
//
// 목차
//   꼴        Entry(사슬 한 칸) · Body(명부 판 · 승인) · Roster · Person · Role
//   서명      signed_bytes · hash · sign · check_sig: 열쇠는 앱마다 있는 iroh ed25519 열쇠(p2p.key)
//   검증      apply(한 칸) · verify(처음부터): git 으로 볼 것(조상 · 트리 · 바뀐 파일)은 Repo 로 받는다
//   갈래 고르기 relate · choose: 두 사본의 사슬이 갈라졌을 때 모두가 같은 쪽을 고르는 규칙
//   저장      refs/cppt/chain (커밋 한 칸 = entry.json 하나) · 읽기 read_chain · 쓰기 append · 캐시 .git/claudeppt-chain.json
//   봉하기    seal: 줄기가 앞으로 가면 내가 승인자일 때 승인 기록을 붙인다 (판 남기기 · 턴 얹기 · 가지 넣기 끝에 부른다)
//   앱 명령   trust_state · trust_rename · trust_recovery · trust_recover
//
// 명부 판과 승인을 한 사슬에 둔다. 따로 두면 「권한을 뺀 판」과 「그 사람의 승인」 중 무엇이 먼저인지 가릴 수 없어,
// 권한을 잃은 사람의 서명이 들어가거나 이미 들어간 승인이 거꾸로 무효가 된다 (설계 문서는 두 사슬이었다 · 구현하며 바꿨다).
//
// 1단계에서 줄기(main)는 지금처럼 덱 폴더가 쥐고, 사슬이 줄기를 따라 봉한다. 내가 덱의 유일한 승인자라 결과는 같다.
// 승인자가 아닌 사람이 생기는 2단계(사본을 주고받기)부터 줄기를 사슬로만 옮긴다.

use crate::{Res, err, vcs};
use base64::Engine;
use iroh::{PublicKey, SecretKey, Signature};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::Path;
use std::process::Stdio;

pub const CHAIN: &str = "refs/cppt/chain";
/// 승인된 줄기 끝 (사슬 상태의 head): 사슬이 바뀔 때마다 맞춘다. 덱 폴더의 main 은 「내 줄」이라
/// 승인자가 아닌 사람의 main 은 이것보다 앞서 있을 수 있다(아직 승인받지 않은 내 변경 = 내 제안)
pub const TRUNK: &str = "refs/cppt/trunk";
/// 서명할 바이트의 머리: 같은 열쇠로 한 다른 서명(앞으로의 묶음 파일 · 수신 확인)과 섞이지 않게
const DOMAIN: &str = "claudeppt/chain/1\n";
const FILE: &str = "entry.json";

// ── 꼴 ──

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Role {
	/// 줄기에 넣는 것을 승인한다 · 편집도 한다
	Approve,
	Edit,
	/// 맡은 쪽(slides)만 고친다
	Assigned,
	Comment,
	View,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Person {
	pub id: String,
	pub name: String,
	/// 이 사람의 기기 열쇠들(z32). 이름은 표시용이고 아무것도 보증하지 않는다: 사람을 가리는 것은 열쇠다
	pub keys: Vec<String>,
	pub role: Role,
	/// Assigned 일 때 맡은 쪽 id
	#[serde(default)]
	pub slides: Vec<String>,
	/// 사본을 받는 사람인가: false 면 지금 공유(덱 주인이 화면을 내주는 방식)로만 들어온다 (「담당 쪽만 보이기」 · 브라우저)
	#[serde(default = "yes")]
	pub replica: bool,
}

fn yes() -> bool {
	true
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Roster {
	pub people: Vec<Person>,
	/// 「다른 승인자 확인 받기」: 켜면 자기 변경을 스스로 승인하지 못한다
	#[serde(default)]
	pub review: bool,
}

impl Roster {
	pub(crate) fn person_of(&self, key: &str) -> Option<&Person> {
		self.people.iter().find(|p| p.keys.iter().any(|k| k == key))
	}
	pub(crate) fn approvers(&self) -> impl Iterator<Item = &Person> {
		self.people.iter().filter(|p| p.role == Role::Approve)
	}
	fn approver_keys(&self) -> Vec<&str> {
		self.approvers().flat_map(|p| p.keys.iter().map(String::as_str)).collect()
	}
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Proposal {
	/// 제안한 사람의 열쇠
	pub by: String,
	pub id: String,
	pub tip: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Body {
	/// 명부 판: 줄기는 그대로 두고 명부만 바꾼다. 창세 칸도 이것이다(head = 그때 줄기 끝)
	Roster { roster: Roster, head: String },
	/// 줄기를 base 에서 head 로 옮기는 승인. rewind 는 승인자가 줄기를 뒤로 돌린 때만 (앱 밖 git 으로 줄기를 되감은 덱)
	Approve {
		base: String,
		head: String,
		tree: String,
		#[serde(default, skip_serializing_if = "Option::is_none")]
		proposal: Option<Proposal>,
		#[serde(default, skip_serializing_if = "std::ops::Not::not")]
		rewind: bool,
	},
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Sig {
	pub key: String,
	pub sig: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Entry {
	pub v: u32,
	/// 덱 id = 창세 칸의 해시. 창세 칸은 빈 글자: 다른 덱의 기록을 이 덱에 끼워 넣지 못하게
	pub deck: String,
	pub n: u64,
	pub prev: Option<String>,
	/// 표시용 시각. 순서 · 승자 결정에 쓰지 않는다 (시계를 속이면 그만이다)
	pub at: String,
	#[serde(flatten)]
	pub body: Body,
	pub sigs: Vec<Sig>,
}

/// 사슬을 따라간 뒤의 상태
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct State {
	pub deck: String,
	pub n: u64,
	/// 마지막 칸의 해시
	pub tip: String,
	/// 승인된 줄기 끝
	pub head: String,
	pub roster: Roster,
}

// ── 서명 ──

/// 정규 JSON: 객체 키를 정렬하고 빈칸을 넣지 않는다. 같은 내용이면 누가 만들어도 같은 바이트가 되어야 서명이 맞는다.
/// serde_json 은 이 앱에서 preserve_order 라 키 순서가 넣은 순서다: 그래서 직접 정렬한다
pub(crate) fn canon(v: &Value, out: &mut String) {
	match v {
		Value::Object(m) => {
			let mut keys: Vec<&String> = m.keys().collect();
			keys.sort();
			out.push('{');
			for (i, k) in keys.iter().enumerate() {
				if i > 0 {
					out.push(',');
				}
				out.push_str(&serde_json::to_string(k).unwrap());
				out.push(':');
				canon(&m[*k], out);
			}
			out.push('}');
		}
		Value::Array(l) => {
			out.push('[');
			for (i, x) in l.iter().enumerate() {
				if i > 0 {
					out.push(',');
				}
				canon(x, out);
			}
			out.push(']');
		}
		x => out.push_str(&x.to_string()),
	}
}

pub fn signed_bytes(e: &Entry) -> Vec<u8> {
	let mut v = serde_json::to_value(e).unwrap();
	v.as_object_mut().unwrap().shift_remove("sigs");
	let mut s = DOMAIN.to_string();
	canon(&v, &mut s);
	s.into_bytes()
}

/// 칸의 해시: 서명은 넣지 않는다 (명부 판에 서명이 더 모여도 같은 판이다)
pub fn hash(e: &Entry) -> String {
	Sha256::digest(signed_bytes(e)).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn key_id(k: &SecretKey) -> String {
	k.public().to_z32()
}

pub fn sign(e: &mut Entry, k: &SecretKey) {
	let sig = k.sign(&signed_bytes(e));
	let key = key_id(k);
	e.sigs.retain(|s| s.key != key);
	e.sigs.push(Sig { key, sig: base64::engine::general_purpose::STANDARD.encode(sig.to_bytes()) });
}

fn check_sig(e: &Entry, s: &Sig) -> bool {
	let Ok(pk) = PublicKey::from_z32(&s.key) else { return false };
	let Some(b) = base64::engine::general_purpose::STANDARD.decode(&s.sig).ok().and_then(|b| <[u8; 64]>::try_from(b).ok()) else { return false };
	pk.verify(&signed_bytes(e), &Signature::from_bytes(&b)).is_ok()
}

/// 서명이 맞는 열쇠들. 하나라도 틀린 서명이 있으면 칸 전체를 받지 않는다: 틀린 서명을 섞어 두는 것은 실수거나 장난이다
fn signers(e: &Entry) -> Result<Vec<&str>, String> {
	let mut out = vec![];
	for s in &e.sigs {
		if !check_sig(e, s) {
			return Err(format!("서명이 맞지 않는다 ({})", short(&s.key)));
		}
		if !out.contains(&s.key.as_str()) {
			out.push(s.key.as_str());
		}
	}
	Ok(out)
}

pub(crate) fn short(k: &str) -> &str {
	k.get(..8).unwrap_or(k)
}

// ── 검증 ──

/// 검증이 git 에게 묻는 것
pub trait Repo {
	/// a 가 b 의 조상이거나 b 자신인가
	fn is_ancestor(&self, a: &str, b: &str) -> bool;
	fn tree(&self, c: &str) -> Option<String>;
	fn changed(&self, a: &str, b: &str) -> Vec<String>;
}

/// 덱 저장소: git 을 불러 답한다
pub struct Git<'a>(pub &'a Path);

impl Repo for Git<'_> {
	fn is_ancestor(&self, a: &str, b: &str) -> bool {
		vcs::git(self.0).args(["merge-base", "--is-ancestor", a, b]).status().is_ok_and(|s| s.success())
	}
	fn tree(&self, c: &str) -> Option<String> {
		vcs::run(self.0, &["rev-parse", "--verify", "-q", &format!("{c}^{{tree}}")]).ok()
	}
	fn changed(&self, a: &str, b: &str) -> Vec<String> {
		vcs::run(self.0, &["diff", "--name-only", "--no-renames", a, b]).unwrap_or_default().lines().map(String::from).collect()
	}
}

fn sane(r: &Roster) -> Result<(), String> {
	if r.approvers().next().is_none() {
		return Err("명부에 승인자가 없다".into());
	}
	let mut seen: Vec<&str> = vec![];
	for p in &r.people {
		if p.keys.is_empty() {
			return Err(format!("{} 에게 열쇠가 없다", p.name));
		}
		for k in &p.keys {
			if seen.contains(&k.as_str()) {
				return Err(format!("열쇠 하나가 두 사람에게 있다 ({})", short(k)));
			}
			seen.push(k);
		}
	}
	Ok(())
}

/// 맡은 쪽만 고치는 사람이 고칠 수 있는 파일: 맡은 쪽 HTML 과 그림 · 글꼴. 덱 목차 · 테마 · 남의 쪽은 안 된다 (store.ts fenceOf 와 같은 범위)
fn in_scope(p: &Person, file: &str) -> bool {
	file.starts_with("assets/") || p.slides.iter().any(|id| file == format!("slides/{id}.html"))
}

/// 한 칸을 얹는다. 창세 칸이면 st 는 None
pub fn apply(st: Option<&State>, e: &Entry, repo: &dyn Repo) -> Result<State, String> {
	if e.v != 1 {
		return Err(format!("모르는 기록 판 ({})", e.v));
	}
	let signed = signers(e)?;
	let Some(st) = st else {
		// 창세: 덱을 만든 사람 한 명의 서명. 그 사람은 명부의 승인자여야 한다
		let Body::Roster { roster, head } = &e.body else { return Err("첫 칸이 명부가 아니다".into()) };
		if e.n != 0 || e.prev.is_some() || !e.deck.is_empty() {
			return Err("첫 칸의 꼴이 맞지 않다".into());
		}
		sane(roster)?;
		if signed.len() != 1 || !roster.approver_keys().contains(&signed[0]) {
			return Err("첫 칸은 명부의 승인자 한 사람이 서명해야 한다".into());
		}
		if !head.is_empty() && repo.tree(head).is_none() {
			return Err("첫 칸의 줄기 커밋이 저장소에 없다".into());
		}
		return Ok(State { deck: hash(e), n: 0, tip: hash(e), head: head.clone(), roster: roster.clone() });
	};
	if e.deck != st.deck {
		return Err("다른 덱의 기록이다".into());
	}
	if e.n != st.n + 1 || e.prev.as_deref() != Some(st.tip.as_str()) {
		return Err("앞 칸과 이어지지 않는다".into());
	}
	// 서명한 사람: 지금 명부의 승인자만 센다. 같은 사람의 열쇠 여럿은 한 사람이다
	let mut people: Vec<&str> = signed.iter().filter_map(|k| st.roster.person_of(k)).filter(|p| p.role == Role::Approve).map(|p| p.id.as_str()).collect();
	people.sort();
	people.dedup();
	match &e.body {
		Body::Roster { roster, head } => {
			if *head != st.head {
				return Err("명부 판이 지금 줄기 위에 있지 않다".into());
			}
			sane(roster)?;
			let total = st.roster.approvers().count();
			if people.len() * 2 <= total {
				return Err(format!("명부를 바꾸려면 승인자 과반의 서명이 있어야 한다 ({}/{total})", people.len()));
			}
			Ok(State { deck: st.deck.clone(), n: e.n, tip: hash(e), head: st.head.clone(), roster: roster.clone() })
		}
		Body::Approve { base, head, tree, proposal, rewind } => {
			if *base != st.head {
				return Err("승인이 지금 줄기 위에 있지 않다".into());
			}
			if people.is_empty() {
				return Err("승인 권한이 없는 열쇠의 서명이다".into());
			}
			if !*rewind && !repo.is_ancestor(base, head) {
				return Err("줄기를 앞으로만 옮기지 않는다".into());
			}
			if repo.tree(head).as_deref() != Some(tree.as_str()) {
				return Err("줄기 커밋의 내용이 기록과 다르다".into());
			}
			let author = proposal.as_ref().map(|p| p.by.as_str()).unwrap_or(signed[0]);
			let who = st.roster.person_of(author);
			if let Some(p) = who.filter(|p| p.role == Role::Assigned) {
				if let Some(f) = repo.changed(base, head).into_iter().find(|f| !in_scope(p, f)) {
					return Err(format!("맡은 쪽 밖의 파일을 고쳤다 ({f})"));
				}
			}
			if st.roster.review && who.is_some_and(|w| people.iter().all(|id| *id == w.id)) {
				return Err("「다른 승인자 확인 받기」가 켜져 있어 자기 변경을 스스로 승인하지 못한다".into());
			}
			Ok(State { deck: st.deck.clone(), n: e.n, tip: hash(e), head: head.clone(), roster: st.roster.clone() })
		}
	}
}

/// 사슬을 처음부터 따라간 결과: 어긋난 칸에서 멈추고 그 앞까지를 믿는다
#[derive(Debug)]
pub struct Verified {
	pub state: Option<State>,
	/// 믿은 칸 수: entries[..ok] 가 믿을 수 있는 앞부분이다
	pub ok: usize,
	/// 어긋난 칸 번호와 까닭
	pub bad: Option<(u64, String)>,
}

pub fn verify(entries: &[Entry], repo: &dyn Repo) -> Verified {
	let mut st: Option<State> = None;
	for (i, e) in entries.iter().enumerate() {
		match apply(st.as_ref(), e, repo) {
			Ok(s) => st = Some(s),
			Err(why) => return Verified { state: st, ok: i, bad: Some((e.n, why)) },
		}
	}
	Verified { state: st, ok: entries.len(), bad: None }
}

// ── 갈래 고르기 ──
// 서로 못 보던 두 승인자가 같은 칸 위에 서로 다른 칸을 붙이면 사슬이 갈라진다. 서버가 없으니 모두가 같은 규칙으로 한쪽을 고른다.
//   1. 한쪽 갈래가 승인 권한을 뺀 열쇠는, 다른 쪽 갈래에서 그 열쇠가 서명한 칸부터 잘라 낸다: 권한을 잃은 사람이
//      박탈 전 자리에서 갈래를 새로 내어 이기지 못하게 (Matrix 가 권한 사건을 먼저 보는 것과 같은 생각)
//   2. 남은 갈래 중 첫 칸의 해시가 사전순으로 작은 쪽이 이긴다: 시각 · 권한 순위로 고르면 시계를 속이거나 윗사람 쪽으로 쏠린다
// 진 쪽의 변경은 버리지 않는다. 그 칸을 낸 승인자의 앱이 이긴 쪽 위에 다시 합쳐 새로 서명한다 (2단계)

#[derive(Debug, PartialEq)]
pub enum Side {
	Mine,
	Theirs,
}

/// 갈래 안에서 승인 권한을 잃은 열쇠 (갈라진 자리의 명부 기준)
fn revoked(base: &Roster, branch: &[Entry]) -> Vec<String> {
	let had: Vec<&str> = base.approver_keys();
	let mut out = vec![];
	for e in branch {
		if let Body::Roster { roster, .. } = &e.body {
			let now = roster.approver_keys();
			out.extend(had.iter().filter(|k| !now.contains(k)).map(|k| k.to_string()));
		}
	}
	out.sort();
	out.dedup();
	out
}

/// cut 의 열쇠가 서명한 첫 칸 앞까지
fn trim<'a>(branch: &'a [Entry], cut: &[String]) -> &'a [Entry] {
	let end = branch.iter().position(|e| e.sigs.iter().any(|s| cut.contains(&s.key))).unwrap_or(branch.len());
	&branch[..end]
}

/// 같은 자리(base 상태)에서 갈라진 두 갈래 중 이기는 쪽
pub fn choose(base: &State, mine: &[Entry], theirs: &[Entry]) -> Side {
	let m = trim(mine, &revoked(&base.roster, theirs));
	let t = trim(theirs, &revoked(&base.roster, mine));
	match (m.first(), t.first()) {
		(Some(_), None) => Side::Mine,
		(None, Some(_)) => Side::Theirs,
		(Some(a), Some(b)) => if hash(a) <= hash(b) { Side::Mine } else { Side::Theirs },
		// 둘 다 잘렸다: 원래 첫 칸으로
		(None, None) => match (mine.first(), theirs.first()) {
			(Some(a), Some(b)) if hash(b) < hash(a) => Side::Theirs,
			_ => Side::Mine,
		},
	}
}

/// 두 사본의 사슬 사이
#[derive(Debug, PartialEq)]
pub enum Relation {
	Same,
	/// 내 것이 앞서 있다 (남의 것은 내 것의 앞부분)
	Ahead,
	/// 남의 것이 내 것을 이어 간다: 받으면 된다
	Behind,
	/// at 번째 칸에서 갈라졌다
	Diverged { at: u64, winner: Side },
	/// 다른 덱이다
	Foreign,
}

/// 둘 다 검증을 지난 사슬이어야 한다 (verify 의 ok 까지)
pub fn relate(mine: &[Entry], theirs: &[Entry], repo: &dyn Repo) -> Relation {
	match (mine.first(), theirs.first()) {
		(Some(a), Some(b)) if hash(a) == hash(b) => {}
		_ => return Relation::Foreign,
	}
	let k = mine.iter().zip(theirs).take_while(|(a, b)| hash(a) == hash(b)).count();
	if k == mine.len() && k == theirs.len() {
		return Relation::Same;
	}
	if k == theirs.len() {
		return Relation::Ahead;
	}
	if k == mine.len() {
		return Relation::Behind;
	}
	let base = verify(&mine[..k], repo).state.expect("앞부분은 검증을 지났다");
	Relation::Diverged { at: k as u64, winner: choose(&base, &mine[k..], &theirs[k..]) }
}

// ── 저장 ──

pub(crate) fn git_in(d: &Path, args: &[&str], input: &[u8]) -> Res<String> {
	let mut c = vcs::git(d);
	c.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
	let mut ch = c.spawn().map_err(err)?;
	ch.stdin.take().unwrap().write_all(input).map_err(err)?;
	let o = ch.wait_with_output().map_err(err)?;
	if !o.status.success() {
		return Err(String::from_utf8_lossy(&o.stderr).trim().to_string());
	}
	Ok(String::from_utf8_lossy(&o.stdout).trim_end().to_string())
}

/// 사슬을 처음부터 읽는다. 사슬이 없으면 빈 목록
pub fn read_chain(d: &Path, r: &str) -> Res<Vec<Entry>> {
	let Ok(list) = vcs::run(d, &["rev-list", "--reverse", "--first-parent", r]) else { return Ok(vec![]) };
	let commits: Vec<&str> = list.lines().filter(|l| !l.is_empty()).collect();
	if commits.is_empty() {
		return Ok(vec![]);
	}
	let ask: String = commits.iter().map(|c| format!("{c}:{FILE}\n")).collect();
	let mut c = vcs::git(d);
	c.args(["cat-file", "--batch"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
	let mut ch = c.spawn().map_err(err)?;
	let mut stdin = ch.stdin.take().unwrap();
	// 쓰는 동안 읽지 않으면 큰 사슬에서 파이프가 차 서로 기다린다: 쓰기는 따로
	let feed = std::thread::spawn(move || stdin.write_all(ask.as_bytes()));
	let o = ch.wait_with_output().map_err(err)?;
	let _ = feed.join();
	let mut out = vec![];
	let mut rest = o.stdout.as_slice();
	for c in commits {
		let nl = rest.iter().position(|b| *b == b'\n').ok_or("사슬을 읽지 못했다")?;
		let head = String::from_utf8_lossy(&rest[..nl]).to_string();
		rest = &rest[nl + 1..];
		let size: usize = head.split(' ').nth(2).and_then(|x| x.parse().ok()).ok_or_else(|| format!("사슬 칸 {} 이 비었다", &c[..8]))?;
		let body = rest.get(..size).ok_or("사슬을 읽지 못했다")?;
		out.push(serde_json::from_slice::<Entry>(body).map_err(|e| format!("사슬 칸 {} 을 읽지 못했다: {e}", &c[..8]))?);
		rest = rest.get(size + 1..).unwrap_or(&[]);
	}
	Ok(out)
}

/// 한 칸을 사슬 끝에 붙인다. 그 사이 남(앱 밖 CLI)이 붙였으면 실패한다: 부른 쪽이 다시 읽고 다시 한다
fn append(d: &Path, e: &Entry) -> Res<String> {
	let blob = git_in(d, &["hash-object", "-w", "--stdin"], (serde_json::to_string_pretty(e).map_err(err)? + "\n").as_bytes())?;
	let tree = git_in(d, &["mktree"], format!("100644 blob {blob}\t{FILE}\n").as_bytes())?;
	let old = vcs::run(d, &["rev-parse", "--verify", "-q", CHAIN]).ok();
	let kind = match e.body {
		Body::Roster { .. } => "명부",
		Body::Approve { .. } => "승인",
	};
	let msg = format!("{} {kind}", e.n);
	let mut args = vec!["commit-tree", tree.as_str(), "-m", msg.as_str()];
	if let Some(p) = &old {
		args.extend(["-p", p.as_str()]);
	}
	let c = vcs::run(d, &args)?;
	let zero = "0".repeat(40);
	vcs::run(d, &["update-ref", CHAIN, &c, old.as_deref().unwrap_or(&zero)])?;
	Ok(c)
}

#[derive(Serialize, Deserialize)]
struct Cache {
	commit: String,
	state: State,
}

fn cache_file(d: &Path) -> std::path::PathBuf {
	vcs::git_dir(d).join("claudeppt-chain.json")
}

/// 이 덱의 사슬 상태: 캐시가 사슬 끝과 같으면 그것을, 아니면 처음부터 검증한다. 사슬이 없으면 None
pub fn load(d: &Path) -> Res<Option<State>> {
	let Ok(commit) = vcs::run(d, &["rev-parse", "--verify", "-q", CHAIN]) else { return Ok(None) };
	let cached = std::fs::read_to_string(cache_file(d)).ok().and_then(|t| serde_json::from_str::<Cache>(&t).ok());
	if let Some(c) = cached {
		if c.commit == commit {
			return Ok(Some(c.state));
		}
		// 그 사이 앱 밖 CLI 가 칸을 붙였다: 캐시 뒤의 칸만 검증한다. 처음부터 하면 칸마다 git 을 두 번 띄워 긴 덱에서 수십 초가 걸린다
		if Git(d).is_ancestor(&c.commit, &commit) {
			let mut st = c.state;
			for e in read_chain(d, &format!("{}..{CHAIN}", c.commit))? {
				st = apply(Some(&st), &e, &Git(d)).map_err(|why| format!("이 덱의 서명 기록 {}번 칸이 맞지 않는다: {why}", e.n))?;
			}
			remember(d, commit, &st);
			return Ok(Some(st));
		}
	}
	let v = verify(&read_chain(d, CHAIN)?, &Git(d));
	if let Some((n, why)) = v.bad {
		return Err(format!("이 덱의 서명 기록 {n}번 칸이 맞지 않는다: {why}"));
	}
	let st = v.state;
	if let Some(s) = &st {
		remember(d, commit, s);
	}
	Ok(st)
}

/// 캐시와 승인된 줄기 ref 를 사슬 상태에 맞춘다
pub(crate) fn remember(d: &Path, commit: String, st: &State) {
	let _ = std::fs::write(cache_file(d), serde_json::to_string(&Cache { commit, state: st.clone() }).unwrap_or_default());
	if !st.head.is_empty() {
		let _ = vcs::run(d, &["update-ref", TRUNK, &st.head]);
	}
}

/// 칸 하나를 검증하고 붙인다: 내 앱이 만든 칸도 받는 칸과 같은 검증을 지난다
fn push(d: &Path, st: Option<&State>, e: &Entry) -> Res<State> {
	let next = apply(st, e, &Git(d))?;
	let c = append(d, e)?;
	remember(d, c, &next);
	Ok(next)
}

pub(crate) fn now() -> String {
	chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

fn new_person_id() -> String {
	uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

/// 가져온 사본(from 폴더)의 서명 기록을 이 덱의 것과 견준다. 1단계에서는 알리기만 하고 줄기는 옮기지 않는다: 사본은 가지로 들어온다.
/// 받은 사슬은 refs/cppt/peers/copy-<id>/chain 에 따로 둔다 (내 사슬을 덮지 않게)
///   none 사본에 기록이 없다(옛 앱) · same · ahead(내 것이 앞섰다) · behind(사본이 이어 갔다)
///   diverged(따로 승인되어 갈라졌다) · foreign(다른 덱) · invalid(사본의 기록이 맞지 않는다)
pub fn compare_copy(d: &Path, from: &Path, id: &str) -> &'static str {
	let theirs_ref = format!("refs/cppt/peers/copy-{id}/chain");
	// 사슬 칸이 가리키는 줄기 커밋도 함께: 사슬 커밋에는 기록 파일만 있어, 줄기를 받지 않으면 승인한 내용을 검증하지 못한다
	let pull = format!("+{CHAIN}:{theirs_ref}");
	let head = format!("+HEAD:refs/cppt/peers/copy-{id}/head");
	if vcs::run(d, &["fetch", "-q", "--no-tags", &from.to_string_lossy(), &pull, &head]).is_err() {
		return "none";
	}
	let repo = Git(d);
	let theirs = read_chain(d, &theirs_ref).unwrap_or_default();
	let tv = verify(&theirs, &repo);
	if tv.bad.is_some() || theirs.is_empty() {
		return "invalid";
	}
	let mine = read_chain(d, CHAIN).unwrap_or_default();
	let mv = verify(&mine, &repo);
	match relate(&mine[..mv.ok], &theirs, &repo) {
		Relation::Same => "same",
		Relation::Ahead => "ahead",
		Relation::Behind => "behind",
		Relation::Diverged { .. } => "diverged",
		Relation::Foreign => "foreign",
	}
}

// ── 열쇠 ──

/// 이 앱의 열쇠: 공유에 쓰는 iroh 열쇠와 같다(p2p.key). 시험은 앱 데이터의 열쇠를 건드리지 않게 정해 둔 열쇠를 쓴다
pub fn my_key() -> SecretKey {
	#[cfg(test)]
	{
		TEST_KEY.with(|k| k.borrow().clone())
	}
	#[cfg(not(test))]
	{
		crate::p2p::secret()
	}
}

#[cfg(test)]
thread_local! {
	pub static TEST_KEY: std::cell::RefCell<SecretKey> = std::cell::RefCell::new(SecretKey::from_bytes(&[7u8; 32]));
}

// ── 봉하기 ──

/// 처음 이름: 명부 화면에서 고친다
fn my_name() -> String {
	std::env::var("USERNAME").ok().map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| "나".into())
}

/// 덱의 본 작업 폴더인가: 가지 · 작업 사본(worktree)은 .git 이 파일이다. 그 폴더들의 판은 줄기가 아니라 봉하지 않는다
pub(crate) fn is_main_checkout(d: &Path) -> bool {
	d.join(".git").is_dir()
}

/// 창세: 이 앱의 열쇠를 유일한 승인자로 둔 명부와 지금 줄기 끝
fn genesis(d: &Path, head: &str, k: &SecretKey) -> Res<State> {
	if !d.join(".gitattributes").exists() {
		let _ = std::fs::write(d.join(".gitattributes"), crate::deckmerge::ATTRS);
	}
	let me = Person { id: new_person_id(), name: my_name(), keys: vec![key_id(k)], role: Role::Approve, slides: vec![], replica: true };
	let mut e = Entry { v: 1, deck: String::new(), n: 0, prev: None, at: now(), body: Body::Roster { roster: Roster { people: vec![me], review: false }, head: head.into() }, sigs: vec![] };
	sign(&mut e, k);
	push(d, None, &e)
}

/// 줄기가 앞으로 갔으면 승인 기록을 붙인다. 판 남기기 · 턴 얹기 · 가지 넣기 · 되돌리기 끝에 부른다 (잠근 채로).
/// 사슬이 없는 덱은 여기서 창세를 만든다: 지금 쓰는 덱이 처음 판을 남길 때 저절로 옮겨진다.
/// 실패해도 판 남기기는 그대로 둔다: 봉하지 못한 줄기는 다음 판에서 함께 봉한다
pub fn seal(d: &Path) {
	if let Err(e) = seal_with(d, None) {
		eprintln!("서명 기록을 남기지 못했다: {e}");
	}
}

/// 봉한다. proposal 을 주면 그 제안을 승인한 기록으로 남긴다(담당 쪽 범위 · 「다른 승인자 확인 받기」가 제안한 사람으로 따져진다)
pub(crate) fn seal_with(d: &Path, proposal: Option<Proposal>) -> Res<()> {
	if !is_main_checkout(d) {
		return Ok(());
	}
	let Ok(head) = vcs::run(d, &["rev-parse", "--verify", "-q", "HEAD"]) else { return Ok(()) };
	let k = my_key();
	// 앱 밖 CLI 가 같은 때 붙이면 한쪽이 진다: 다시 읽고 한 번 더
	for _ in 0..2 {
		let st = match load(d)? {
			Some(s) => s,
			None => {
				genesis(d, &head, &k)?;
				return Ok(());
			}
		};
		if st.head == head {
			return Ok(());
		}
		let mine = key_id(&k);
		let Some(p) = st.roster.person_of(&mine) else { return Ok(()) };
		if p.role != Role::Approve || st.roster.review {
			// 승인자가 아니거나 다른 승인자의 확인을 받아야 한다: 줄기 밖 변경으로 남는다 (2단계에서 제안이 된다)
			return Ok(());
		}
		// 내 줄이 승인된 줄기를 품지 않았다(남이 승인한 줄기를 받았는데 아직 합치지 못했다): 봉하면 남의 승인을 되돌리게 되므로 하지 않는다.
		// 2026.11.27 : 처음에는 rewind 를 붙여 봉했다. 줄기를 받는 길이 생기며 막았다: 합친 뒤 다음 판에서 봉한다
		if !Git(d).is_ancestor(&st.head, &head) {
			return Ok(());
		}
		let tree = Git(d).tree(&head).ok_or("줄기 커밋의 트리를 읽지 못했다")?;
		let mut e = Entry { v: 1, deck: st.deck.clone(), n: st.n + 1, prev: Some(st.tip.clone()), at: now(), body: Body::Approve { base: st.head.clone(), head: head.clone(), tree, proposal: proposal.clone(), rewind: false }, sigs: vec![] };
		sign(&mut e, &k);
		match push(d, Some(&st), &e) {
			Ok(_) => return Ok(()),
			Err(_) => continue,
		}
	}
	Err("다른 곳에서 같은 때 기록을 남겨 두 번 다 졌다".into())
}

/// 명부를 바꾸는 판 하나를 내 열쇠(signer)로 서명해 붙인다
pub(crate) fn change(d: &Path, signer: &SecretKey, f: impl FnOnce(&mut Roster) -> Res<()>) -> Res<State> {
	let _l = vcs::lock(d)?;
	seal(d);
	let st = load(d)?.ok_or("이 덱에는 아직 서명 기록이 없다: 판을 하나 남기면 생긴다")?;
	let mut roster = st.roster.clone();
	f(&mut roster)?;
	let mut e = Entry { v: 1, deck: st.deck.clone(), n: st.n + 1, prev: Some(st.tip.clone()), at: now(), body: Body::Roster { roster, head: st.head.clone() }, sigs: vec![] };
	sign(&mut e, signer);
	// 다른 승인자의 서명을 모으는 길은 2단계(사본 주고받기)에서 연다: 지금은 혼자 과반일 때만 선다
	push(d, Some(&st), &e)
}

// ── 앱 명령 ──

#[derive(Serialize)]
pub struct PersonView {
	id: String,
	name: String,
	role: Role,
	keys: usize,
	slides: Vec<String>,
	me: bool,
}

#[derive(Serialize)]
pub struct View {
	/// 덱 id 앞부분
	deck: String,
	n: u64,
	/// 줄기 끝이 승인되었나: 아니면 줄기에 봉하지 못한 변경이 있다
	sealed: bool,
	people: Vec<PersonView>,
	review: bool,
	/// 이 앱의 열쇠 앞부분
	me: String,
	approver: bool,
	/// 승인자가 한 명이고 그 사람의 열쇠가 하나뿐이다: 그 열쇠를 잃으면 줄기가 멈춘다
	fragile: bool,
}

fn view(d: &Path, st: &State) -> View {
	let mine = key_id(&my_key());
	let me = st.roster.person_of(&mine);
	let head = vcs::run(d, &["rev-parse", "--verify", "-q", "HEAD"]).unwrap_or_default();
	let approvers: Vec<&Person> = st.roster.approvers().collect();
	View {
		deck: st.deck[..12].to_string(),
		n: st.n,
		sealed: head.is_empty() || head == st.head,
		people: st.roster.people.iter().map(|p| PersonView { id: p.id.clone(), name: p.name.clone(), role: p.role, keys: p.keys.len(), slides: p.slides.clone(), me: Some(p) == me }).collect(),
		review: st.roster.review,
		me: short(&mine).to_string(),
		approver: me.is_some_and(|p| p.role == Role::Approve),
		fragile: approvers.len() == 1 && approvers[0].keys.len() == 1,
	}
}

/// 이 덱의 명부 · 서명 기록 상태. 기록이 없으면 지금 만든다(판이 하나라도 있을 때)
#[tauri::command(async)]
pub fn trust_state(dir: String) -> Res<Option<View>> {
	let d = Path::new(&dir);
	if !is_main_checkout(d) {
		return Ok(None);
	}
	{
		let _l = vcs::lock(d)?;
		seal(d);
	}
	Ok(load(d)?.map(|st| view(d, &st)))
}

/// 명부의 내 이름을 고친다
#[tauri::command(async)]
pub fn trust_rename(dir: String, name: String) -> Res<View> {
	let d = Path::new(&dir);
	let name: String = name.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(40).collect();
	if name.is_empty() {
		return Err("이름이 비었다".into());
	}
	let mine = key_id(&my_key());
	let st = change(d, &my_key(), |r| {
		let p = r.people.iter_mut().find(|p| p.keys.contains(&mine)).ok_or("명부에 내가 없다")?;
		p.name = name;
		Ok(())
	})?;
	Ok(view(d, &st))
}

/// 복구 열쇠를 하나 만들어 내 두 번째 열쇠로 명부에 넣고, 그 비밀을 돌려준다. 비밀은 어디에도 남기지 않는다: 사람이 적어 둔다
#[tauri::command(async)]
pub fn trust_recovery(dir: String) -> Res<String> {
	let d = Path::new(&dir);
	let k = SecretKey::generate();
	let id = key_id(&k);
	let mine = key_id(&my_key());
	change(d, &my_key(), |r| {
		let p = r.people.iter_mut().find(|p| p.keys.contains(&mine)).ok_or("명부에 내가 없다")?;
		if p.role != Role::Approve {
			return Err("승인자만 복구 열쇠를 만든다".into());
		}
		p.keys.push(id);
		Ok(())
	})?;
	Ok(recovery_text(&k))
}

/// 복구 열쇠의 비밀로 이 앱의 열쇠를 그 사람에게 더한다: PC 를 바꿨거나 앱 데이터를 잃은 승인자
#[tauri::command(async)]
pub fn trust_recover(dir: String, secret: String) -> Res<View> {
	let d = Path::new(&dir);
	let k = parse_recovery(&secret).ok_or("복구 열쇠를 읽지 못했다: 받은 글자 64자를 그대로 넣는다")?;
	let rid = key_id(&k);
	let mine = key_id(&my_key());
	let st = change(d, &k, |r| {
		if r.person_of(&mine).is_some() {
			return Err("이 앱은 이미 명부에 있다".into());
		}
		let p = r.people.iter_mut().find(|p| p.keys.contains(&rid)).ok_or("이 덱의 복구 열쇠가 아니다")?;
		p.keys.push(mine);
		Ok(())
	})?;
	Ok(view(d, &st))
}

/// 복구 열쇠의 비밀: 16진 64자를 8자씩 끊는다 (적기 · 읽어 주기 쉽게)
fn recovery_text(k: &SecretKey) -> String {
	let hex: String = k.to_bytes().iter().map(|b| format!("{b:02x}")).collect();
	hex.as_bytes().chunks(8).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join("-")
}

fn parse_recovery(s: &str) -> Option<SecretKey> {
	let hex: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
	if hex.len() != 64 {
		return None;
	}
	let b: Vec<u8> = (0..32).map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()).collect::<Option<_>>()?;
	Some(SecretKey::from_bytes(&<[u8; 32]>::try_from(b).ok()?))
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::vcs::{vcs_commit, vcs_log};

	fn tmp(name: &str) -> std::path::PathBuf {
		let d = std::env::temp_dir().join(format!("cppt-trust-{name}-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&d);
		std::fs::create_dir_all(&d).unwrap();
		d
	}
	fn key(n: u8) -> SecretKey {
		SecretKey::from_bytes(&[n; 32])
	}
	fn write(d: &Path, rel: &str, text: &str) {
		let p = d.join(rel);
		std::fs::create_dir_all(p.parent().unwrap()).unwrap();
		std::fs::write(p, text).unwrap();
	}
	fn commit(d: &Path, rel: &str, text: &str) -> String {
		write(d, rel, text);
		vcs_commit(d.to_string_lossy().into(), "판".into(), None).unwrap();
		vcs::run(d, &["rev-parse", "HEAD"]).unwrap()
	}
	fn chain(d: &Path) -> Vec<Entry> {
		read_chain(d, CHAIN).unwrap()
	}
	fn person(name: &str, k: &SecretKey, role: Role) -> Person {
		Person { id: name.into(), name: name.into(), keys: vec![key_id(k)], role, slides: vec![], replica: true }
	}
	/// 다음 칸: 서명은 하지 않는다
	fn next(st: &State, body: Body) -> Entry {
		Entry { v: 1, deck: st.deck.clone(), n: st.n + 1, prev: Some(st.tip.clone()), at: "t".into(), body, sigs: vec![] }
	}
	fn approve(d: &Path, st: &State, head: &str) -> Entry {
		next(st, Body::Approve { base: st.head.clone(), head: head.into(), tree: Git(d).tree(head).unwrap(), proposal: None, rewind: false })
	}
	fn signed(mut e: Entry, ks: &[&SecretKey]) -> Entry {
		for k in ks {
			sign(&mut e, k);
		}
		e
	}

	#[test]
	fn committing_seals_the_trunk_and_starts_the_chain() {
		let d = tmp("seal");
		let c1 = commit(&d, "a.txt", "1");
		let c2 = commit(&d, "a.txt", "2");
		let es = chain(&d);
		assert_eq!(es.len(), 2, "창세 + 승인 하나");
		let v = verify(&es, &Git(&d));
		assert!(v.bad.is_none(), "{:?}", v.bad);
		let st = v.state.unwrap();
		assert_eq!((st.head.as_str(), st.n), (c2.as_str(), 1));
		assert!(matches!(&es[0].body, Body::Roster { head, .. } if *head == c1));
		// 사슬은 판 목록 · 줄기 이력에 섞이지 않는다
		assert_eq!(vcs_log(d.to_string_lossy().into(), None).unwrap().len(), 2);
		assert!(d.join(".gitattributes").is_file());
		// 바뀐 것이 없으면 칸이 늘지 않는다 · 캐시가 지워져도 처음부터 다시 검증해 같다
		seal(&d);
		std::fs::remove_file(cache_file(&d)).unwrap();
		assert_eq!(load(&d).unwrap().unwrap(), st);
		assert_eq!(chain(&d).len(), 2);
		// 캐시가 앞 칸에 머물러 있으면(앱 밖 CLI 가 칸을 붙였다) 뒤의 칸만 얹어 같은 상태가 된다
		let first = vcs::run(&d, &["rev-list", "--reverse", CHAIN]).unwrap().lines().next().unwrap().to_string();
		remember(&d, first, &verify(&es[..1], &Git(&d)).state.unwrap());
		assert_eq!(load(&d).unwrap().unwrap(), st);
		let _ = std::fs::remove_dir_all(&d);
	}

	#[test]
	fn forged_or_unauthorized_entries_are_refused() {
		let d = tmp("forge");
		commit(&d, "a.txt", "1");
		let st = load(&d).unwrap().unwrap();
		let c2 = commit(&d, "a.txt", "2");
		let st2 = load(&d).unwrap().unwrap();
		assert_eq!(st2.head, c2);
		let c3 = {
			// 사슬 밖에서 줄기를 하나 더 만든다 (봉하지 않은 커밋)
			write(&d, "a.txt", "3");
			vcs::run(&d, &["commit", "-qam", "x"]).unwrap();
			vcs::run(&d, &["rev-parse", "HEAD"]).unwrap()
		};
		let me = my_key();
		let stranger = key(9);
		// 명부에 없는 열쇠
		assert!(apply(Some(&st2), &signed(approve(&d, &st2, &c3), &[&stranger]), &Git(&d)).unwrap_err().contains("권한"));
		// 서명 뒤에 내용을 바꿨다
		let mut e = signed(approve(&d, &st2, &c3), &[&me]);
		e.at = "다른 때".into();
		assert!(apply(Some(&st2), &e, &Git(&d)).unwrap_err().contains("서명"));
		// 트리가 다르다
		let mut e = approve(&d, &st2, &c3);
		if let Body::Approve { tree, .. } = &mut e.body {
			*tree = "0".repeat(40);
		}
		assert!(apply(Some(&st2), &signed(e, &[&me]), &Git(&d)).unwrap_err().contains("내용"));
		// 되감기: 줄기 뒤로 (rewind 표시 없이)
		let e = next(&st2, Body::Approve { base: st2.head.clone(), head: st.head.clone(), tree: Git(&d).tree(&st.head).unwrap(), proposal: None, rewind: false });
		assert!(apply(Some(&st2), &signed(e, &[&me]), &Git(&d)).unwrap_err().contains("앞으로"));
		// 이어지지 않는 자리 · 다른 덱 · 재생(이미 지난 칸)
		let mut e = approve(&d, &st2, &c3);
		e.prev = Some(st.tip.clone());
		assert!(apply(Some(&st2), &signed(e, &[&me]), &Git(&d)).unwrap_err().contains("이어지지"));
		let mut e = approve(&d, &st2, &c3);
		e.deck = "x".repeat(64);
		assert!(apply(Some(&st2), &signed(e, &[&me]), &Git(&d)).unwrap_err().contains("다른 덱"));
		let old = chain(&d)[1].clone();
		assert!(apply(Some(&st2), &old, &Git(&d)).is_err());
		// 맞는 것은 들어간다
		assert_eq!(apply(Some(&st2), &signed(approve(&d, &st2, &c3), &[&me]), &Git(&d)).unwrap().head, c3);
		let _ = std::fs::remove_dir_all(&d);
	}

	#[test]
	fn verify_stops_at_the_first_bad_entry() {
		let d = tmp("stop");
		commit(&d, "a.txt", "1");
		commit(&d, "a.txt", "2");
		commit(&d, "a.txt", "3");
		let mut es = chain(&d);
		assert_eq!(es.len(), 3);
		es[1].at = "고침".into();
		let v = verify(&es, &Git(&d));
		assert_eq!((v.ok, v.bad.as_ref().map(|b| b.0)), (1, Some(1)));
		assert_eq!(v.state.unwrap().n, 0);
		let _ = std::fs::remove_dir_all(&d);
	}

	#[test]
	fn roster_needs_a_majority_of_current_approvers() {
		let d = tmp("roster");
		let c = commit(&d, "a.txt", "1");
		let (a, b, x) = (key(1), key(2), key(3));
		let g = signed(Entry { v: 1, deck: String::new(), n: 0, prev: None, at: "t".into(), body: Body::Roster { roster: Roster { people: vec![person("가", &a, Role::Approve)], review: false }, head: c.clone() }, sigs: vec![] }, &[&a]);
		let st = apply(None, &g, &Git(&d)).unwrap();
		// 가 혼자 과반: 나를 승인자로 더한다
		let two = Roster { people: vec![person("가", &a, Role::Approve), person("나", &b, Role::Approve)], review: false };
		let st = apply(Some(&st), &signed(next(&st, Body::Roster { roster: two.clone(), head: c.clone() }), &[&a]), &Git(&d)).unwrap();
		// 이제 둘 중 하나는 과반이 아니다
		let three = Roster { people: [two.people.clone(), vec![person("다", &x, Role::Edit)]].concat(), review: false };
		let e = next(&st, Body::Roster { roster: three.clone(), head: c.clone() });
		assert!(apply(Some(&st), &signed(e.clone(), &[&a]), &Git(&d)).unwrap_err().contains("과반"));
		// 같은 사람의 열쇠 둘은 한 사람이다
		let mut two_keys = st.clone();
		two_keys.roster.people[0].keys.push(key_id(&x));
		assert!(apply(Some(&two_keys), &signed(e.clone(), &[&a, &x]), &Git(&d)).unwrap_err().contains("과반"));
		let st = apply(Some(&st), &signed(e, &[&a, &b]), &Git(&d)).unwrap();
		assert_eq!(st.roster.people.len(), 3);
		// 편집 권한은 승인하지 못한다 · 승인자가 없는 명부는 서지 않는다
		let c2 = commit(&d, "a.txt", "2");
		let e = next(&st, Body::Approve { base: c.clone(), head: c2.clone(), tree: Git(&d).tree(&c2).unwrap(), proposal: None, rewind: false });
		assert!(apply(Some(&st), &signed(e, &[&x]), &Git(&d)).unwrap_err().contains("권한"));
		let none = Roster { people: vec![person("다", &x, Role::Edit)], review: false };
		assert!(apply(Some(&st), &signed(next(&st, Body::Roster { roster: none, head: c.clone() }), &[&a, &b]), &Git(&d)).unwrap_err().contains("승인자가 없다"));
		let _ = std::fs::remove_dir_all(&d);
	}

	#[test]
	fn assigned_scope_and_review_are_checked() {
		let d = tmp("scope");
		let c = commit(&d, "slides/s1.html", "1");
		let (a, w) = (key(1), key(4));
		let mut writer = person("담당", &w, Role::Assigned);
		writer.slides = vec!["s1".into()];
		let roster = Roster { people: vec![person("가", &a, Role::Approve), writer], review: false };
		let st = apply(None, &signed(Entry { v: 1, deck: String::new(), n: 0, prev: None, at: "t".into(), body: Body::Roster { roster: roster.clone(), head: c.clone() }, sigs: vec![] }, &[&a]), &Git(&d)).unwrap();
		let by = |h: &str| next(&st, Body::Approve { base: c.clone(), head: h.into(), tree: Git(&d).tree(h).unwrap(), proposal: Some(Proposal { by: key_id(&w), id: "p1".into(), tip: h.into() }), rewind: false });
		let ok = commit(&d, "slides/s1.html", "2");
		assert!(apply(Some(&st), &signed(by(&ok), &[&a]), &Git(&d)).is_ok());
		let out = commit(&d, "theme.css", "x");
		assert!(apply(Some(&st), &signed(by(&out), &[&a]), &Git(&d)).unwrap_err().contains("맡은 쪽 밖"));
		// 「다른 승인자 확인 받기」: 자기 변경(제안 없음 = 서명한 사람의 것)을 스스로 넣지 못한다
		let mut st2 = st.clone();
		st2.roster.review = true;
		let own = next(&st2, Body::Approve { base: c.clone(), head: ok.clone(), tree: Git(&d).tree(&ok).unwrap(), proposal: None, rewind: false });
		assert!(apply(Some(&st2), &signed(own, &[&a]), &Git(&d)).unwrap_err().contains("스스로"));
		assert!(apply(Some(&st2), &signed(by(&ok), &[&a]), &Git(&d)).is_ok(), "남의 제안은 된다");
		let _ = std::fs::remove_dir_all(&d);
	}

	#[test]
	fn diverged_chains_pick_the_same_winner_from_both_sides() {
		let d = tmp("fork");
		let c = commit(&d, "a.txt", "1");
		let (a, b) = (key(1), key(2));
		let roster = Roster { people: vec![person("가", &a, Role::Approve), person("나", &b, Role::Approve)], review: false };
		let g = signed(Entry { v: 1, deck: String::new(), n: 0, prev: None, at: "t".into(), body: Body::Roster { roster: roster.clone(), head: c.clone() }, sigs: vec![] }, &[&a]);
		let st = apply(None, &g, &Git(&d)).unwrap();
		let ca = commit(&d, "a.txt", "가");
		vcs::run(&d, &["reset", "-q", "--hard", &c]).unwrap();
		let cb = commit(&d, "b.txt", "나");
		let ea = signed(approve(&d, &st, &ca), &[&a]);
		let eb = signed(approve(&d, &st, &cb), &[&b]);
		let mine = vec![g.clone(), ea.clone()];
		let theirs = vec![g.clone(), eb.clone()];
		let r1 = relate(&mine, &theirs, &Git(&d));
		let r2 = relate(&theirs, &mine, &Git(&d));
		let a_wins = hash(&ea) < hash(&eb);
		assert_eq!(r1, Relation::Diverged { at: 1, winner: if a_wins { Side::Mine } else { Side::Theirs } });
		assert_eq!(r2, Relation::Diverged { at: 1, winner: if a_wins { Side::Theirs } else { Side::Mine } }, "양쪽이 같은 갈래를 고른다");
		assert_eq!(relate(&mine, &mine[..1], &Git(&d)), Relation::Ahead);
		assert_eq!(relate(&mine[..1], &mine, &Git(&d)), Relation::Behind);
		let other = signed(Entry { at: "다른 덱".into(), ..g.clone() }, &[&a]);
		assert_eq!(relate(&mine, &[other], &Git(&d)), Relation::Foreign);
		let _ = std::fs::remove_dir_all(&d);
	}

	#[test]
	fn revoked_approver_cannot_win_a_fork() {
		let d = tmp("revoke");
		let c = commit(&d, "a.txt", "1");
		let (a, b) = (key(1), key(2));
		let both = Roster { people: vec![person("가", &a, Role::Approve), person("나", &b, Role::Approve)], review: false };
		let g = signed(Entry { v: 1, deck: String::new(), n: 0, prev: None, at: "t".into(), body: Body::Roster { roster: both.clone(), head: c.clone() }, sigs: vec![] }, &[&a]);
		let st = apply(None, &g, &Git(&d)).unwrap();
		// 가 쪽: 나를 뺀다 (가 · 나 둘 다 서명: 과반)
		let only_a = Roster { people: vec![person("가", &a, Role::Approve), person("나", &b, Role::View)], review: false };
		let cut = signed(next(&st, Body::Roster { roster: only_a, head: c.clone() }), &[&a, &b]);
		// 나 쪽: 소식을 못 받은 척 같은 자리에서 승인을 여러 번 시도한다: 해시가 작은 칸을 골라 와도 진다
		let cb = commit(&d, "b.txt", "나");
		for i in 0..8 {
			let mut eb = approve(&d, &st, &cb);
			eb.at = format!("{i}");
			let eb = signed(eb, &[&b]);
			assert_eq!(choose(&st, &[cut.clone()], &[eb.clone()]), Side::Mine);
			assert_eq!(choose(&st, &[eb], &[cut.clone()]), Side::Theirs);
		}
		let _ = std::fs::remove_dir_all(&d);
	}

	#[test]
	fn recovery_key_adds_a_new_device() {
		let d = tmp("recover");
		commit(&d, "a.txt", "1");
		let dir: String = d.to_string_lossy().into();
		assert!(trust_state(dir.clone()).unwrap().unwrap().fragile);
		let secret = trust_recovery(dir.clone()).unwrap();
		assert_eq!(secret.len(), 64 + 7);
		let v = trust_state(dir.clone()).unwrap().unwrap();
		assert!(!v.fragile && v.approver);
		// 새 PC: 다른 앱 열쇠. 복구 열쇠로 그 사람에게 더한다
		let old = TEST_KEY.with(|k| k.replace(key(42)));
		assert!(!trust_state(dir.clone()).unwrap().unwrap().approver);
		assert!(trust_recover(dir.clone(), "00".into()).is_err());
		let v = trust_recover(dir.clone(), secret.to_uppercase()).unwrap();
		assert!(v.approver);
		assert_eq!(v.people.len(), 1);
		assert_eq!(v.people[0].keys, 3);
		// 새 PC 에서 남긴 판도 봉해진다
		commit(&d, "a.txt", "2");
		assert!(trust_state(dir.clone()).unwrap().unwrap().sealed);
		TEST_KEY.with(|k| k.replace(old));
		// 이름 고치기
		assert_eq!(trust_rename(dir.clone(), "  이  정원 ".into()).unwrap().people[0].name, "이 정원");
		assert!(verify(&chain(&d), &Git(&d)).bad.is_none());
		let _ = std::fs::remove_dir_all(&d);
	}

	#[test]
	fn copies_keep_the_chain_and_are_compared_on_the_way_back() {
		let d = tmp("copy");
		write(&d, "deck.json", "{}");
		commit(&d, "a.txt", "1");
		let f = tmp("copy-fork");
		let _ = std::fs::remove_dir_all(&f);
		crate::branch::vcs_fork(d.to_string_lossy().into(), f.to_string_lossy().into()).unwrap();
		assert_eq!(chain(&f), chain(&d), "사본은 같은 기록을 이어 간다");
		commit(&f, "a.txt", "사본");
		assert_eq!(compare_copy(&d, &f, "c1"), "behind");
		commit(&d, "b.txt", "원본");
		assert_eq!(compare_copy(&d, &f, "c2"), "diverged");
		// 사본의 기록을 고친다: 마지막 칸을 서명 없이 바꿔 끼운다
		let mut es = chain(&f);
		es.last_mut().unwrap().at = "고침".into();
		let parent = vcs::run(&f, &[ "rev-parse", &format!("{CHAIN}^")]).unwrap();
		vcs::run(&f, &["update-ref", CHAIN, &parent]).unwrap();
		let _ = std::fs::remove_file(cache_file(&f));
		append(&f, es.last().unwrap()).unwrap();
		assert_eq!(compare_copy(&d, &f, "c3"), "invalid");
		let _ = std::fs::remove_dir_all(&f);
		let _ = std::fs::remove_dir_all(&d);
	}

	#[test]
	fn work_branches_are_not_sealed() {
		let d = tmp("wt");
		commit(&d, "a.txt", "1");
		let n = chain(&d).len();
		let w = vcs::vcs_work_prepare(d.to_string_lossy().into(), "s1".into()).unwrap();
		let wp = serde_json::to_value(&w).unwrap()["path"].as_str().unwrap().to_string();
		write(Path::new(&wp), "b.txt", "x");
		vcs::run(Path::new(&wp), &["add", "-A"]).unwrap();
		vcs::run(Path::new(&wp), &["commit", "-qm", "사본"]).unwrap();
		seal(Path::new(&wp));
		assert_eq!(chain(&d).len(), n, "작업 사본의 판은 봉하지 않는다");
		let _ = std::fs::remove_dir_all(crate::control::data_dir().join("work").join(&crate::invite::hash(&d.to_string_lossy().to_lowercase())[..16]));
		let _ = std::fs::remove_dir_all(&d);
	}
}
