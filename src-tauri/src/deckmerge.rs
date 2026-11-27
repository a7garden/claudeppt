// deck.json 합치기 (2026.11.27): 덱 목차 한 파일을 git 줄 합치기 대신 쪽 id · 칸 단위로 3방향 합친다.
//
// deck.json 은 쪽 순서의 유일한 정본이다. 줄 합치기로는 두 사람이 쪽을 하나씩 더하기만 해도 slides 배열의 같은 자리에서 겹친다.
// 그래서 가지 넣기 · 턴 얹기 · 보류 다시 넣기가 겹침으로 멈췄다. 분산 협업(design/분산 협업)에서는 제안끼리 늘 이렇게 겹치게 된다.
//
//   걸기      덱의 .gitattributes 에 「deck.json merge=cpptdeck」 (vcs_init · 서명 사슬 창세에 쓴다)
//             드라이버 명령은 vcs::git 이 매번 -c merge.cpptdeck.driver 로 준다: 사용자 git 설정에 기대지 않고,
//             앱 밖 git 으로 합치면 드라이버가 없어 보통 줄 합치기로 돌아간다(깨지지 않는다)
//   드라이버  같은 실행 파일의 CLI 「merge-deck <바탕> <내 것> <남의 것>」 (cli.rs): 결과를 <내 것> 에 쓰고, 겹치면 1 로 끝난다
//   규칙      쪽은 id 집합으로 본다. 한쪽만 더한 쪽은 들어가고 한쪽만 뺀 쪽은 빠진다.
//             순서는 한쪽만 옮겼으면 그쪽을, 둘 다 같게 옮겼으면 그것을 따른다. 둘이 다르게 옮기면 겹침이다.
//             쪽 하나의 칸(title · notes · hidden …)과 덱 칸(title · size · theme · page …)은 칸마다 3방향으로 본다.
//             한쪽이 뺀 쪽을 다른 쪽이 고쳤으면 겹침이다

use serde_json::{Map, Value};

pub const ATTRS: &str = "# deck.json 은 쪽 단위로 합친다 (ClaudePPT merge-deck)\ndeck.json merge=cpptdeck\n";

/// 칸 하나의 3방향: 같으면 그것, 한쪽만 바꿨으면 바꾼 쪽, 둘이 다르게 바꿨으면 None(겹침). 없는 칸은 None 값이 아니라 Option 의 None 으로 받는다
fn pick<'a>(o: Option<&'a Value>, a: Option<&'a Value>, b: Option<&'a Value>) -> Result<Option<&'a Value>, ()> {
	if a == b {
		Ok(a)
	} else if a == o {
		Ok(b)
	} else if b == o {
		Ok(a)
	} else {
		Err(())
	}
}

/// 객체의 칸마다 3방향: 칸 순서는 a 를 따르고 b 에만 생긴 칸은 끝에 붙인다
fn fields(o: Option<&Map<String, Value>>, a: &Map<String, Value>, b: &Map<String, Value>, skip: &[&str], at: &str, bad: &mut Vec<String>) -> Map<String, Value> {
	let mut keys: Vec<&String> = a.keys().collect();
	keys.extend(b.keys().filter(|k| !a.contains_key(*k)));
	if let Some(o) = o {
		keys.extend(o.keys().filter(|k| !a.contains_key(*k) && !b.contains_key(*k)));
	}
	let mut out = Map::new();
	for k in keys.into_iter().filter(|k| !skip.contains(&k.as_str())) {
		match pick(o.and_then(|o| o.get(k)), a.get(k), b.get(k)) {
			Ok(Some(v)) => {
				out.insert(k.clone(), v.clone());
			}
			Ok(None) => {}
			Err(()) => {
				bad.push(format!("{at}{k}"));
				if let Some(v) = a.get(k) {
					out.insert(k.clone(), v.clone());
				}
			}
		}
	}
	out
}

fn slides(v: &Value) -> Vec<(String, Map<String, Value>)> {
	v.get("slides")
		.and_then(Value::as_array)
		.map(|l| l.iter().filter_map(|s| Some((s.get("id")?.as_str()?.to_string(), s.as_object()?.clone()))).collect())
		.unwrap_or_default()
}

/// x 의 순서에서 새 쪽(new)을 앞 이웃 바로 뒤에 넣는다. 앞 이웃이 결과에 없으면 맨 앞
fn insert_new(list: &mut Vec<String>, order: &[String], new: &[String]) {
	for (i, id) in order.iter().enumerate() {
		if !new.contains(id) || list.contains(id) {
			continue;
		}
		let at = order[..i].iter().rev().find_map(|p| list.iter().position(|x| x == p)).map(|p| p + 1).unwrap_or(0);
		list.insert(at, id.clone());
	}
}

