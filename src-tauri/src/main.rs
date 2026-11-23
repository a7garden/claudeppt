// 배포 빌드에서 콘솔 창을 띄우지 않는다.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 명령 인자가 있으면 창 없이 CLI 로 돈다 (cli.rs) — 앱 밖 Claude Code 가 이 길로 앱을 부린다
    let args: Vec<String> = std::env::args().skip(1).collect();
    if claudeppt_lib::cli::wants(&args) {
        attach_console();
        std::process::exit(claudeppt_lib::cli::main(args));
    }
    claudeppt_lib::run()
}

/// 배포 빌드는 창 프로그램이라 콘솔이 없다. 터미널에서 직접 부르면 부른 쪽 콘솔에 붙어 글을 찍는다.
/// 파이프로 부르면(Claude Code 의 Bash) 이미 받은 핸들로 쓰므로 붙지 않아도 된다.
fn attach_console() {
    #[cfg(windows)]
    unsafe {
        unsafe extern "system" {
            fn AttachConsole(pid: u32) -> i32;
            fn GetStdHandle(n: u32) -> isize;
        }
        // 파이프로 받은 핸들이 있으면 그대로 둔다 — 붙으면 출력이 파이프가 아니라 콘솔로 샐 수 있다
        if GetStdHandle(-11i32 as u32) == 0 {
            AttachConsole(u32::MAX);
        }
    }
}
