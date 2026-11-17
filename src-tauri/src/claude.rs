// Claude Code CLI 를 헤드리스로 돌려 대화 한 턴을 실행한다. 출력(stream-json)은 줄마다 「claude」 사건으로 화면에 넘긴다.
//
// 격리 — 이 앱의 Claude 는 사용자의 다른 Claude 설정에 영향을 받지 않는다. 화면이 바꿀 수 없게 인자를 여기에 고정한다.
//   --safe-mode              CLAUDE.md · 스킬 · 플러그인 · 훅 · MCP · 출력 스타일을 끈다
//   --setting-sources ""     사용자 · 프로젝트 settings.json 도 읽지 않는다. --safe-mode 만으로는 응답 언어 같은
//                            사용자 설정이 남는다 (2026.11.17 CLI 2.1.325 실측: 없으면 영어 질문에 한국어로 답했다)
//   --system-prompt-file     기본 시스템 프롬프트를 이 앱의 프롬프트로 바꾼다 (화면 「설정 › Claude」에서 고친다)
//   --tools                  파일 읽기 · 쓰기만. 셸 · 웹은 주지 않는다 — 프로젝트 폴더 밖을 건드릴 길을 막는다
//   --permission-prompts none 물어볼 일이 생기면 기다리지 않고 거절한다 (헤드리스라 답할 사람이 없다)
// 구독 로그인(OAuth)은 그대로 쓴다. --bare 는 API 키만 받아 쓰지 않는다.

use crate::{AppState, Res, err};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const TOOLS: &str = "Read,Edit,Write,Glob,Grep";

#[derive(Serialize)]
pub struct Detected {
	path: String,
	version: String,
}

/// claude 실행 파일을 찾는다. npm 으로 깐 경우 claude.cmd 옆 node_modules 안의 claude.exe 를 바로 쓴다 —
/// cmd 를 거치면 빈 인자("")와 따옴표가 깨진다.
pub fn resolve(custom: &str) -> Option<PathBuf> {
	if !custom.trim().is_empty() {
		let p = PathBuf::from(custom.trim());
		return p.exists().then_some(p);
	}
	let mut c = std::process::Command::new("where");
	crate::hidden(&mut c);
	let out = c.arg("claude").output().ok()?;
	let text = String::from_utf8_lossy(&out.stdout).to_string();
	let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
	if let Some(exe) = lines.iter().find(|l| l.to_ascii_lowercase().ends_with(".exe")) {
		return Some(PathBuf::from(exe));
	}
	for l in &lines {
		if l.to_ascii_lowercase().ends_with(".cmd") {
			let exe = Path::new(l).parent()?.join("node_modules/@anthropic-ai/claude-code/bin/claude.exe");
			if exe.exists() {
				return Some(exe);
			}
		}
	}
	None
}

#[tauri::command]
pub async fn claude_detect(path: String) -> Res<Option<Detected>> {
	let Some(exe) = resolve(&path) else { return Ok(None) };
	let mut c = tokio::process::Command::new(&exe);
	c.arg("--version");
	#[cfg(windows)]
	c.creation_flags(0x0800_0000);
	let out = c.output().await.map_err(err)?;
	Ok(Some(Detected { path: exe.to_string_lossy().into(), version: String::from_utf8_lossy(&out.stdout).trim().to_string() }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSpec {
	turn: String,
	dir: String,
	prompt: String,
	system: String,
	claude_path: String,
	model: String,
	effort: String,
	resume: Option<String>,
}

#[derive(Serialize, Clone)]
struct Line {
	turn: String,
	line: String,
}

#[derive(Serialize, Clone)]
pub struct Done {
	turn: String,
	code: i32,
	stderr: String,
}

#[tauri::command]
pub async fn claude_run(app: AppHandle, state: State<'_, AppState>, spec: RunSpec) -> Res<Done> {
	let exe = resolve(&spec.claude_path).ok_or("claude 실행 파일을 찾지 못했다 — 설정 › Claude 에서 경로를 준다")?;
	let dir = PathBuf::from(&spec.dir);
	let run_dir = dir.join(".claudeppt/run");
	std::fs::create_dir_all(&run_dir).map_err(err)?;
	let sys_file = run_dir.join("system.md");
	std::fs::write(&sys_file, &spec.system).map_err(err)?;

	let mut args: Vec<String> = [
		"-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
		"--safe-mode", "--setting-sources", "",
		"--strict-mcp-config", "--disable-slash-commands",
		"--tools", TOOLS,
		"--permission-mode", "acceptEdits", "--permission-prompts", "none",
	]
	.map(String::from)
	.to_vec();
	args.extend(["--system-prompt-file".into(), sys_file.to_string_lossy().into()]);
	if !spec.model.trim().is_empty() {
		args.extend(["--model".into(), spec.model.trim().into()]);
	}
	if !spec.effort.trim().is_empty() {
		args.extend(["--effort".into(), spec.effort.trim().into()]);
	}
	if let Some(sid) = spec.resume.as_deref().filter(|s| !s.is_empty()) {
		args.extend(["--resume".into(), sid.into()]);
	}

	let mut cmd = tokio::process::Command::new(&exe);
	cmd.current_dir(&dir).args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
	#[cfg(windows)]
	cmd.creation_flags(0x0800_0000);
	let mut child = cmd.spawn().map_err(|e| format!("claude 를 띄우지 못했다: {e}"))?;
	if let Some(pid) = child.id() {
		state.runs.lock().unwrap().insert(spec.turn.clone(), pid);
	}
	let mut stdin = child.stdin.take().unwrap();
	stdin.write_all(spec.prompt.as_bytes()).await.map_err(err)?;
	drop(stdin);

	let stdout = child.stdout.take().unwrap();
	let stderr = child.stderr.take().unwrap();
	let turn = spec.turn.clone();
	let app2 = app.clone();
	let err_task = tokio::spawn(async move {
		let mut s = String::new();
		let mut r = BufReader::new(stderr).lines();
		while let Ok(Some(l)) = r.next_line().await {
			if s.len() < 8000 {
				s.push_str(&l);
				s.push('\n');
			}
		}
		s
	});
	let mut lines = BufReader::new(stdout).lines();
	while let Ok(Some(line)) = lines.next_line().await {
		let _ = app2.emit("claude", Line { turn: turn.clone(), line });
	}
	let status = child.wait().await.map_err(err)?;
	let stderr = err_task.await.unwrap_or_default();
	app.state::<AppState>().runs.lock().unwrap().remove(&turn);
	Ok(Done { turn, code: status.code().unwrap_or(-1), stderr })
}

use tauri::Manager;

#[tauri::command]
pub fn claude_stop(state: State<AppState>, turn: String) -> Res<()> {
	if let Some(pid) = state.runs.lock().unwrap().remove(&turn) {
		let mut c = std::process::Command::new("taskkill");
		crate::hidden(&mut c);
		let _ = c.args(["/PID", &pid.to_string(), "/T", "/F"]).status();
	}
	Ok(())
}
