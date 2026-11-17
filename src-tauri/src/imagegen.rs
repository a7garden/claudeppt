// 그림 만들기 — 슬라이드 안 <img data-gen="요청문"> 을 실제 그림 파일로 채운다.
//
// 기본은 「SVG」: Claude 가 그림을 SVG 로 직접 그려 이 모듈을 부르지 않는다.
// 그 밖의 공급자:
//   codex-cli   Codex CLI 의 그림 도구로 만든다 (codex exec)
//   gemini-cli  Gemini CLI 로 만든다. 그림 확장(예: nanobanana)이 깔려 있어야 한다
//   openai      OpenAI Images API (기본 모델 gpt-image-1)
//   gemini      Gemini API 이미지 모델 (기본 gemini-2.5-flash-image)
// CLI 두 가지는 그 도구가 파일을 정한 자리에 썼는지로 성공을 판단한다 — 도구 판이 바뀌면 동작이 달라질 수 있다.

use crate::{Res, err};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct Tool {
	name: String,
	path: Option<String>,
	version: String,
}

fn which(name: &str) -> Option<PathBuf> {
	let mut c = std::process::Command::new("where");
	crate::hidden(&mut c);
	let out = c.arg(name).output().ok()?;
	let text = String::from_utf8_lossy(&out.stdout).to_string();
	let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
	let pick = lines.iter().find(|l| l.to_ascii_lowercase().ends_with(".exe")).or_else(|| lines.iter().find(|l| l.to_ascii_lowercase().ends_with(".cmd")))?;
	Some(PathBuf::from(pick))
}

fn version(p: &Path) -> String {
	let mut c = cmd_for(p);
	c.arg("--version");
	c.output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}

/// .cmd 는 cmd /C 로 띄워야 한다.
fn cmd_for(p: &Path) -> std::process::Command {
	let mut c = if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd")) {
		let mut c = std::process::Command::new("cmd");
		c.arg("/C").arg(p);
		c
	} else {
		std::process::Command::new(p)
	};
	crate::hidden(&mut c);
	c
}

