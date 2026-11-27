// Claude Code CLI 를 헤드리스로 돌려 대화 한 턴을 실행한다. 출력(stream-json)은 줄마다 「claude」 사건으로 화면에 넘긴다.
//
// 격리 — 이 앱의 Claude 는 사용자의 다른 Claude 설정에 영향을 받지 않는다. 화면이 바꿀 수 없게 인자를 여기에 고정한다.
//   --safe-mode              CLAUDE.md · 스킬 · 플러그인 · 훅 · MCP · 출력 스타일을 끈다
//   --setting-sources ""     사용자 · 프로젝트 settings.json 도 읽지 않는다. --safe-mode 만으로는 응답 언어 같은
//                            사용자 설정이 남는다 (2026.11.17 CLI 2.1.325 실측: 없으면 영어 질문에 한국어로 답했다)
//   --system-prompt-file     기본 시스템 프롬프트를 이 앱의 프롬프트로 바꾼다 (화면 「설정 › Claude」에서 고친다)
//   --tools                  파일 읽기 · 쓰기만. 셸 · 웹은 주지 않는다 — 프로젝트 폴더 밖을 건드릴 길을 막는다
//                            단 「글꼴 찾기」(mode = "fonts")는 거꾸로 웹 찾기 · 웹 읽기만 주고 파일은 못 건드린다.
//                            받아서 까는 일은 Claude 가 아니라 앱(fonts::font_install)이 한다 — 받은 것이 글꼴인지 앱이 가린다
//   --permission-prompts none 물어볼 일이 생기면 기다리지 않고 거절한다 (헤드리스라 답할 사람이 없다)
// 구독 로그인(OAuth)은 그대로 쓴다. --bare 는 API 키만 받아 쓰지 않는다.

use crate::{AppState, Res, err};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const TOOLS: &str = "Read,Edit,Write,Glob,Grep";
const FONT_TOOLS: &str = "WebSearch,WebFetch";

#[derive(Serialize)]
pub struct Detected {
	path: String,
	version: String,
}

/// claude 실행 파일을 찾는다. npm 으로 깐 경우 claude.cmd 옆 node_modules 안의 claude.exe 를 바로 쓴다 —
/// cmd 를 거치면 빈 인자("")와 따옴표가 깨진다.
/// 찾은 경로는 기억한다 — 턴마다 where 를 띄우지 않게. 그 자리에서 없어지면(업데이트로 옮겨짐) 다시 찾는다
pub fn resolve(custom: &str) -> Option<PathBuf> {
	if !custom.trim().is_empty() {
		let p = PathBuf::from(custom.trim());
		return p.exists().then_some(p);
	}
	static FOUND: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);
	if let Some(p) = FOUND.lock().unwrap().clone().filter(|p| p.is_file()) {
		return Some(p);
	}
	let p = on_path().or_else(|| known_places(|k| std::env::var_os(k).map(PathBuf::from)).into_iter().find(|p| p.is_file()))?;
	*FOUND.lock().unwrap() = Some(p.clone());
	Some(p)
}

/// PATH 에서 — where 가 주는 순서대로 .exe, 없으면 npm 의 claude.cmd 옆 claude.exe
fn on_path() -> Option<PathBuf> {
	let mut c = std::process::Command::new("where");
	crate::hidden(&mut c);
	let out = c.arg("claude").output().ok()?;
	let text = String::from_utf8_lossy(&out.stdout).to_string();
	let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
	if let Some(exe) = lines.iter().find(|l| l.to_ascii_lowercase().ends_with(".exe")) {
		return Some(PathBuf::from(exe));
	}
	lines.iter().filter(|l| l.to_ascii_lowercase().ends_with(".cmd")).find_map(|l| Some(npm_exe(Path::new(l).parent()?)).filter(|p| p.is_file()))
}

fn npm_exe(prefix: &Path) -> PathBuf {
	prefix.join("node_modules/@anthropic-ai/claude-code/bin/claude.exe")
}

