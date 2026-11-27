// Claude 구독 사용량 — 5시간 · 주간 한도를 얼마나 썼는지 Anthropic 에 묻는다 (화면 「대화」 머리 · 「설정 › Claude」).
//
// 길: Claude Code 가 로그인하며 남긴 OAuth 토큰(<설정 폴더>/.credentials.json 의 claudeAiOauth.accessToken)으로
//     GET https://api.anthropic.com/api/oauth/usage 를 부른다. Claude Code 의 /usage 화면과 같은 곳이다.
//   - 토큰은 읽기만 한다. 만료됐어도 앱이 새로 받지 않는다 — 갱신 토큰을 쓰면 Claude Code 가 쥔 토큰이 바뀌어
//     그쪽 로그인이 꼬일 수 있다. 다음 Claude 턴에서 CLI 가 스스로 새로 받으면 다시 보인다.
//   - API 키로 쓰는 사람은 이 파일이 없다 — 구독 한도가 없으니 「없음」으로 답한다.
//   - 문서로 공개된 API 가 아니다. 모양이 바뀌면 아는 칸만 골라 쓰고 모르는 칸은 버린다.
// 2026.11.27 : 대화 머리에 늘 보이므로 1분 안에 다시 물으면 지난 답을 준다 — 창 여러 개 · 턴마다 부르는 것이 한도(429)에 걸리지 않게.

use crate::{Res, err};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const URL: &str = "https://api.anthropic.com/api/oauth/usage";
const FRESH: Duration = Duration::from_secs(60);

/// 한도 하나. used 는 0~100 (%) · resets_at 은 ISO 시각
#[derive(Serialize, Clone)]
pub struct Window {
	/// five_hour · seven_day · seven_day_<모델> — 화면이 이름을 고른다
	key: String,
	/// 모델 한도일 때 모델 이름 (Opus · Sonnet · Fable …)
	model: Option<String>,
	used: f64,
	resets_at: Option<String>,
}

/// state: ok(windows 가 있다) · none(구독 로그인 없음, API 키 등) · expired(토큰 만료, 다음 턴에 CLI 가 갱신) · error(묻지 못함)
#[derive(Serialize, Clone)]
pub struct Usage {
	state: &'static str,
	plan: Option<String>,
	windows: Vec<Window>,
	error: Option<String>,
	/// 받은 시각 (유닉스 밀리초)
	at: u64,
}

static LAST: Mutex<Option<(Instant, Usage)>> = Mutex::new(None);

fn now_ms() -> u64 {
	SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// claude.rs 의 transcript 자리와 같은 규칙 — CLAUDE_CONFIG_DIR 이 있으면 그곳
fn credentials_path() -> Option<PathBuf> {
	std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).or_else(|| dirs::home_dir().map(|h| h.join(".claude"))).map(|d| d.join(".credentials.json"))
}

fn plain(state: &'static str, plan: Option<String>, error: Option<String>) -> Usage {
	Usage { state, plan, windows: vec![], error, at: now_ms() }
}

/// 응답에서 아는 한도만 뽑는다. 낡은 평평한 칸(five_hour · seven_day · seven_day_<모델>)과
/// 새 모델이 쓰는 limits[] (kind = weekly_scoped · scope.model.display_name) 를 함께 본다 — 같은 모델은 한 번만
fn parse(v: &Value) -> Vec<Window> {
	let win = |raw: &Value, key: String, model: Option<String>, field: &str| -> Option<Window> {
		let used = raw.get(field)?.as_f64()?;
		Some(Window { key, model, used: used.clamp(0.0, 100.0), resets_at: raw.get("resets_at").and_then(Value::as_str).map(str::to_string) })
	};
	let mut out = vec![];
	for key in ["five_hour", "seven_day"] {
		if let Some(w) = v.get(key).and_then(|r| win(r, key.into(), None, "utilization")) {
			out.push(w);
		}
	}
	if let Some(obj) = v.as_object() {
		for (k, raw) in obj {
			let Some(m) = k.strip_prefix("seven_day_") else { continue };
			// seven_day_oauth_apps 같은 모델 아닌 칸은 건너뛴다 — 모델 이름은 낱말 하나다
			if m.contains('_') || raw.is_null() {
				continue;
			}
			let name = m[..1].to_uppercase() + &m[1..];
			if let Some(w) = win(raw, k.clone(), Some(name), "utilization") {
				out.push(w);
			}
		}
	}
	for l in v.get("limits").and_then(Value::as_array).into_iter().flatten() {
		if l.get("kind").and_then(Value::as_str) != Some("weekly_scoped") {
			continue;
		}
		let Some(name) = l.pointer("/scope/model/display_name").and_then(Value::as_str) else { continue };
		if out.iter().any(|w| w.model.as_deref().is_some_and(|m| m.eq_ignore_ascii_case(name))) {
			continue;
		}
		if let Some(w) = win(l, format!("seven_day_{}", name.to_lowercase()), Some(name.to_string()), "percent") {
			out.push(w);
		}
	}
	out
}