/// 설정 화면이 자동 감지에 쓴다 — 깔려 있는 그림 도구와 PowerPoint.
#[tauri::command]
pub async fn tools_detect() -> Res<Vec<Tool>> {
	tokio::task::spawn_blocking(|| {
		["codex", "gemini"]
			.iter()
			.map(|n| {
				let path = which(n);
				let version = path.as_deref().map(version).unwrap_or_default();
				Tool { name: n.to_string(), path: path.map(|p| p.to_string_lossy().into()), version }
			})
			.collect()
	})
	.await
	.map_err(err)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenSpec {
	provider: String,
	prompt: String,
	/// 만든 그림을 둘 절대 경로 (프로젝트의 assets/gen-<id>.png)
	out: String,
	#[serde(default)]
	api_key: String,
	#[serde(default)]
	model: String,
	/// "1536x1024" 처럼. 공급자가 받는 크기로 가깝게 맞춘다.
	#[serde(default)]
	size: String,
}

#[tauri::command]
pub async fn image_generate(spec: GenSpec) -> Res<String> {
	let out = PathBuf::from(&spec.out);
	if let Some(d) = out.parent() {
		std::fs::create_dir_all(d).map_err(err)?;
	}
	let bytes = match spec.provider.as_str() {
		"openai" => openai(&spec).await?,
		"gemini" => gemini_api(&spec).await?,
		"codex-cli" | "gemini-cli" => return cli(spec).await,
		p => return Err(format!("모르는 그림 공급자: {p}")),
	};
	std::fs::write(&out, bytes).map_err(err)?;
	Ok(spec.out)
}

async fn openai(s: &GenSpec) -> Res<Vec<u8>> {
	if s.api_key.is_empty() {
		return Err("OpenAI API 키가 없다".into());
	}
	let model = if s.model.is_empty() { "gpt-image-1" } else { &s.model };
	// gpt-image-1 이 받는 크기는 셋뿐이다 — 가로가 길면 1536x1024, 세로가 길면 1024x1536.
	let size = match ratio(&s.size) {
		r if r > 1.2 => "1536x1024",
		r if r < 0.83 => "1024x1536",
		_ => "1024x1024",
	};
	let res: Value = reqwest::Client::new()
		.post("https://api.openai.com/v1/images/generations")
		.bearer_auth(&s.api_key)
		.json(&json!({ "model": model, "prompt": s.prompt, "size": size, "n": 1 }))
		.send()
		.await
		.map_err(err)?
		.json()
		.await
		.map_err(err)?;
	if let Some(e) = res.get("error") {
		return Err(format!("OpenAI: {}", e.get("message").and_then(Value::as_str).unwrap_or("오류")));
	}
	let b = res.pointer("/data/0/b64_json").and_then(Value::as_str).ok_or("OpenAI 응답에 그림이 없다")?;
	B64.decode(b).map_err(err)
}

async fn gemini_api(s: &GenSpec) -> Res<Vec<u8>> {
	if s.api_key.is_empty() {
		return Err("Gemini API 키가 없다".into());
	}
	let model = if s.model.is_empty() { "gemini-2.5-flash-image" } else { &s.model };
	let url = format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent");
	let aspect = match ratio(&s.size) {
		r if r > 1.6 => "16:9",
		r if r > 1.2 => "4:3",
		r if r < 0.7 => "9:16",
		r if r < 0.83 => "3:4",
		_ => "1:1",
	};
	let res: Value = reqwest::Client::new()
		.post(url)
		.header("x-goog-api-key", &s.api_key)
		.json(&json!({
			"contents": [{ "parts": [{ "text": s.prompt }] }],
			"generationConfig": { "responseModalities": ["IMAGE"], "imageConfig": { "aspectRatio": aspect } }
		}))
		.send()
		.await
		.map_err(err)?
		.json()
		.await
		.map_err(err)?;
	if let Some(e) = res.get("error") {
		return Err(format!("Gemini: {}", e.get("message").and_then(Value::as_str).unwrap_or("오류")));
	}
	let parts = res.pointer("/candidates/0/content/parts").and_then(Value::as_array).ok_or("Gemini 응답에 그림이 없다")?;
	let b = parts.iter().find_map(|p| p.pointer("/inlineData/data").and_then(Value::as_str)).ok_or("Gemini 응답에 그림이 없다")?;
	B64.decode(b).map_err(err)
}

async fn cli(s: GenSpec) -> Res<String> {
	tokio::task::spawn_blocking(move || {
		let out = PathBuf::from(&s.out);
		let dir = out.parent().ok_or("저장 폴더가 없다")?.to_path_buf();
		let name = out.file_name().unwrap().to_string_lossy().to_string();
		let ask = format!(
			"Generate one raster image with your image generation tool and save it as the PNG file `{name}` in the current directory. \
			 Aspect ratio about {}. Do nothing else and do not edit other files.\n\nImage description:\n{}",
			if s.size.is_empty() { "16:9".into() } else { s.size.replace('x', ":") },
			s.prompt
		);
		let (tool, args): (&str, Vec<String>) = if s.provider == "codex-cli" {
			("codex", vec!["exec".into(), "--skip-git-repo-check".into(), "--sandbox".into(), "workspace-write".into(), ask])
		} else {
			("gemini", vec!["--yolo".into(), "-p".into(), ask])
		};
		let exe = which(tool).ok_or(format!("{tool} CLI 를 찾지 못했다"))?;
		let o = cmd_for(&exe).args(&args).current_dir(&dir).stdin(std::process::Stdio::null()).output().map_err(err)?;
		if out.exists() {
			return Ok(s.out);
		}
		let tail: String = String::from_utf8_lossy(&o.stderr).chars().rev().take(400).collect::<Vec<_>>().into_iter().rev().collect();
		Err(format!("{tool} 가 그림 파일을 만들지 않았다. {tail}"))
	})
	.await
	.map_err(err)?
}

fn ratio(size: &str) -> f64 {
	let mut it = size.split(['x', 'X', ':']).filter_map(|v| v.trim().parse::<f64>().ok());
	match (it.next(), it.next()) {
		(Some(w), Some(h)) if h > 0.0 => w / h,
		_ => 16.0 / 9.0,
	}
}