/// PATH 에 없을 때 볼 자리. 앱을 시작 메뉴에서 띄우면 claude 를 막 깐 뒤에도 PATH 가 옛것이라 where 가 못 찾는다
/// (탐색기가 로그인 때 받은 환경을 물려준다). 깐 방법마다 놓이는 곳:
///   네이티브 설치(claude.ai/install.ps1)  %USERPROFILE%\.local\bin\claude.exe
///   npm 전역                              %APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe
///   WinGet                                %LOCALAPPDATA%\Microsoft\WinGet\Links\claude.exe
///   Scoop                                 %USERPROFILE%\scoop\shims\claude.exe
fn known_places(env: impl Fn(&str) -> Option<PathBuf>) -> Vec<PathBuf> {
	let mut v = vec![];
	if let Some(h) = env("USERPROFILE") {
		v.push(h.join(".local").join("bin").join("claude.exe"));
	}
	if let Some(a) = env("APPDATA") {
		v.push(npm_exe(&a.join("npm")));
	}
	if let Some(l) = env("LOCALAPPDATA") {
		v.push(l.join("Microsoft").join("WinGet").join("Links").join("claude.exe"));
	}
	if let Some(h) = env("USERPROFILE") {
		v.push(h.join("scoop").join("shims").join("claude.exe"));
	}
	v
}

/// 앱이 띄운 오래 도는 프로세스(claude · 바깥 길 터널)를 앱의 job 에 넣는다 — 앱이 어떻게 꺼지든 함께 꺼진다
pub fn adopt(child: &tokio::process::Child) {
	#[cfg(windows)]
	if let (Some(j), Some(h)) = (job::app(), child.raw_handle()) {
		j.adopt(h as _);
	}
	#[cfg(not(windows))]
	let _ = child;
}

/// 앱이 띄운 claude 를 앱의 job 에 넣는다. job 은 「손잡이가 닫히면 안의 프로세스를 모두 끈다」로 만들고 손잡이를 끝까지 쥐므로,
/// 앱이 어떻게 꺼지든(창 닫기 · 업데이트 설치가 앱을 끝냄 · 강제 종료 · 죽음) OS 가 claude 와 그 자식까지 끈다.
/// 전에는 앱을 닫아도 돌던 claude 가 남아 덱 파일을 계속 고치고 구독 사용량을 썼다
#[cfg(windows)]
mod job {
	use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
	use windows_sys::Win32::System::JobObjects::{
		AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
		SetInformationJobObject,
	};

	pub struct Job(HANDLE);
	// 손잡이는 커널 개체 번호라 스레드를 건너가도 된다
	unsafe impl Send for Job {}
	unsafe impl Sync for Job {}

	impl Job {
		pub fn new() -> Option<Job> {
			unsafe {
				let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
				if h.is_null() {
					return None;
				}
				let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
				info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
				let ok = SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info as *const _ as *const _, size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32);
				if ok == 0 {
					CloseHandle(h);
					return None;
				}
				Some(Job(h))
			}
		}

		/// 실패해도(이미 다른 job 이 끊기 못하게 묶은 경우 등) 턴은 그대로 돈다 — 앱을 닫을 때만 남을 뿐이다
		pub fn adopt(&self, process: HANDLE) -> bool {
			unsafe { AssignProcessToJobObject(self.0, process) != 0 }
		}
	}

	impl Drop for Job {
		fn drop(&mut self) {
			unsafe { CloseHandle(self.0) };
		}
	}

	/// 앱이 끝까지 쥐는 job — 앱 프로세스가 끝날 때 OS 가 닫는다
	pub fn app() -> Option<&'static Job> {
		static JOB: std::sync::OnceLock<Option<Job>> = std::sync::OnceLock::new();
		JOB.get_or_init(Job::new).as_ref()
	}
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
	/// 돌 자리 — 덱의 작업 사본 (vcs_work_prepare). 없으면 덱 폴더 (글꼴 찾기)
	cwd: Option<String>,
	prompt: String,
	system: String,
	claude_path: String,
	model: String,
	effort: String,
	resume: Option<String>,
	/// 새 세션의 id — 앱이 정해 --session-id 로 준다. 그래야 턴이 멈춰 init 사건을 못 받아도 그 세션의 기록을 찾아 남긴다
	session_id: Option<String>,
	/// None 이면 쪽 고치기. "fonts" 면 글꼴 찾기 (위 머리말)
	mode: Option<String>,
}