/// 세 판을 합친다. 겹치면 겹친 곳 목록을 돌려준다
pub fn merge(o: &Value, a: &Value, b: &Value) -> Result<Value, Vec<String>> {
	let mut bad = vec![];
	let (oo, ao, bo) = (o.as_object(), a.as_object().ok_or(vec!["내 판이 객체가 아니다".to_string()])?, b.as_object().ok_or(vec!["남의 판이 객체가 아니다".to_string()])?);
	let mut top = fields(oo, ao, bo, &["slides"], "", &mut bad);

	let (os, as_, bs) = (slides(o), slides(a), slides(b));
	let get = |l: &[(String, Map<String, Value>)], id: &str| l.iter().find(|(x, _)| x == id).map(|(_, m)| m.clone());
	let ids = |l: &[(String, Map<String, Value>)]| l.iter().map(|(x, _)| x.clone()).collect::<Vec<_>>();
	let (oi, ai, bi) = (ids(&os), ids(&as_), ids(&bs));
	let mut union = ai.clone();
	union.extend(bi.iter().filter(|x| !ai.contains(x)).cloned());
	union.extend(oi.iter().filter(|x| !ai.contains(x) && !bi.contains(x)).cloned());

	let mut merged: Vec<(String, Map<String, Value>)> = vec![];
	for id in &union {
		let (so, sa, sb) = (get(&os, id), get(&as_, id), get(&bs, id));
		let at = format!("slides[{id}].");
		match (&so, &sa, &sb) {
			(_, Some(x), Some(y)) => merged.push((id.clone(), fields(so.as_ref(), x, y, &[], &at, &mut bad))),
			(None, Some(x), None) | (None, None, Some(x)) => merged.push((id.clone(), x.clone())),
			// 한쪽이 뺐다: 다른 쪽이 고치지 않았으면 빠지고, 고쳤으면 겹침(고친 것을 남긴다)
			(Some(base), Some(x), None) | (Some(base), None, Some(x)) => {
				if x != base {
					bad.push(format!("slides[{id}]"));
					merged.push((id.clone(), x.clone()));
				}
			}
			(_, None, None) => {}
		}
	}

	// 순서: 셋 모두에 있던 쪽의 순서를 먼저 정하고, 새로 생긴 쪽을 그것을 더한 쪽의 앞 이웃 뒤에 넣는다
	let keep: Vec<String> = merged.iter().map(|(x, _)| x.clone()).collect();
	let common = |l: &[String]| l.iter().filter(|x| oi.contains(x) && keep.contains(x)).cloned().collect::<Vec<_>>();
	let (co, ca, cb) = (common(&oi), common(&ai), common(&bi));
	let mut order = if ca == co {
		cb.clone()
	} else if cb == co || ca == cb {
		ca.clone()
	} else {
		bad.push("slides 순서".into());
		ca.clone()
	};
	// 겹쳐서 남긴 쪽(한쪽은 뺐는데 다른 쪽이 고친 쪽)은 셋 중 어디엔가 있던 자리로
	let extra: Vec<String> = keep.iter().filter(|x| oi.contains(x) && !order.contains(x)).cloned().collect();
	insert_new(&mut order, &ai, &extra);
	insert_new(&mut order, &bi, &extra);
	let new_a: Vec<String> = ai.iter().filter(|x| !oi.contains(x) && keep.contains(x)).cloned().collect();
	let new_b: Vec<String> = bi.iter().filter(|x| !oi.contains(x) && !ai.contains(x) && keep.contains(x)).cloned().collect();
	insert_new(&mut order, &ai, &new_a);
	insert_new(&mut order, &bi, &new_b);

	let list: Vec<Value> = order.iter().filter_map(|id| merged.iter().find(|(x, _)| x == id).map(|(_, m)| Value::Object(m.clone()))).collect();
	// slides 칸 자리는 내 판의 자리를 지킨다: 키 순서가 바뀐 군더더기 줄이 판에 남지 않게
	let mut out = Map::new();
	let mut placed = false;
	for k in ao.keys() {
		if k == "slides" {
			out.insert(k.clone(), Value::Array(list.clone()));
			placed = true;
		} else if let Some(x) = top.shift_remove(k) {
			out.insert(k.clone(), x);
		}
	}
	for (k, v) in top {
		out.insert(k, v);
	}
	if !placed {
		out.insert("slides".into(), Value::Array(list));
	}
	if bad.is_empty() { Ok(Value::Object(out)) } else { Err(bad) }
}

