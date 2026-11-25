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
	prompt: String,
	system: String,
	claude_path: String,
	model: String,
	effort: String,
	resume: Option<String>,
	/// None 이면 쪽 고치기. "fonts" 면 글꼴 찾기 (위 머리말)
	mode: Option<String>,
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

	let fonts = spec.mode.as_deref() == Some("fonts");
	let mut args: Vec<String> = [
		"-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
		"--safe-mode", "--setting-sources", "",
		"--strict-mcp-config", "--disable-slash-commands",
		"--tools", if fonts { FONT_TOOLS } else { TOOLS },
		"--permission-mode", "acceptEdits", "--permission-prompts", "none",
	]
	.map(String::from)
	.to_vec();
	if fonts {
		// 웹 도구는 acceptEdits 로 허락되지 않는다 — 물어볼 사람이 없으니 미리 허락해 둔다
		args.extend(["--allowedTools".into(), FONT_TOOLS.into()]);
	}
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
	#[cfg(windows)]
	if let (Some(j), Some(h)) = (job::app(), child.raw_handle()) {
		j.adopt(h as _);
	}
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
	// 시스템 프롬프트를 덱 폴더에 남기지 않는다 — claude 는 시작할 때 한 번 읽고 끝이다
	let _ = std::fs::remove_file(&sys_file);
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
}