// ── 세션 기록 지키기 ──
// Claude Code 는 세션 기록을 <설정 폴더>/projects/<작업 폴더 이름>/<세션 id>.jsonl 에 둔다. --resume 은 거기서만 찾는다.
// 덱 폴더를 옮기거나(.cppt 로 다른 PC 에 풀거나) 기록을 지우면 「No conversation found」로 이어 쓰지 못하고, 장표에 붙은 세션의 맥락이 끊긴다.
// 그래서 턴이 끝날 때마다 덱의 .claudeppt/sessions/<id>.jsonl 로 복사해 두고, 이어 쓰기 전에 claude 쪽에 없으면 되돌려 놓는다.
// (.claudeppt 는 판에 들지 않고 .cppt 에는 든다 — 대화 기록 talk.json 과 같은 자리)

/// 세션 id 는 화면에서 온다 — 경로에 쓰므로 uuid 꼴만 받는다
pub fn valid_sid(s: &str) -> bool {
	!s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn projects_root() -> Option<PathBuf> {
	std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).or_else(|| dirs::home_dir().map(|h| h.join(".claude"))).map(|d| d.join("projects"))
}

/// 작업 폴더 → projects 아래 폴더 이름. 영문 · 숫자가 아닌 글자는 UTF-16 한 단위마다 「-」 (「문서」 → 「--」).
/// 2026.11.25 CLI 2.1.x 실측: C:\Users\me\OneDrive\문서\ClaudePPT\제목 없음 → C--Users-me-OneDrive----ClaudePPT------
fn project_key(dir: &Path) -> String {
	dir.to_string_lossy().encode_utf16().map(|u| if u < 128 && (u as u8).is_ascii_alphanumeric() { u as u8 as char } else { '-' }).collect()
}

fn backup_path(dir: &Path, sid: &str) -> PathBuf {
	dir.join(".claudeppt").join("sessions").join(format!("{sid}.jsonl"))
}

/// claude 쪽의 그 세션 기록 — 이 작업 폴더 자리에 없으면 다른 폴더(덱을 옮기기 전 자리)에서도 찾는다
fn live_transcript(root: &Path, dir: &Path, sid: &str) -> Option<PathBuf> {
	let here = root.join(project_key(dir)).join(format!("{sid}.jsonl"));
	if here.is_file() {
		return Some(here);
	}
	std::fs::read_dir(root).ok()?.flatten().map(|e| e.path().join(format!("{sid}.jsonl"))).find(|p| p.is_file())
}

/// 이어 쓰기 전에 — 이 작업 폴더(cwd) 자리에 기록이 없으면 다른 자리의 것이나 덱(deck)에 남긴 것을 놓는다.
/// 작업 폴더와 덱은 다르다 — 턴은 덱의 작업 사본(vcs.rs 「작업 사본」)에서 돌고, 기록은 덱에 남는다
fn restore_transcript(root: &Path, cwd: &Path, deck: &Path, sid: &str) {
	let key = project_key(cwd);
	// 아주 긴 경로는 Claude Code 가 이름을 줄이고 해시를 붙인다 — 그 이름을 모르므로 놓지 않는다 (claude 가 못 찾으면 화면이 요약으로 새로 잇는다)
	if !valid_sid(sid) || key.len() > 200 {
		return;
	}
	let here = root.join(&key).join(format!("{sid}.jsonl"));
	let backup = backup_path(deck, sid);
	// 2026.11.26 : 덱에 남긴 기록이 더 길면 그것으로 — 팀원 PC 에서 이어 쓴 턴(collab.rs)은 덱의 기록에만 붙는다. 기록은 뒤에 덧붙기만 한다
	let len = |p: &Path| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
	if here.is_file() {
		if backup.is_file() && len(&backup) > len(&here) {
			let _ = std::fs::copy(&backup, &here);
		}
		return;
	}
	let src = live_transcript(root, cwd, sid).or_else(|| Some(backup.clone()).filter(|p| p.is_file()));
	if let Some(src) = src {
		let _ = std::fs::create_dir_all(here.parent().unwrap());
		let _ = std::fs::copy(src, &here);
	}
}

