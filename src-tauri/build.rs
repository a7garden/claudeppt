// 앱 명령 권한 (2026.11.26) — lib.rs 의 generate_handler! 목록을 그대로 앱 명령 목록(app manifest)으로 넘긴다.
//
// 목록이 없으면 Tauri 는 앱 자신의 주소(http://tauri.localhost)로 열린 화면이면 창이 어느 것이든 모든 앱 명령을 허락한다.
// 공유 덱 창(collab.rs collab_join)은 남의 PC 가 내준 화면이라, 그 화면이 창 주소를 앱 주소로 바꾸면 그 창에서 파일 · claude 명령을 부를 길이 생긴다.
// 목록이 있으면 명령마다 권한(allow-<명령>)이 생기고, capabilities/default.json 이 그 묶음(app-commands)을 main 창에만 준다.
// 목록은 lib.rs 에서 읽는다 — 명령을 더하고 여기를 잊으면 main 창에서도 막혀 바로 드러나지만, 애초에 잊을 일이 없게
use std::fs;

fn main() {
	println!("cargo:rerun-if-changed=src/lib.rs");
	let lib = fs::read_to_string("src/lib.rs").expect("src/lib.rs");
	let start = lib.find("generate_handler![").expect("generate_handler! 가 없다") + "generate_handler![".len();
	let end = start + lib[start..].find(']').expect("generate_handler! 가 닫히지 않는다");
	let commands: Vec<String> = lib[start..end]
		.split(',')
		.map(|c| c.trim())
		.filter(|c| !c.is_empty())
		.map(|c| c.rsplit("::").next().unwrap().to_string())
		.collect();
	assert!(commands.len() > 10, "명령을 거의 못 읽었다: {commands:?}");

	// main 창에 줄 묶음 — 명령 목록에서 만든다 (permissions/ 는 빌드가 만드는 것이라 git 에 넣지 않는다)
	let set = format!(
		"# build.rs 가 src/lib.rs 의 명령 목록으로 만든다. 손으로 고치지 않는다\n\n[[set]]\nidentifier = \"app-commands\"\ndescription = \"앱의 모든 명령 (main 창만)\"\npermissions = [\n{}]\n",
		commands.iter().map(|c| format!("  \"allow-{}\",\n", c.replace('_', "-"))).collect::<String>()
	);
	fs::create_dir_all("permissions").unwrap();
	if fs::read_to_string("permissions/app.toml").ok().as_deref() != Some(set.as_str()) {
		fs::write("permissions/app.toml", &set).unwrap();
	}

	// Windows 공용 컨트롤 6 선언 — tauri-build 는 앱 실행 파일의 리소스로만 싣는데, 그러면 시험 실행 파일(acl_tests)이
	// TaskDialogIndirect 를 못 찾고 시작도 못 한다(STATUS_ENTRYPOINT_NOT_FOUND). 링커로 앱 · 시험 모두에 싣고 tauri-build 의 것은 끈다(두 번 실리면 리소스가 겹친다)
	let msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
	if msvc {
		let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("app.manifest");
		fs::write(&out, MANIFEST).unwrap();
		println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
		println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", out.display());
	}
	let windows = if msvc { tauri_build::WindowsAttributes::new_without_app_manifest() } else { tauri_build::WindowsAttributes::new() };

	let commands: &'static [&'static str] = Box::leak(commands.into_iter().map(|c| &*Box::leak(c.into_boxed_str())).collect::<Vec<_>>().into_boxed_slice());
	tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows).app_manifest(tauri_build::AppManifest::new().commands(commands))).expect("tauri-build");
}

/// tauri-build 의 windows-app-manifest.xml 과 같은 것
const MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" />
    </dependentAssembly>
  </dependency>
</assembly>"#;