/// git 합치기 드라이버: merge-deck <바탕> <내 것> <남의 것>. 결과를 <내 것> 에 쓴다. 0 이면 합침, 1 이면 겹침(내 것은 그대로)
pub fn driver(args: &[String]) -> i32 {
	let read = |p: &str| std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
	let [o, a, b] = [args.first(), args.get(1), args.get(2)].map(|p| p.and_then(|p| read(p)));
	let (Some(a_path), Some(a), Some(b)) = (args.get(1), a, b) else { return 1 };
	// 바탕이 없으면(둘이 따로 만든 파일) 빈 바탕으로: 같은 칸이 다르면 겹침이 된다
	let o = o.unwrap_or(Value::Object(Map::new()));
	match merge(&o, &a, &b) {
		Ok(v) => match serde_json::to_string_pretty(&v) {
			Ok(t) if std::fs::write(a_path, format!("{t}\n")).is_ok() => 0,
			_ => 1,
		},
		Err(bad) => {
			eprintln!("deck.json 겹침: {}", bad.join(", "));
			1
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use serde_json::json;

	fn deck(slides: &[(&str, &str)]) -> Value {
		json!({ "format": "claudeppt/1", "title": "t", "slides": slides.iter().map(|(id, t)| json!({ "id": id, "file": format!("slides/{id}.html"), "title": t })).collect::<Vec<_>>(), "theme": "theme.css" })
	}
	fn order(v: &Value) -> Vec<String> {
		slides(v).into_iter().map(|(x, _)| x).collect()
	}

	#[test]
	fn each_adds_one_slide_without_conflict() {
		let o = deck(&[("a", "A"), ("b", "B")]);
		let a = deck(&[("a", "A"), ("x", "X"), ("b", "B")]);
		let b = deck(&[("a", "A"), ("b", "B"), ("y", "Y")]);
		let m = merge(&o, &a, &b).unwrap();
		assert_eq!(order(&m), ["a", "x", "b", "y"]);
		// 칸 순서 · slides 자리는 내 판 그대로
		assert_eq!(m.as_object().unwrap().keys().collect::<Vec<_>>(), ["format", "title", "slides", "theme"]);
	}

	#[test]
	fn both_add_at_the_same_place_keeps_both() {
		let o = deck(&[("a", "A")]);
		let a = deck(&[("a", "A"), ("x", "X")]);
		let b = deck(&[("a", "A"), ("y", "Y")]);
		assert_eq!(order(&merge(&o, &a, &b).unwrap()), ["a", "y", "x"]);
	}

	#[test]
	fn one_side_moves_and_the_other_adds() {
		let o = deck(&[("a", "A"), ("b", "B"), ("c", "C")]);
		let a = deck(&[("c", "C"), ("a", "A"), ("b", "B")]);
		let b = deck(&[("a", "A"), ("b", "B"), ("y", "Y"), ("c", "C")]);
		assert_eq!(order(&merge(&o, &a, &b).unwrap()), ["c", "a", "b", "y"]);
		// 반대쪽에서 합쳐도 같은 순서
		assert_eq!(order(&merge(&o, &b, &a).unwrap()), ["c", "a", "b", "y"]);
	}

	#[test]
	fn different_moves_conflict() {
		let o = deck(&[("a", "A"), ("b", "B"), ("c", "C")]);
		let a = deck(&[("c", "C"), ("a", "A"), ("b", "B")]);
		let b = deck(&[("b", "B"), ("a", "A"), ("c", "C")]);
		assert_eq!(merge(&o, &a, &b).unwrap_err(), ["slides 순서"]);
	}

	#[test]
	fn removed_slide_goes_unless_the_other_edited_it() {
		let o = deck(&[("a", "A"), ("b", "B")]);
		let a = deck(&[("a", "A")]);
		assert_eq!(order(&merge(&o, &a, &o).unwrap()), ["a"]);
		let b = deck(&[("a", "A"), ("b", "새 제목")]);
		assert_eq!(merge(&o, &a, &b).unwrap_err(), ["slides[b]"]);
	}

	#[test]
	fn fields_merge_one_by_one() {
		let o = deck(&[("a", "A"), ("b", "B")]);
		let mut a = deck(&[("a", "가"), ("b", "B")]);
		let mut b = deck(&[("a", "A"), ("b", "나")]);
		a["title"] = json!("덱 이름");
		b["size"] = json!({ "w": 1280, "h": 720 });
		let m = merge(&o, &a, &b).unwrap();
		assert_eq!((m["title"].as_str(), m["slides"][0]["title"].as_str(), m["slides"][1]["title"].as_str()), (Some("덱 이름"), Some("가"), Some("나")));
		assert_eq!(m["size"]["w"], 1280);
		// 같은 칸을 둘이 다르게
		let b = deck(&[("a", "다"), ("b", "B")]);
		assert_eq!(merge(&o, &a, &b).unwrap_err(), ["slides[a].title"]);
	}

	#[test]
	fn driver_writes_ours_and_reports_conflicts() {
		let dir = std::env::temp_dir().join(format!("cppt-deckmerge-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let p = |n: &str| dir.join(n).to_string_lossy().into_owned();
		std::fs::write(p("o"), deck(&[("a", "A")]).to_string()).unwrap();
		std::fs::write(p("a"), deck(&[("a", "A"), ("x", "X")]).to_string()).unwrap();
		std::fs::write(p("b"), deck(&[("a", "A"), ("y", "Y")]).to_string()).unwrap();
		assert_eq!(driver(&[p("o"), p("a"), p("b")]), 0);
		let got: Value = serde_json::from_str(&std::fs::read_to_string(p("a")).unwrap()).unwrap();
		assert_eq!(order(&got), ["a", "y", "x"]);
		std::fs::write(p("b"), "not json").unwrap();
		assert_eq!(driver(&[p("o"), p("a"), p("b")]), 1);
		let _ = std::fs::remove_dir_all(&dir);
	}
}