/// 턴이 끝난 뒤 — 작업 폴더(cwd)에서 돈 claude 쪽 기록을 덱에 남긴다
fn backup_transcript(root: &Path, cwd: &Path, deck: &Path, sid: &str) {
	if !valid_sid(sid) {
		return;
	}
	if let Some(src) = live_transcript(root, cwd, sid) {
		let to = backup_path(deck, sid);
		let _ = std::fs::create_dir_all(to.parent().unwrap());
		let _ = std::fs::copy(src, to);
	}
}

/// 그 세션의 기록 글 — claude 쪽 것과 덱에 남긴 것 중 긴 것. 팀원 PC 에 이어 쓸 기록을 보낼 때 쓴다
pub fn transcript_text(dir: &Path, sid: &str) -> Option<String> {
	if !valid_sid(sid) {
		return None;
	}
	let live = projects_root().and_then(|r| live_transcript(&r, dir, sid)).and_then(|p| std::fs::read_to_string(p).ok());
	let saved = std::fs::read_to_string(backup_path(dir, sid)).ok();
	match (live, saved) {
		(Some(a), Some(b)) => Some(if b.len() > a.len() { b } else { a }),
		(a, b) => a.or(b),
	}
}

/// 받은 기록을 이 작업 폴더의 claude 자리에 놓는다(덮어쓴다) — 팀원 PC 가 이어 쓰기 전에
pub fn place_transcript(dir: &Path, sid: &str, text: &str) {
	let key = project_key(dir);
	let Some(root) = projects_root() else { return };
	if !valid_sid(sid) || key.len() > 200 {
		return;
	}
	let here = root.join(key).join(format!("{sid}.jsonl"));
	let _ = std::fs::create_dir_all(here.parent().unwrap());
	let _ = std::fs::write(here, text);
}

/// 덱에 남긴 기록 글
pub fn saved_transcript(dir: &Path, sid: &str) -> Option<String> {
	valid_sid(sid).then(|| std::fs::read_to_string(backup_path(dir, sid)).ok()).flatten()
}

/// 덱에 기록을 남긴다 — 팀원 PC 에서 이어 쓴 턴의 기록을 받았을 때. 다음에 누가 이어 쓰든 이것을 놓는다(restore_transcript)
pub fn save_transcript(dir: &Path, sid: &str, text: &str) {
	if !valid_sid(sid) {
		return;
	}
	let to = backup_path(dir, sid);
	let _ = std::fs::create_dir_all(to.parent().unwrap());
	let _ = std::fs::write(to, text);
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

/// claude 한 번 돌리기에 드는 것 — 덱 주인 실행(claude_run)과 팀원 PC 실행(runner.rs)이 같이 쓴다
pub struct Job<'a> {
	pub exe: PathBuf,
	pub dir: &'a Path,
	pub prompt: &'a str,
	pub system: &'a str,
	pub model: &'a str,
	pub effort: &'a str,
	pub resume: Option<&'a str>,
	pub session_id: Option<&'a str>,
	pub fonts: bool,
}

/// 끝난 claude — 종료 코드 · 오류 출력 끝부분 · 이 턴이 쓴 세션 id
pub struct Ended {
	pub code: i32,
	pub stderr: String,
	pub sid: Option<String>,
}

