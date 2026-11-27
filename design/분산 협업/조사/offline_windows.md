# 서버 없는 P2P 협업에서 「아무도 접속해 있지 않을 때」와 부분 공개: Windows 구현 수단과 대안

조사일: 2026-11-27 · 대상: ClaudePPT (Tauri 2 · Rust · Windows 10/11)
시나리오: 늦게까지 일하고 끝냈는데 다른 팀원 PC 는 모두 꺼져 있다. 사용자는 다음 주 월요일 휴가다. 상시 서버는 둘 수 없다. 이 PC 를 끄면 변경은 이 PC 안에만 갇힌다.

## 1. Windows API 로 「미동기 변경이 있는 동안」 PC 를 깨워 두고 종료를 늦출 수 있는가

### Takeaway
잠자기(유휴 타이머)는 막을 수 있지만 사용자가 직접 하는 잠자기 · 덮개 닫기 · 전원 버튼 · 종료는 막을 수 없고, 막아서도 안 된다. 종료는 사유 문자열을 띄워 사용자에게 한 번 묻는 정도까지만 할 수 있다. 그래서 이 API 들은 「다른 사람이 곧 켤 때까지 조금 버티기」와 「끄기 전에 경고하기」로만 쓸 수 있다. 휴가 시나리오를 풀지는 못한다.

### Cited Findings
**잠자기 막기: SetThreadExecutionState**
- `ES_SYSTEM_REQUIRED` 는 시스템 유휴 타이머를 초기화해 작업 상태를 유지한다. `ES_CONTINUOUS` 와 함께 쓰면 다음 `ES_CONTINUOUS` 호출 때까지 상태가 유지된다. `ES_CONTINUOUS` 없이 쓰면 타이머만 한 번 초기화되므로 주기적으로 다시 불러야 한다. — [SetThreadExecutionState](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate)
- 문서는 백업 에이전트 · 네트워크 관리 앱이 이벤트를 처리하는 동안 `ES_SYSTEM_REQUIRED | ES_CONTINUOUS` 를 쓰라고 권한다. 같은 문서가 「워드프로세서 · 스프레드시트 · 브라우저는 부를 필요가 없다」고 적는다. — [같은 문서](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate)
- 원문: "SetThreadExecutionState function cannot be used to prevent the user from putting the computer to sleep. Applications should respect that the user expects a certain behavior when they close the lid on their laptop or press the power button." — [같은 문서](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate)
- `ES_AWAYMODE_REQUIRED` 는 TV 녹화 · 미디어 스트리밍처럼 반드시 필요한 미디어 앱만 쓰라고 한다. 원문: "Applications that ... run on portable computers should not enable away mode." away mode 는 잠자기 동작을 「잠든 것처럼 보이는 실행 상태」로 바꾼다. 유휴 타이머는 막지 않으므로 `ES_SYSTEM_REQUIRED` 를 함께 줘야 한다. — [같은 문서](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate)

**잠자기 막기: PowerCreateRequest / PowerSetRequest (Windows 7+)**
- 종류는 `PowerRequestSystemRequired`(유휴 잠자기 방지) · `PowerRequestAwayModeRequired`(S3 시스템에서만 적용) · `PowerRequestExecutionRequired`(프로세스 수명 관리로 멈추거나 끝나지 않게 함) · `PowerRequestDisplayRequired` 다. — [PowerSetRequest](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powersetrequest)
- 핵심 제약 두 가지. ① "On Modern Standby systems on DC power, system and execution required power requests are terminated 5 minutes after the system sleep timeout has expired." ② S3 의 AwayMode 를 빼면 "power requests are terminated upon user-initiated system sleep entry (power button, lid close or selecting Sleep from the Start menu)." — [같은 문서](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powersetrequest)
- 모범 사례: `REASON_CONTEXT` 에 지역화된 사유 문자열을 넣고, 필요한 직전에 Set 하고, 끝나면 바로 `PowerClearRequest` 한다. 사유 문자열은 `powercfg /requests` 에 보이므로 IT 관리자가 원인을 알 수 있다. — [같은 문서](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powersetrequest)