async fn fetch() -> Usage {
	let Some(path) = credentials_path() else { return plain("none", None, None) };
	let Ok(text) = std::fs::read_to_string(&path) else { return plain("none", None, None) };
	let Ok(creds) = serde_json::from_str::<Value>(&text) else { return plain("error", None, Some("로그인 정보를 읽지 못했다".into())) };
	let oauth = &creds["claudeAiOauth"];
	let plan = oauth["subscriptionType"].as_str().map(str::to_string);
	let Some(token) = oauth["accessToken"].as_str().filter(|t| !t.is_empty()) else { return plain("none", plan, None) };
	if oauth["expiresAt"].as_u64().is_some_and(|e| e <= now_ms()) {
		return plain("expired", plan, None);
	}
	let client = match reqwest::Client::builder().user_agent(concat!("ClaudePPT/", env!("CARGO_PKG_VERSION"))).timeout(Duration::from_secs(8)).build() {
		Ok(c) => c,
		Err(e) => return plain("error", plan, Some(err(e))),
	};
	let res = client.get(URL).bearer_auth(token).header("anthropic-beta", "oauth-2025-04-20").header("Accept", "application/json").send().await;
	let res = match res {
		Ok(r) => r,
		Err(e) => return plain("error", plan, Some(err(e))),
	};
	let status = res.status();
	// 401 은 서버 쪽에서 토큰을 버린 것 — 만료와 같게 다음 턴의 CLI 갱신을 기다린다
	if status.as_u16() == 401 {
		return plain("expired", plan, None);
	}
	if !status.is_success() {
		return plain("error", plan, Some(format!("HTTP {}", status.as_u16())));
	}
	match res.json::<Value>().await {
		Ok(v) => {
			let windows = parse(&v);
			if windows.is_empty() {
				return plain("error", plan, Some("알 수 없는 응답".into()));
			}
			Usage { state: "ok", plan, windows, error: None, at: now_ms() }
		}
		Err(e) => plain("error", plan, Some(err(e))),
	}
}

/// force 면 1분 안이어도 다시 묻는다 (「새로 고침」 단추)
#[tauri::command]
pub async fn claude_usage(force: bool) -> Res<Usage> {
	if !force {
		if let Some((t, u)) = LAST.lock().unwrap().as_ref() {
			if t.elapsed() < FRESH {
				return Ok(u.clone());
			}
		}
	}
	let u = fetch().await;
	// 묻지 못한 답은 남기지 않는다 — 다음에 다시 묻게
	if u.state == "ok" {
		*LAST.lock().unwrap() = Some((Instant::now(), u.clone()));
	}
	Ok(u)
}

#[cfg(test)]
mod tests {
	use super::*;
	use serde_json::json;

	#[test]
	fn parse_reads_flat_fields_and_scoped_limits_once() {
		let v = json!({
			"five_hour": { "utilization": 32.0, "resets_at": "2026-11-27T10:00:00Z" },
			"seven_day": { "utilization": 12.5, "resets_at": null },
			"seven_day_sonnet": { "utilization": 4.0, "resets_at": null },
			"seven_day_opus": null,
			"seven_day_oauth_apps": { "utilization": 1.0 },
			"limits": [
				{ "kind": "weekly_scoped", "percent": 7.0, "resets_at": "2026-12-01T00:00:00Z", "scope": { "model": { "display_name": "Fable" } } },
				{ "kind": "weekly_scoped", "percent": 99.0, "scope": { "model": { "display_name": "Sonnet" } } },
				{ "kind": "something_else", "percent": 50.0 }
			]
		});
		let w = parse(&v);
		let keys: Vec<&str> = w.iter().map(|x| x.key.as_str()).collect();
		assert_eq!(keys, ["five_hour", "seven_day", "seven_day_sonnet", "seven_day_fable"]);
		assert_eq!(w[0].used, 32.0);
		assert_eq!(w[2].model.as_deref(), Some("Sonnet"));
		assert_eq!(w[2].used, 4.0, "평평한 칸이 있으면 limits[] 의 같은 모델은 버린다");
		assert_eq!(w[3].used, 7.0);
	}

	#[test]
	fn parse_clamps_and_ignores_unknown_shapes() {
		assert!(parse(&json!({ "five_hour": { "utilization": "x" } })).is_empty());
		assert_eq!(parse(&json!({ "five_hour": { "utilization": 140.0 } }))[0].used, 100.0);
	}
}