/// claude 를 띄워 끝날 때까지 출력 줄을 넘긴다. 격리 인자는 여기 한 곳에 — 어디서 돌든 같은 울타리 안이다 (머리말).
/// on_pid 로 프로세스 번호를 알린다 — 멈출 때 트리째 끈다(kill_tree)
pub async fn execute(job: Job<'_>, mut on_line: impl FnMut(String) + Send, on_pid: impl FnOnce(u32) + Send) -> Res<Ended> {
	let run_dir = job.dir.join(".claudeppt/run");
	std::fs::create_dir_all(&run_dir).map_err(err)?;
	let sys_file = run_dir.join("system.md");
	std::fs::write(&sys_file, job.system).map_err(err)?;

	let mut args: Vec<String> = [
		"-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
		"--safe-mode", "--setting-sources", "",
		"--strict-mcp-config", "--disable-slash-commands",
		"--tools", if job.fonts { FONT_TOOLS } else { TOOLS },
		"--permission-mode", "acceptEdits", "--permission-prompts", "none",
	]
	.map(String::from)
	.to_vec();
	if job.fonts {
		// 웹 도구는 acceptEdits 로 허락되지 않는다 — 물어볼 사람이 없으니 미리 허락해 둔다
		args.extend(["--allowedTools".into(), FONT_TOOLS.into()]);
	}
	args.extend(["--system-prompt-file".into(), sys_file.to_string_lossy().into()]);
	if !job.model.trim().is_empty() {
		args.extend(["--model".into(), job.model.trim().into()]);
	}
	if !job.effort.trim().is_empty() {
		args.extend(["--effort".into(), job.effort.trim().into()]);
	}
	if let Some(sid) = job.resume {
		args.extend(["--resume".into(), sid.into()]);
	} else if let Some(sid) = job.session_id.filter(|s| valid_sid(s)) {
		args.extend(["--session-id".into(), sid.into()]);
	}

	let mut cmd = tokio::process::Command::new(&job.exe);
	cmd.current_dir(job.dir).args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
	#[cfg(windows)]
	cmd.creation_flags(0x0800_0000);
	let mut child = cmd.spawn().map_err(|e| format!("claude 를 띄우지 못했다: {e}"))?;
	adopt(&child);
	if let Some(pid) = child.id() {
		on_pid(pid);
	}
	let mut stdin = child.stdin.take().unwrap();
	stdin.write_all(job.prompt.as_bytes()).await.map_err(err)?;
	drop(stdin);

	let stdout = child.stdout.take().unwrap();
	let stderr = child.stderr.take().unwrap();
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
	// 이 턴이 쓴 세션 id — 남길 기록을 찾는 데 쓴다. 이어 쓰기 · 새 id 를 준 경우가 아니면 init 사건에서 읽는다
	let mut sid = job.resume.map(String::from).or_else(|| job.session_id.filter(|s| valid_sid(s)).map(String::from));
	while let Ok(Some(line)) = lines.next_line().await {
		if sid.is_none() && line.contains("\"subtype\":\"init\"") {
			sid = serde_json::from_str::<serde_json::Value>(&line).ok().and_then(|v| v["session_id"].as_str().map(String::from));
		}
		on_line(line);
	}
	let status = child.wait().await.map_err(err)?;
	let stderr = err_task.await.unwrap_or_default();
	// 시스템 프롬프트를 덱 폴더에 남기지 않는다 — claude 는 시작할 때 한 번 읽고 끝이다
	let _ = std::fs::remove_file(&sys_file);
	Ok(Ended { code: status.code().unwrap_or(-1), stderr, sid })
}

#[tauri::command]
pub async fn claude_run(app: AppHandle, state: State<'_, AppState>, spec: RunSpec) -> Res<Done> {
	let exe = resolve(&spec.claude_path).ok_or("claude 실행 파일을 찾지 못했다 — 설정 › Claude 에서 경로를 준다")?;
	let dir = PathBuf::from(&spec.dir);
	let cwd = spec.cwd.as_deref().map(PathBuf::from).unwrap_or_else(|| dir.clone());
	let root = projects_root();
	let resume = spec.resume.as_deref().filter(|s| !s.is_empty());
	if let (Some(sid), Some(r)) = (resume, &root) {
		restore_transcript(r, &cwd, &dir, sid);
	}
	let turn = spec.turn.clone();
	let (app2, turn2) = (app.clone(), turn.clone());
	let runs = &state.runs;
	let job = Job {
		exe,
		dir: &cwd,
		prompt: &spec.prompt,
		system: &spec.system,
		model: &spec.model,
		effort: &spec.effort,
		resume,
		session_id: spec.session_id.as_deref(),
		fonts: spec.mode.as_deref() == Some("fonts"),
	};
	let ended = execute(job, move |line| { let _ = app2.emit("claude", Line { turn: turn2.clone(), line }); }, |pid| { runs.lock().unwrap().insert(turn.clone(), pid); }).await;
	state.runs.lock().unwrap().remove(&turn);
	let ended = ended?;
	if let (Some(r), Some(s)) = (&root, &ended.sid) {
		backup_transcript(r, &cwd, &dir, s);
	}
	Ok(Done { turn, code: ended.code, stderr: ended.stderr })
}