**Modern Standby 에서는 데스크톱 앱이 멈춘다**
- 원문: "When Modern Standby-capable systems enter sleep, the system is still in S0 ... Desktop apps are stopped by the Desktop Activity Moderator (DAM); however, background tasks from Microsoft Store apps are permitted to do work." Win32 Tauri 앱은 Modern Standby 「잠자기」에 들어가면 네트워크가 살아 있어도 동기화를 하지 못한다. — [Modern Standby vs S3](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/modern-standby-vs-s3)
- 배터리에서는 비핵심 타이머가 "postponed indefinitely until the system is awake or plugged into AC power" 될 수 있다. AC 전원에서는 유지보수 모드에서 업데이트 같은 작업이 돌 수 있다. Wake-on-LAN 은 Modern Standby 와 S3 에서 똑같이 동작하는 것이 기대된다. — [같은 문서](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/modern-standby-vs-s3)

**종료 늦추기: WM_QUERYENDSESSION · WM_ENDSESSION · ShutdownBlockReasonCreate**
- 한 앱이라도 `WM_QUERYENDSESSION` 에 0 을 돌려주면 세션이 끝나지 않는다. 그러나 문서는 TRUE 를 돌려주라고 권한다. 정리 작업은 `WM_ENDSESSION` 까지 미루라고 한다. lParam 비트: `ENDSESSION_CLOSEAPP`(재시작 관리자 · 서비싱), `ENDSESSION_CRITICAL`(강제 종료), `ENDSESSION_LOGOFF`. — [WM_QUERYENDSESSION](https://learn.microsoft.com/en-us/windows/win32/shutdown/wm-queryendsession)
- 5초가 지나면 시스템이 종료를 막는 앱 목록과 사유를 전체 화면으로 보여 주고, 사용자가 「그래도 종료」나 「취소」를 고른다. **콘솔 앱과 보이는 창이 없는 앱은 종료를 취소할 수 없다.** 이런 앱은 5초 안에 응답하지 않거나 FALSE 를 돌려주면 자동으로 끝난다. 권장: "Applications cannot rely on being able to block shutdown." — [Shutdown Changes for Windows Vista](https://learn.microsoft.com/en-us/windows/win32/shutdown/shutdown-changes-for-windows-vista)
- `ShutdownBlockReasonCreate(hWnd, reason)` 는 hWnd 를 만든 스레드에서만 부를 수 있다. 다른 스레드에서 부르면 `ERROR_ACCESS_DENIED` 다. 사유는 `MAX_STR_BLOCKREASON` 에서 잘린다. 짧게 쓰라고 한다("A CD burn is in progress."). 작업이 끝나면 `ShutdownBlockReasonDestroy` 를 부른다. — [ShutdownBlockReasonCreate](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-shutdownblockreasoncreate)
- 응답 지연이나 교착으로 강제 종료되는 사례가 있다. 정리를 `WM_ENDSESSION` 으로 옮겨 해결한 보고와, 사용자 입력이 없는 상태에서 네이티브 메시지 훅이 돌지 않은 Qt 사례가 있다. — [Old New Thing 2017-03-29](https://devblogs.microsoft.com/oldnewthing/20170329-00/?p=95855); [Qt forum](https://forum.qt.io/post/199455)

**Windows Update 재시작**
- 업데이트 뒤 자동 재시작은 활성 시간 밖에 일어난다. 활성 시간은 최대 18시간이다. 기한(deadline)과 유예(grace)가 지나면 활성 시간 중에도 재시작할 수 있다. 2026년 Q&A 에는 25H2 가 정책을 설정했는데도 활성 시간 중에 재시작했다는 보고가 있다(공식 결함 확인은 아님). — [Manage device restarts after updates](https://learn.microsoft.com/windows/deployment/update/waas-restart); [Q&A 25H2](https://learn.microsoft.com/en-in/answers/questions/5916635/windows-11-25h2-forces-automatic-reboot-during-act)

**Tauri 2 에서 하는 법**
- `tauri::WindowEvent` 변형은 `CloseRequested { api }` · `Destroyed` · `DragDrop` · `Focused` · `Moved` · `Resized` · `ScaleFactorChanged` · `ThemeChanged` 다. **세션 종료나 OS 종료 이벤트는 없다.** — [docs.rs tauri::WindowEvent](https://docs.rs/tauri/latest/tauri/enum.WindowEvent.html)
- `RunEvent::ExitRequested { code, api }`: code 가 `None` 이면 사용자 동작으로 종료를 요청한 것이고, `Some` 이면 `AppHandle` 로 프로그램이 요청한 것이다. — [docs.rs tauri::RunEvent](https://docs.rs/tauri/latest/tauri/enum.RunEvent.html)
- 트레이: `Cargo.toml` 에서 `tauri` 에 `tray-icon` 기능을 켜고, `setup` 안에서 `TrayIconBuilder::new().menu(&menu).on_menu_event(..).on_tray_icon_event(..).build(app)?` 로 만든다. — [Tauri 2 System Tray](https://v2.tauri.app/learn/system-tray/)

### Inferences
- 「창을 닫아도 트레이에 남기」는 흔히 `CloseRequested` 에서 `api.prevent_close()` 를 부르고 `window.hide()` 로 숨긴 뒤, `RunEvent::ExitRequested` 에서 `api.prevent_exit()` 를 부르는 방식으로 만든다. 다만 이번에 연 docs.rs 페이지에서 메서드 이름까지 확인하지는 못했다(Gaps).
- Tauri 는 세션 종료를 이벤트로 주지 않는다. 그래서 ① `WebviewWindow::hwnd()` 로 HWND 를 얻어 `windows` crate 의 `SetWindowSubclass`(comctl32) 로 `WM_QUERYENDSESSION` · `WM_ENDSESSION` 을 가로채거나, ② 따로 숨은 메시지 전용 창을 만들어 처리해야 할 것으로 보인다. `ShutdownBlockReasonCreate` 는 창을 만든 스레드(Tauri 의 메인 · 이벤트 루프 스레드)에서 불러야 하므로 `run_on_main_thread` 로 넘겨야 한다. 트레이로 숨긴 창은 「보이는 창이 없는 앱」이 되어 **종료를 취소할 수 없게 될 가능성이 크다**. 이 경우 5초 안에 `WM_ENDSESSION` 에서 마지막 저장과 「보낼 묶음 파일」 쓰기만 하는 것이 현실적이다.
- 권장 구성:
  - 미동기 변경이 있는 동안만 `PowerCreateRequest` 와 `PowerRequestSystemRequired` 를 켠다. 사유는 「동기화 대기 중인 변경 3건」처럼 쓴다. AC 전원일 때만 켜고, 상한(예: 2시간)을 둔다.
  - 종료 시도 때는 `ShutdownBlockReasonCreate`(「아직 아무에게도 전달되지 않은 변경이 있습니다」)로 한 번만 묻는다.
  - 근본 대책은 2·3절의 파일 · 중계 쪽이다.
- AwayMode 는 노트북에 쓰지 말라고 문서가 명시한다. 사무 데스크톱에서도 「꺼진 줄 알았는데 켜져 있음」이 되므로 쓰지 않는 편이 낫다.
- 깨우기 타이머: 작업 스케줄러 `WakeToRun` 이나 `CreateWaitableTimer` 의 resume 인자로 「아침 8시에 깨워 동기화」를 할 수 있다. 그러나 전원 옵션 「절전 모드 해제 타이머 허용」이 꺼져 있거나 숨겨진 PC 가 많다는 보고가 있다. 완전히 끈 상태(S5)에서는 깨울 수 없다. 사무실에서 믿을 수단은 아니다. — [KB973454](https://support.microsoft.com/en-us/kb/973454); [WakeToRun](https://learn.microsoft.com/en-us/windows/win32/TaskSchd/taskschedulerschema-waketorun-settingstype-element)
- Wake-on-LAN: BIOS · NIC 설정과 같은 브로드캐스트 도메인이 필요하다. 깨우는 쪽 PC 가 켜져 있어야 한다는 모순도 있다. 「누군가 출근해서 앱을 켜면 동료 PC 를 깨워 받기」 정도의 보조 수단으로만 볼 수 있다. 회사 망 정책으로 막힌 경우가 흔하다(추정, 출처 없음).

### Gaps
- Tauri 2 / tao 가 `WM_QUERYENDSESSION` 을 내부에서 어떻게 처리하는지(DefWindowProc 로 TRUE 를 돌려주는지, 훅을 걸 수 있는지)를 다룬 공식 문서나 이슈는 찾지 못했다.
- `prevent_close` · `prevent_exit` 메서드 이름은 이번에 연 페이지에서 확인하지 못했다(ExitRequestApi · CloseRequestApi 페이지를 따로 열어야 한다).
- Windows Update 강제 재시작이 `ShutdownBlockReasonCreate` 를 존중하는지 밝힌 Microsoft 공식 문서를 찾지 못했다. `ENDSESSION_CRITICAL` 이면 막을 수 없다는 것만 lParam 정의로 알 수 있다.
- 작업 스케줄러가 배터리에서 깨우지 않는 현재 기본값을 확인한 공식 출처는 없다(2003년대 문서뿐이다).

## 2. 파일로 넘기기: 서명된 묶음 파일과 「이미 있는 공유 폴더」를 우편함처럼 쓰기

### Takeaway
「서버 없이 변경을 남에게 맡기는」 가장 확실한 길은 이미 있는 통로로 **추가 전용 · 서명된 증분 묶음 파일**을 넘기는 것이다. 통로는 메신저 · 메일 · USB · OneDrive · 사내 SMB 공유를 쓸 수 있다. git bundle 과 SSB 가 검증된 선례다. 공유 폴더는 「파일 하나를 여럿이 고치는」 방식으로 쓰면 충돌 사본과 Files On-Demand 문제가 생긴다. **보낸 사람마다 · 묶음마다 새 파일을 쓰고, 한 번 쓴 파일은 다시 고치지 않는** 방식으로 써야 안전하다.

### Cited Findings
- git bundle 은 "the 'offline' transfer of Git objects without an active 'server' sitting on the other side" 를 위한 것이다. 증분 묶음(`old..new`)은 받는 쪽에 `old` 가 있어야 한다. `git bundle verify` 가 선행 커밋이 있는지 검사하고, 없으면 무엇이 필요한지 알려 준다. 묶음은 원격처럼 `fetch` · `clone` 할 수 있지만 push(쓰기)는 안 된다. 「마지막으로 보낸 지점」을 태그로 기억해 두고 다음 증분을 만드는 흐름이 매뉴얼에 있다. — [git-bundle](https://git-scm.com/docs/git-bundle)
- SSB: 신원 하나가 서명된 추가 전용 피드 하나를 갖고, 피드마다 해시 사슬로 이력을 바꿀 수 없게 한다. 「내가 아는 최신 다음 것만 달라」로 복제한다. 전송이 중간에 끊겨도 빈틈 없는 유효한 로그로 남는다(끝이 오래됐을 뿐이다). 인터넷 · LAN · sneakernet(USB) 으로 모두 동작한다. 로그를 잃은 사람이 팔로워의 사본에서 복구한 사례가 있다. — [Wikipedia SSB](https://en.wikipedia.org/wiki/Secure_Scuttlebutt); [Tschudin ICN 2019](https://conferences2.sigcomm.org/acm-icn/2019/proceedings/icn19-19.pdf); [tinyssb](https://github.com/ssbc/tinyssb); [IETF ICNRG 슬라이드](https://datatracker.ietf.org/meeting/interim-2018-icnrg-03/materials/slides-interim-2018-icnrg-03-sessa-secure-scuttlebut-00); [Staltz](https://staltz.com/an-off-grid-social-network)
- Syncthing 「untrusted(encrypted) devices」: 신뢰 기기가 폴더별 암호를 정한다. 그러면 받는 쪽(클라우드 VM 등)은 내용 · 파일 이름 · 시간 · 해시 · 디렉터리 구조를 볼 수 없다. 폴더 ID · 라벨 · 대략의 크기는 보인다. 신뢰 기기끼리 직접 만나지 않아도 그 기기를 거쳐 동기화된다. XChaCha20-Poly1305 · AES-SIV · scrypt 를 쓴다. 그러나 문서가 "beta / testing only" 라고 한다. — [Syncthing Untrusted Devices](https://docs.syncthing.net/users/untrusted.html)
- KeePass 2.x 는 로컬 디스크 · 네트워크 공유 · WebDAV 등에 있는 다른 사본과 **병합(synchronize)** 한다. 항목 단위로 최종 수정 시각이 새 쪽을 남기고, 진 쪽은 이력 항목으로 보존한다. 클라우드는 FTP · WebDAV 대신 클라이언트의 로컬 폴더 연동(OneDrive · Dropbox · Google Drive)을 권한다. 저장할 때 디스크의 파일이 바뀌었으면 덮어쓸지 병합할지 묻는다. 클라우드 소프트웨어가 덮어써서 데이터를 잃지 않도록 트리거로 「Local↔Master 동기화」를 하는 예시가 있다. — [KeePass Synchronization](https://keepass.info/help/v2/sync.html)
- Obsidian 볼트를 OneDrive 에 두면 자주 바뀌는 `.obsidian/workspace.json` 의 충돌 사본이 쌓이고, 열린 파일이 EBUSY 로 잠기는 보고가 있다. Obsidian 은 OneDrive · Dropbox 의 「Files On-Demand」가 로컬 파일을 치우면 삭제로 오인해 원격에서도 지울 수 있다고 경고한다. 그래서 「항상 이 장치에 유지」를 권한다. — [Obsidian 포럼: workspace.json 사본](https://forum.obsidian.md/t/vault-synced-over-onedrive-across-multiple-machines-generates-many-copies-of-workspace-json/115229); [OneDrive and EBUSY](https://forum.obsidian.md/t/onedrive-and-ebusy/85929); [How to use Obsidian Sync Effectively and Safely](https://forum.obsidian.md/t/how-to-use-obsidian-sync-effectively-and-safely/80545)
- Briar 는 원래 양쪽이 동시에 접속해야 해서 「도달성이 나쁘다」. 그래서 남는 안드로이드 기기를 전원 · Wi-Fi 에 꽂아 두는 **Briar Mailbox** 를 냈다(2023-06). 연락처가 주인이 꺼져 있을 때 거기에 맡기고, 주인이 나중에 가져간다. 주인 · 연락처 사이 메시지만 다루고 Tor 로만 접속한다. — [Briar Mailbox 출시](https://briarproject.org/news/2023-briar-mailbox-released/); [README](https://code.briarproject.org/briar/briar-mailbox/-/raw/6d24f124fd48c3fa177bba171e87ce593fc26a7b/README.md)

### Inferences
- ClaudePPT 에 맞춘 설계 안:
  - 변경을 「작성자 키로 서명한 추가 전용 op 묶음」 파일로 만든다. 예: `.cppt-bundle`. 파일에는 덱 ID · 작성자 · 선행 버전 벡터(무엇이 있어야 적용되는지) · op 들 · 서명을 담는다.
  - 받는 쪽은 `git bundle verify` 처럼 「선행이 없으면 무엇이 빠졌는지」를 보여 준다. 같은 묶음을 두 번 받아도 같은 결과가 나와야 한다(멱등). 손상된 묶음은 앞부분까지만 적용한다.
  - 종료 시도(`WM_ENDSESSION`), 트레이 메뉴 「동기화 못 한 변경 내보내기」, 미전달 경고 배너에서 이 파일을 **한 번에 만들어 바로 보낼 수 있게** 한다. 탐색기에서 선택된 상태로 열거나 클립보드에 담아 메신저에 붙여 넣게 한다.
- 공유 폴더 우편함 규칙:
  1. 보낸 사람 · 묶음마다 새 파일 이름을 쓴다. 예: `outbox/<작성자ID>/<시퀀스>-<해시>.cppt-bundle`.
  2. 임시 이름으로 다 쓴 뒤 원자적으로 rename 한다(반쯤 올라간 파일을 읽지 않게).
  3. 한 번 쓴 파일은 고치지 않는다. 그러면 충돌 사본이 생길 여지가 없다.
  4. 읽는 쪽은 디렉터리 목록만 보고 모르는 파일만 가져온다. 「읽음 표시」를 그 파일에 쓰지 않는다.
  5. Files On-Demand 자리 표시 파일은 열 때 내려받기를 기다리거나, 그 폴더를 「항상 유지」로 둔다.
  6. 오래된 묶음은 모두가 받은 것이 확인된 뒤에만 지운다(3절 전달 상태와 연결). 이렇게 하면 KeePass 식 「한 파일 병합」보다 안전하다.
- OneDrive · Google Drive · SMB 는 「상시 서버」가 아니라 사용자가 이미 쓰는 저장소다. 그래서 「서버를 두지 않는다」 제약과 맞는다. 다만 회사 OneDrive 를 개인 업무 덱에 쓰는 것이 사내 보안 정책에 맞는지는 따로 확인해야 한다. 묶음을 받는 사람 키로 암호화하면(age 등) 공유 폴더 관리자도 내용을 볼 수 없다(Syncthing untrusted 와 같은 생각).

### Gaps
- Delta Chat 의 오프라인 동기화(메일을 통로로 쓰는 방식)와 webxdc 의 「메일로 상태 동기화」 자료는 이번에 열어 보지 못했다. 「메일 · 메신저를 통로로」 쓰는 선례로 확인할 가치가 있다.
- Joplin 의 파일 시스템 · OneDrive 동기화 대상(파일 하나에 항목 하나, 잠금 파일)은 확인하지 못했다.
- SMB 공유에서 rename 원자성과 오프라인 파일(CSC) 기능의 상호작용은 조사하지 못했다.

## 3. 기회적 중계: 접속해 있는 아무 동료가 남의 변경을 맡아 전달하기 · 전달 상태 UX

### Takeaway
서명된 추가 전용 op 이면 **누가 들고 오든 같은 내용임을 검증할 수 있으므로**, 모든 피어가 받은 op 를 다른 피어에게 다시 건네는 store-and-forward · gossip 이 안전하게 된다(SSB 가 선례). 휴가 시나리오는 「오늘 밤 누군가 잠깐이라도 켜 있었다면」 그 사람이 다음 날 퍼뜨려 준다. 아무도 없었다면 2절의 파일 넘기기만 남는다. 「몇 명에게 전달됐는지」 표시가 이 판단을 사용자에게 맡기는 열쇠다.

### Cited Findings
- SSB 는 피어가 남의 피드 사본까지 보관 · 복제한다. 원 작성자 로그가 사라져도 팔로워의 사본에서 복구할 수 있었다. 서명과 해시 사슬이 있어 중계자가 내용을 바꿀 수 없다. — [IETF ICNRG 슬라이드](https://datatracker.ietf.org/meeting/interim-2018-icnrg-03/materials/slides-interim-2018-icnrg-03-sessa-secure-scuttlebut-00); [Wikipedia SSB](https://en.wikipedia.org/wiki/Secure_Scuttlebutt); [Kermarrec 외, Gossiping with Append-Only Logs](https://dicg2020.github.io/papers/kermarrec.pdf)
- Briar Mailbox 는 「항상 켜진 우편함」을 사용자 소유 기기로 둔 store-and-forward 다. 주인이 오프라인인 연락처에게 보낸 메시지도 상대가 접속하면 자동으로 전달된다. — [Briar Mailbox 출시](https://briarproject.org/news/2023-briar-mailbox-released/)
- Keyhive · Beelay 는 동기화 상대가 복호화하지 못하는 종단간 암호화 페이로드를 주고받는다. 그래서 중계자가 내용을 보지 않고도 전달할 수 있다. 접근이 허가된 사본하고만 동기화한다(defense-in-depth). — [Keyhive 프로젝트](https://www.inkandswitch.com/project/keyhive/)

### Inferences
- 구현 안:
  - 각 피어는 덱별로 「알고 있는 op 집합」(버전 벡터 · 작성자별 마지막 시퀀스)을 갖는다. 접속하면 서로 빠진 것만 주고받는다(SSB 의 「최신 다음 것만」).
  - 수신 확인(ack)도 op 처럼 서명해 gossip 한다. 그러면 작성자가 꺼져 있는 사이에 누가 받았는지도 나중에 모인다.
  - 부분 공개(4절)를 쓰면 중계자는 자기가 못 읽는 암호문 op 도 그대로 보관 · 전달해야 한다. 이것이 Keyhive 의 「서버가 못 읽는 동기화」와 같은 구조다.
- 전달 상태 UX 안. 메신저의 「1」 · 「읽음」 표시에 대응한다.
  - op 묶음마다 세 단계를 보여 준다. 「이 PC 에만 있음」(빨강) → 「n 명에게 전달됨」 → 「모두에게 전달됨」.
  - 「이 PC 에만 있음」이 남아 있으면 창을 닫을 때 · 종료할 때 · 트레이 아이콘에서 경고하고, 2절의 「파일로 보내기」 버튼을 바로 옆에 둔다.
  - 전달은 「누군가의 PC 에 사본이 있음」이고, 그 사람이 「봤음」과는 다르다. 승인 협업이라면 둘을 다른 낱말로 나눈다.
- 최소 사본 수 정책(「1명 이상에게 전달되기 전에는 끄면 경고」)이 1절의 전원 API 를 켜고 끄는 조건이 된다.

### Gaps
- 로컬 퍼스트 앱(Automerge 기반 앱 · Anytype · Linear 의 오프라인 모드 등)에서 「n 명에게 전달됨」을 실제로 보여 주는 사례 자료는 찾지 못했다. Signal · WhatsApp 의 전달 · 읽음 표시가 가장 가까운 UX 선례지만 이번에 출처를 열지 않았다.
- gossip 의 대역 · 저장 비용(남의 op 를 언제까지 보관하는지, GC 기준)에 대한 구체 수치는 조사하지 못했다.

## 4. 모두가 사본을 가질 때 「일부 쪽만 일부 사람에게」 보여 주기

### Takeaway
피어 모두가 사본을 갖는 구조에서 부분 공개는 **암호화로만** 할 수 있다. 쪽(또는 쪽 묶음)마다 내용 키를 두고, 볼 수 있는 사람에게만 그 키를 감싸서 준다. 회수할 때는 새 키로 바꿔 **앞으로의 변경**만 막을 수 있다. **이미 본 내용과 이미 받은 키는 되돌릴 수 없다**(Keyhive · git-crypt 모두 명시). git-crypt 처럼 「파일별 대칭키 + 회수 없음」이면 쉽다. Keyhive · BeeKEM 수준의 동시성 안전한 그룹 키는 연구 단계(pre-alpha)다. 작은 팀이면 「쪽 묶음별 키 + 받는 사람마다 age 로 감싸기 + 회수 때 새 키」가 현실적인 중간점이다.

### Cited Findings
- Keyhive 노트 01 원문: "While we can revoke future write access, if someone has the data and the symmetric key" 그 사람은 그 데이터를 읽을 수 있다. 과거 내용을 회수할 수 없다는 한계를 명시한 것이다. — [Keyhive notebook](https://www.inkandswitch.com/keyhive/notebook/)
- BeeKEM 은 TreeKEM(MLS)을 본떴다. Causal TreeKEM 의 착안을 더했고, DH 와 BLAKE3 같은 표준 primitive 만 쓴다. 원문: "each application secret is used to encrypt exactly one document chunk." 멤버가 DH 공개키를 바꾸면 루트 비밀이 바뀌어 사후 침해 보안(PCS)을 준다. — [Keyhive notebook 02: Group Key Agreement with BeeKEM](https://www.inkandswitch.com/keyhive/notebook/02/)
- IACR ePrint 2026/1434 는 BeeKEM 을 「흔한 경우 로그 비용(최악 선형)의 첫 분산 그룹 키 합의」로 소개하고 보안 증명을 낸다. — [ePrint 2026/1434](https://eprint.iacr.org/2026/1434)
- Keyhive 는 "Self-certifying, concurrent group management complete with coordination-free revocation" 과, 사본이 마음대로 갈라진 상태에서도 동시에 갱신되는 CGKA 를 목표로 한다. 2025-03 pre-alpha 공개 때 원문: "DO NOT use this release in production applications". 보안 감사도 받지 않았다. 노트는 2026-11-11(08 Rain Diagrams)까지 이어지고, 안정 판 공개 소식은 보이지 않는다. — [Keyhive 프로젝트](https://www.inkandswitch.com/project/keyhive/); [Keyhive notebook](https://www.inkandswitch.com/keyhive/notebook/)
- git-crypt: "does not support revoking access to an encrypted repository which was previously granted". `del-gpg-user` 도 키 회전도 없다. 옛 키를 가진 사람은 과거 이력에 계속 접근할 수 있다. 파일 이름 · 커밋 메시지 · 길이 · 변경 시점 같은 메타데이터를 암호화하지 않는다. 「대부분 공개이고 일부 파일만 비밀」인 저장소에 맞는다고 스스로 밝힌다. 최신 0.8.0(2025-09-23), 1.0 전이라 호환을 깨는 변경이 있을 수 있다. — [git-crypt README](https://github.com/AGWA/git-crypt)
- Syncthing untrusted 도 파일 내용과 이름을 숨기지만 크기 · 폴더 라벨은 드러난다. 메타데이터 누출은 이 방식의 공통 한계다. — [Syncthing Untrusted Devices](https://docs.syncthing.net/users/untrusted.html)

### Inferences
- 선택지별 복잡도(추정):
  - **A. 공개 범위를 「덱 단위」로만 둔다.** 비밀 쪽은 따로 덱을 만든다. 구현이 가장 적고, 2·3절 동기화를 그대로 쓴다.
  - **B. 쪽 묶음(공개 범위 그룹)별 대칭키(XChaCha20-Poly1305 등).** 키를 받는 사람마다 공개키로 감싼다(age 의 X25519 수신자 모델과 같다). 회수 때는 새 키를 만들어 남은 사람에게만 감싸고, 그 뒤 op 만 새 키로 암호화한다. 주의할 점:
    - 동시에 두 사람이 키를 바꾸면 갈라진다. 「키 epoch 를 op 로 기록하고 둘 다 유효로 보며, 다음 변경에서 합친다」 정도로 다룬다.
    - 덱 구조(쪽 순서 · 쪽 수 · 제목)를 평문으로 두면 「숨은 쪽이 있다」는 사실은 새어 나간다.
    - 못 읽는 사람도 암호문 op 를 보관 · 중계해야 한다(3절).
    - 승인 흐름에서 「못 본 쪽을 승인」할 수는 없으므로, 승인 대상도 공개 범위로 나눠야 한다.
    - 작은 팀(10명 이하)에서는 키를 사람 수만큼 감싸는 O(n) 비용이 문제가 되지 않는다. TreeKEM 류가 필요한 규모가 아니다.
  - **C. Keyhive · BeeKEM 을 그대로 쓴다.** 동시성 · PCS · 회수를 다 갖추지만, pre-alpha 이고 Automerge · Beelay 에 맞춰져 있다. 제품에 넣기에는 이르다. 연구 추적 대상이다.
- 사용자에게 알려야 할 한계(문구 안): 「공개 범위에서 뺀 사람은 앞으로의 변경을 볼 수 없습니다. 이미 본 내용과 그 사람 PC 에 있던 사본은 지울 수 없습니다.」 「숨은 쪽이 있다는 것과 대략의 크기는 보입니다.」
- PPTX 내보내기 · 화면 캡처 · 복사로 새는 것은 암호화로 막지 못한다. 부분 공개는 「실수로 보지 않게」 하는 수준이고, 「악의적 내부자로부터 지키기」에는 미치지 못한다고 보는 편이 정직하다.

### Gaps
- BeeKEM 에서 멤버를 뺄 때 키를 갱신하는 구체 절차와, Keyhive 의 Rust crate(keyhive_core) 현재 판 · API 안정성은 이번에 열어 보지 못했다(notebook 03~08, ePrint 본문).
- age 의 다중 수신자 헤더 크기와 수신자 수 한도, rage(Rust 구현) 상태는 확인하지 못했다.
- MLS(RFC 9420) 의 Rust 구현(OpenMLS 등)을 서버 없이 쓸 때의 순서(commit 직렬화) 문제는 조사 범위 밖이었다.
