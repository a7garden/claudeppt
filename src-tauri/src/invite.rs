// 협업 초대 장부 — 링크 · 들어온 기기 · 잠금. 앱 데이터 폴더의 collab.json 에 둔다 (덱 폴더 · .cppt 에는 들지 않는다).
//
//   링크   공용: 들어올 때 이름을 한 번 적는다(여럿이 같이 쓴다) · 개인: 만들 때 정한 이름으로 바로 들어온다.
//          만료를 둘 수 있다. 호스트가 다음 날에도 같은 링크를 다시 복사할 수 있게 링크 열쇠는 그대로 둔다 — 이 PC 앱 데이터에만 있다
//   기기   링크로 들어온 브라우저 하나. 기기 열쇠(쿠키)는 SHA-256 해시로만 둔다 — 파일이 새어도 그 브라우저인 척 못 한다.
//          한 번 들어오면 링크가 만료되거나 지워져도 그 기기는 그대로 들어온다(줌처럼). 내보내면 그 기기 열쇠가 지워진다
//   잠금   켜면 새 기기가 들어오지 못한다. 이미 들어온 기기는 그대로

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Book {
	#[serde(default)]
	pub links: Vec<Link>,
	#[serde(default)]
	pub devices: Vec<Device>,
	#[serde(default)]
	pub locked: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Link {
	pub id: String,
	pub token: String,
	/// 개인 링크면 그 사람 이름. None 이면 공용
	pub name: Option<String>,
	pub created: i64,
	pub expires: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Device {
	pub id: String,
	pub hash: String,
	pub name: String,
	/// 들어온 링크 id
	pub link: String,
	pub created: i64,
	pub seen: i64,
	/// 「내 Claude」 전용 열쇠의 해시 (runner.rs) — 공유 덱 창 없이 앱을 켜자마자 붙는다. 기기를 내보내면 함께 사라진다
	#[serde(default)]
	pub runner: Option<String>,
	/// 덱 주인이 정한 권한 (2026.11.27) — 없는 장부(옛 collab.json)는 「편집」이라 지금까지처럼 다 한다
	#[serde(default)]
	pub role: Role,
	/// 담당 쪽만 보인다 (2026.11.27) — 덱 주인이 켜면 맡지 않은 쪽은 내용 없이 자리만 간다(collab.rs limit_view).
	/// 권한(무엇을 하나)과 따로다 — 「편집」이면서 남의 쪽은 못 볼 수도, 「보기만」이면서 맡은 쪽만 볼 수도 있다
	#[serde(default)]
	pub limit: bool,
}

/// 팀원 권한 — 덱 주인이 공유 창 「들어온 사람」에서 사람마다 고른다. 막는 곳은 collab.rs(의도 이름) · collab.ts(어느 쪽인가)
///   edit      모든 쪽을 고치고 Claude 에 요청한다 (기본 · 전과 같다)
///   assigned  덱 주인이 맡긴 쪽만 고친다 — 직접 편집 · 요청 · 되돌리기가 그 쪽에만. 의견은 어느 쪽에나
///   comment   의견(핀)만 남긴다
///   view      보기만
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Role {
	#[default]
	Edit,
	Assigned,
	Comment,
	/// 모르는 값(앞으로 생길 권한을 옛 앱이 읽을 때)은 가장 좁은 「보기만」으로 — 장부 전체를 못 읽어 모든 기기가 사라지지 않게
	#[serde(other)]
	View,
}

impl Role {
	/// 이 권한으로 부를 수 있는 의도인가 — 쪽을 가리는 것은 덱 주인 화면이 한다(담당은 덱마다 다르고 서버는 모른다)
	pub fn allows(self, intent: &str) -> bool {
		match self {
			Role::Edit | Role::Assigned => true,
			Role::Comment => matches!(intent, "pinAdd" | "pinUpdate" | "pinRemove" | "pinResolve"),
			Role::View => false,
		}
	}
}

#[derive(Debug, PartialEq)]
pub enum Why {
	Unknown,
	Expired,
	Locked,
}

pub fn hash(secret: &str) -> String {
	Sha256::digest(secret.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn random() -> String {
	format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// 이름 다듬기 — 앞뒤 빈칸 · 제어 문자를 빼고 40자까지
pub fn clean_name(s: &str) -> String {
	s.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(40).collect()
}

impl Book {
	pub fn load(path: &Path) -> Book {
		std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
	}

	pub fn save(&self, path: &Path) {
		if let Some(d) = path.parent() {
			let _ = std::fs::create_dir_all(d);
		}
		let _ = std::fs::write(path, serde_json::to_string_pretty(self).unwrap_or_default());
	}

	/// 공용 링크가 없으면 하나 만든다 — 켜자마자 나눌 링크가 있게
	pub fn ensure_public(&mut self, now: i64) {
		if !self.links.iter().any(|l| l.name.is_none() && l.expires.is_none_or(|e| e > now)) {
			self.new_link(None, None, now);
		}
	}

	pub fn new_link(&mut self, name: Option<String>, hours: Option<u32>, now: i64) -> Link {
		let l = Link {
			id: uuid::Uuid::new_v4().simple().to_string()[..8].to_string(),
			token: random(),
			name: name.map(|n| clean_name(&n)).filter(|n| !n.is_empty()),
			created: now,
			expires: hours.filter(|h| *h > 0).map(|h| now + h as i64 * 3600 * 1000),
		};
		self.links.push(l.clone());
		l
	}

	pub fn remove_link(&mut self, id: &str) {
		self.links.retain(|l| l.id != id);
	}

	/// 링크로 들어올 수 있는가 — 열쇠 비교는 길이 · 글자마다 같은 시간
	pub fn link(&self, token: &str, now: i64) -> Result<&Link, Why> {
		let l = self.links.iter().find(|l| same(&l.token, token)).ok_or(Why::Unknown)?;
		if l.expires.is_some_and(|e| e <= now) {
			return Err(Why::Expired);
		}
		if self.locked {
			return Err(Why::Locked);
		}
		Ok(l)
	}

	/// 들어온다 — 기기를 만들고 기기 열쇠(쿠키에 넣을 것)를 돌려준다. 개인 링크는 그 이름, 공용은 적은 이름.
	/// reserved 는 기기 장부 밖에서 이미 쓰는 이름(호스트)
	pub fn join(&mut self, link: &Link, name: &str, reserved: &[String], now: i64) -> (Device, String) {
		let secret = random();
		// 개인 링크는 호스트가 정한 한 사람이라 휴대폰 · 노트북으로 두 번 들어와도 같은 이름이다
		let name = link.name.clone().unwrap_or_else(|| self.unique(&clean_name(name), reserved));
		// 같은 이름(개인 링크로 두 기기)으로 이미 들어온 사람이면 그 권한을 잇는다 — 휴대폰으로 들어왔다고 보기만이 편집이 되지 않게
		let role = self.devices.iter().find(|d| d.name == name).map(|d| d.role).unwrap_or_default();
		// 열람 제한도 사람을 따른다 — 휴대폰으로 다시 들어와 남의 쪽이 보이지 않게
		let limit = self.devices.iter().any(|d| d.name == name && d.limit);
		let d = Device { id: uuid::Uuid::new_v4().simple().to_string()[..10].to_string(), hash: hash(&secret), name, link: link.id.clone(), created: now, seen: now, runner: None, role, limit };
		self.devices.push(d.clone());
		(d, secret)
	}

	/// 공용 링크로 적은 이름이 이미 있으면 뒤에 번호를 붙인다 (2026.11.26).
	/// 핀 주인 · 되돌리기 걸음 · 요청 보낸 사람을 이름으로 가르므로, 이름이 같은 두 사람은 서로의 의견을 지우고 서로의 편집을 되돌린다
	fn unique(&self, name: &str, reserved: &[String]) -> String {
		let taken = |n: &str| self.devices.iter().any(|d| d.name == n) || reserved.iter().any(|r| r == n);
		if !taken(name) {
			return name.to_string();
		}
		(2..).map(|i| format!("{name} {i}")).find(|n| !taken(n)).unwrap_or_default()
	}

	/// 기기 열쇠로 찾는다 (마지막으로 본 때를 적는다)
	pub fn device(&mut self, secret: &str, now: i64) -> Option<Device> {
		let h = hash(secret);
		let d = self.devices.iter_mut().find(|d| same(&d.hash, &h))?;
		d.seen = now;
		Some(d.clone())
	}

	/// 그 기기의 「내 Claude」 열쇠를 새로 만든다 — 앞의 열쇠는 무효가 된다. 열쇠 글은 이때 한 번만 돌려주고 해시만 남긴다
	pub fn runner_key(&mut self, device: &str) -> Option<String> {
		let d = self.devices.iter_mut().find(|d| d.id == device)?;
		let secret = random();
		d.runner = Some(hash(&secret));
		Some(secret)
	}

	/// 「내 Claude」 열쇠로 기기를 찾는다
	pub fn device_by_runner(&mut self, secret: &str, now: i64) -> Option<Device> {
		let h = hash(secret);
		let d = self.devices.iter_mut().find(|d| d.runner.as_deref().is_some_and(|r| same(r, &h)))?;
		d.seen = now;
		Some(d.clone())
	}

	/// 권한을 바꾼다 — 그 기기와 이름이 같은 기기 모두. 담당 · 핀 · 되돌리기가 이름으로 가르므로 권한도 사람(이름) 단위다
	pub fn set_role(&mut self, id: &str, role: Role) -> bool {
		let Some(name) = self.devices.iter().find(|d| d.id == id).map(|d| d.name.clone()) else { return false };
		for d in self.devices.iter_mut().filter(|d| d.name == name) {
			d.role = role;
		}
		true
	}

	pub fn role_of(&self, id: &str) -> Role {
		self.devices.iter().find(|d| d.id == id).map(|d| d.role).unwrap_or_default()
	}

	/// 담당 쪽만 보이게 한다 — 그 사람(같은 이름의 기기 모두)에게
	pub fn set_limit(&mut self, id: &str, on: bool) -> bool {
		let Some(name) = self.devices.iter().find(|d| d.id == id).map(|d| d.name.clone()) else { return false };
		for d in self.devices.iter_mut().filter(|d| d.name == name) {
			d.limit = on;
		}
		true
	}

	/// 그 기기가 담당 쪽만 보면 그 사람 이름
	pub fn limited(&self, id: &str) -> Option<String> {
		self.devices.iter().find(|d| d.id == id && d.limit).map(|d| d.name.clone())
	}

	pub fn remove_device(&mut self, id: &str) -> bool {
		let n = self.devices.len();
		self.devices.retain(|d| d.id != id);
		n != self.devices.len()
	}
}

/// 같은 길이 · 같은 글자인지 — 글자마다 비교 시간을 같게 (열쇠를 한 글자씩 알아내지 못하게)
pub fn same(a: &str, b: &str) -> bool {
	a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn public_link_asks_name_personal_link_fixes_it() {
		let mut b = Book::default();
		b.ensure_public(0);
		assert_eq!(b.links.len(), 1);
		b.ensure_public(0);
		assert_eq!(b.links.len(), 1, "공용 링크는 하나만 만든다");
		let public = b.links[0].clone();
		let (d, secret) = b.join(&public, "  민수\n", &[], 1);
		assert_eq!(d.name, "민수");
		assert_ne!(d.hash, secret, "기기 열쇠는 해시로만 둔다");
		assert_eq!(b.device(&secret, 5).unwrap().seen, 5);
		assert!(b.device("wrong", 5).is_none());
		let personal = b.new_link(Some("지호".into()), None, 1);
		let (d2, _) = b.join(&personal, "아무 이름", &[], 1);
		assert_eq!(d2.name, "지호");
	}

	#[test]
	fn expired_unknown_and_locked_links_are_refused() {
		let mut b = Book::default();
		let l = b.new_link(None, Some(1), 0);
		assert!(b.link(&l.token, 1000).is_ok());
		assert_eq!(b.link(&l.token, 3600 * 1000).err(), Some(Why::Expired));
		assert_eq!(b.link("nope", 0).err(), Some(Why::Unknown));
		let l2 = b.new_link(None, None, 0);
		let (_, secret) = b.join(&l2, "a", &[], 0);
		b.locked = true;
		assert_eq!(b.link(&l2.token, 0).err(), Some(Why::Locked));
		assert!(b.device(&secret, 0).is_some(), "잠가도 이미 들어온 기기는 그대로");
		// 만료된 공용 링크만 있으면 새로 만든다
		let mut c = Book::default();
		c.new_link(None, Some(1), 0);
		c.ensure_public(7200 * 1000);
		assert_eq!(c.links.len(), 2);
	}

	#[test]
	fn kicked_device_cannot_come_back_with_its_cookie() {
		let mut b = Book::default();
		b.ensure_public(0);
		let l = b.links[0].clone();
		let (d, secret) = b.join(&l, "a", &[], 0);
		assert!(b.remove_device(&d.id));
		assert!(b.device(&secret, 0).is_none());
		assert!(!b.remove_device(&d.id));
	}

	#[test]
	fn saves_and_loads() {
		let p = std::env::temp_dir().join(format!("cppt-invite-{}.json", std::process::id()));
		let mut b = Book::default();
		b.ensure_public(0);
		let l = b.links[0].clone();
		let (_, secret) = b.join(&l, "민수", &[], 0);
		b.save(&p);
		let mut c = Book::load(&p);
		assert_eq!(c.device(&secret, 1).unwrap().name, "민수");
		assert!(!std::fs::read_to_string(&p).unwrap().contains(&secret), "기기 열쇠가 파일에 그대로 남지 않는다");
		let _ = std::fs::remove_file(p);
	}

	#[test]
	fn same_name_on_public_link_gets_a_number() {
		let mut b = Book::default();
		b.ensure_public(0);
		let l = b.links[0].clone();
		assert_eq!(b.join(&l, "민수", &[], 0).0.name, "민수");
		assert_eq!(b.join(&l, "민수", &[], 0).0.name, "민수 2");
		assert_eq!(b.join(&l, "민수", &[], 0).0.name, "민수 3");
		assert_eq!(b.join(&l, "지호", &["지호".into()], 0).0.name, "지호 2", "호스트 이름과도 겹치지 않는다");
		let p = b.new_link(Some("민수".into()), None, 0);
		assert_eq!(b.join(&p, "", &[], 0).0.name, "민수", "개인 링크는 정한 이름 그대로");
	}

	#[test]
	fn runner_key_replaces_and_dies_with_device() {
		let mut b = Book::default();
		b.ensure_public(0);
		let l = b.links[0].clone();
		let (d, cookie) = b.join(&l, "민수", &[], 0);
		let k1 = b.runner_key(&d.id).unwrap();
		assert_eq!(b.device_by_runner(&k1, 1).unwrap().id, d.id);
		assert!(b.device_by_runner(&cookie, 1).is_none(), "기기 쿠키는 「내 Claude」 열쇠가 아니다");
		let k2 = b.runner_key(&d.id).unwrap();
		assert!(b.device_by_runner(&k1, 1).is_none(), "새로 만들면 앞 열쇠는 무효");
		assert!(b.device_by_runner(&k2, 1).is_some());
		assert!(!serde_json::to_string(&b).unwrap().contains(&k2), "열쇠 글은 장부에 남지 않는다");
		b.remove_device(&d.id);
		assert!(b.device_by_runner(&k2, 1).is_none(), "내보내면 열쇠도 사라진다");
		assert!(b.runner_key("없는 기기").is_none());
	}

	#[test]
	fn limit_follows_the_person() {
		let mut b = Book::default();
		let p = b.new_link(Some("민수".into()), None, 0);
		let (phone, _) = b.join(&p, "", &[], 0);
		assert_eq!(b.limited(&phone.id), None, "처음은 모두 보인다");
		assert!(b.set_limit(&phone.id, true));
		let (laptop, _) = b.join(&p, "", &[], 0);
		assert_eq!(b.limited(&laptop.id).as_deref(), Some("민수"), "같은 사람의 새 기기도 제한된다");
		b.set_limit(&laptop.id, false);
		assert_eq!(b.limited(&phone.id), None);
		let old: Device = serde_json::from_str(r#"{"id":"a","hash":"h","name":"n","link":"l","created":0,"seen":0}"#).unwrap();
		assert!(!old.limit, "옛 장부는 제한 없음");
	}

	#[test]
	fn roles_follow_the_person_and_gate_intents() {
		let mut b = Book::default();
		let p = b.new_link(Some("민수".into()), None, 0);
		let (phone, _) = b.join(&p, "", &[], 0);
		assert_eq!(phone.role, Role::Edit, "처음은 편집 — 전과 같다");
		assert!(b.set_role(&phone.id, Role::Comment));
		let (laptop, _) = b.join(&p, "", &[], 0);
		assert_eq!(laptop.role, Role::Comment, "같은 사람의 새 기기는 그 권한을 잇는다");
		b.set_role(&laptop.id, Role::View);
		assert_eq!(b.role_of(&phone.id), Role::View, "권한은 이름 단위로 바뀐다");
		assert!(Role::Comment.allows("pinAdd") && !Role::Comment.allows("send") && !Role::Comment.allows("direct"));
		assert!(!Role::View.allows("pinAdd") && !Role::View.allows("upload"));
		assert!(Role::Assigned.allows("direct"));
		// 옛 장부(role 없음)는 편집, 모르는 값은 보기만 — 어느 쪽이든 장부는 읽힌다
		let old: Device = serde_json::from_str(r#"{"id":"a","hash":"h","name":"n","link":"l","created":0,"seen":0}"#).unwrap();
		assert_eq!(old.role, Role::Edit);
		let odd: Device = serde_json::from_str(r#"{"id":"a","hash":"h","name":"n","link":"l","created":0,"seen":0,"role":"owner"}"#).unwrap();
		assert_eq!(odd.role, Role::View);
	}

	#[test]
	fn names_are_cleaned() {
		assert_eq!(clean_name(" 은\u{7}채 "), "은채");
		assert_eq!(clean_name(&"가".repeat(50)).chars().count(), 40);
	}
}