/// 프로세스를 자식까지 끈다
pub fn kill_tree(pid: u32) {
	let mut c = std::process::Command::new("taskkill");
	crate::hidden(&mut c);
	let _ = c.args(["/PID", &pid.to_string(), "/T", "/F"]).status();
}

/// 멈춤 — 이 PC 에서 도는 턴이면 claude 를 끄고, 팀원 PC 에서 도는 턴이면 그 PC 에 멈추라고 보낸다 (collab.rs)
#[tauri::command]
pub fn claude_stop(app: AppHandle, state: State<AppState>, turn: String) -> Res<()> {
	if let Some(pid) = state.runs.lock().unwrap().remove(&turn) {
		kill_tree(pid);
	}
	crate::collab::stop_remote(&app, &turn);
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn known_places_cover_each_installer_in_order() {
		let env = |k: &str| match k {
			"USERPROFILE" => Some(PathBuf::from(r"C:\Users\me")),
			"APPDATA" => Some(PathBuf::from(r"C:\Users\me\AppData\Roaming")),
			"LOCALAPPDATA" => Some(PathBuf::from(r"C:\Users\me\AppData\Local")),
			_ => None,
		};
		let v: Vec<String> = known_places(env).iter().map(|p| p.to_string_lossy().replace('/', "\\")).collect();
		assert_eq!(v, [
			r"C:\Users\me\.local\bin\claude.exe",
			r"C:\Users\me\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe",
			r"C:\Users\me\AppData\Local\Microsoft\WinGet\Links\claude.exe",
			r"C:\Users\me\scoop\shims\claude.exe",
		]);
		// 환경 변수가 없으면 그 자리는 건너뛴다
		assert!(known_places(|_| None).is_empty());
	}

	/// job 손잡이가 닫히면(= 앱이 꺼지면) 넣어 둔 프로세스와 그 자식까지 꺼진다
	#[cfg(windows)]
	#[test]
	fn closing_the_job_kills_claude_and_its_children() {
		use std::os::windows::io::AsRawHandle;
		use std::time::{Duration, Instant};
		// cmd 가 ping 을 자식으로 띄운다 — claude.exe 가 제 자식을 띄우는 것과 같은 모양
		let mut c = std::process::Command::new("cmd");
		c.args(["/c", "ping -n 60 127.0.0.1 > nul"]);
		crate::hidden(&mut c);
		let mut child = c.spawn().unwrap();
		let j = job::Job::new().expect("job");
		assert!(j.adopt(child.as_raw_handle() as _));
		std::thread::sleep(Duration::from_millis(500));
		assert!(child.try_wait().unwrap().is_none(), "아직 돌아야 한다");
		drop(j);
		let t0 = Instant::now();
		while child.try_wait().unwrap().is_none() {
			assert!(t0.elapsed() < Duration::from_secs(5), "job 을 닫았는데 꺼지지 않았다");
			std::thread::sleep(Duration::from_millis(50));
		}
	}

	#[test]
	fn project_key_matches_claude_code() {
		// ~/.claude/projects 에 실제로 생기는 이름 꼴 (2026.11.25 CLI 2.1.299 에서 확인)
		assert_eq!(project_key(Path::new(r"C:\Users\me\OneDrive\문서\ClaudePPT\제목 없음")), "C--Users-me-OneDrive----ClaudePPT------");
		assert_eq!(project_key(Path::new(r"d:\work\claudeppt")), "d--work-claudeppt");
		// UTF-16 둘로 된 글자(이모지)는 「-」 둘
		assert_eq!(project_key(Path::new("a😀b")), "a--b");
	}

	#[test]
	fn session_id_must_look_like_uuid() {
		assert!(valid_sid("0f8c2a6e-1b2c-4d5e-8f90-123456789abc"));
		for bad in ["", "../x", r"..\..\x", "a/b", "id with space", &"a".repeat(65)] {
			assert!(!valid_sid(bad), "{bad}");
		}
	}

	#[test]
	fn transcript_is_backed_up_and_restored() {
		let t = std::env::temp_dir().join(format!("cppt-claude-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&t);
		let root = t.join("projects");
		let deck = t.join("덱 하나");
		let moved = t.join("옮긴 덱");
		let sid = "0f8c2a6e-1b2c-4d5e-8f90-123456789abc";
		std::fs::create_dir_all(root.join(project_key(&deck))).unwrap();
		std::fs::create_dir_all(&deck).unwrap();
		std::fs::write(root.join(project_key(&deck)).join(format!("{sid}.jsonl")), "{\"a\":1}\n").unwrap();

		// 턴이 끝나면 덱에 남는다
		backup_transcript(&root, &deck, &deck, sid);
		assert_eq!(std::fs::read_to_string(backup_path(&deck, sid)).unwrap(), "{\"a\":1}\n");

		// 덱을 옮기면 (같은 PC) 옛 자리의 기록을 새 자리에 놓는다
		std::fs::create_dir_all(&moved).unwrap();
		restore_transcript(&root, &moved, &moved, sid);
		assert!(root.join(project_key(&moved)).join(format!("{sid}.jsonl")).is_file());

		// claude 쪽 기록이 모두 없어도 (다른 PC · 지움) 덱에 남긴 것으로 되돌린다
		std::fs::remove_dir_all(&root).unwrap();
		restore_transcript(&root, &deck, &deck, sid);
		assert_eq!(std::fs::read_to_string(root.join(project_key(&deck)).join(format!("{sid}.jsonl"))).unwrap(), "{\"a\":1}\n");

		// 이미 있으면 덮지 않는다 (claude 쪽이 더 길다 = 더 새것. 기록은 덧붙기만 한다)
		std::fs::write(root.join(project_key(&deck)).join(format!("{sid}.jsonl")), "{\"a\":1}\n{\"b\":2}\n").unwrap();
		restore_transcript(&root, &deck, &deck, sid);
		assert_eq!(std::fs::read_to_string(root.join(project_key(&deck)).join(format!("{sid}.jsonl"))).unwrap(), "{\"a\":1}\n{\"b\":2}\n");

		// 팀원 PC 에서 이어 써 덱의 기록이 더 길면 그것으로 (collab.rs 가 save_transcript 로 남긴다)
		save_transcript(&deck, sid, "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n");
		restore_transcript(&root, &deck, &deck, sid);
		assert_eq!(std::fs::read_to_string(root.join(project_key(&deck)).join(format!("{sid}.jsonl"))).unwrap(), "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n");

		// 덱의 작업 사본에서 돈다 — 기록은 사본 자리에 놓이고, 끝나면 늘어난 것이 덱에 남는다
		let work = t.join("사본");
		std::fs::create_dir_all(&work).unwrap();
		restore_transcript(&root, &work, &deck, sid);
		let live = root.join(project_key(&work)).join(format!("{sid}.jsonl"));
		assert_eq!(std::fs::read_to_string(&live).unwrap(), "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n");
		std::fs::write(&live, "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n{\"d\":4}\n").unwrap();
		backup_transcript(&root, &work, &deck, sid);
		assert!(std::fs::read_to_string(backup_path(&deck, sid)).unwrap().ends_with("{\"d\":4}\n"));
		assert!(!backup_path(&work, sid).exists(), "사본 폴더에는 남기지 않는다");

		// 이상한 id 는 경로에 쓰지 않는다
		restore_transcript(&root, &deck, &deck, "../../evil");
		backup_transcript(&root, &deck, &deck, "../../evil");
		assert!(!t.join("evil.jsonl").exists());
		let _ = std::fs::remove_dir_all(&t);
	}
}
