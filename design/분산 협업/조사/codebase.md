# ClaudePPT 코드베이스 → 분산 사본 · 승인 관문 협업 전환 분석

조사 기준: 2026-11-27 `main` (`6938a37`, 0.15.0). 출처는 모두 저장소 안 파일:줄 (`D:/workspace/_tools/claudeppt` 기준 상대 경로).
덱 크기 실측만 저장소 밖(이 PC 의 앱 저장 폴더 덱들에 `du` · `git rev-list`)이다. 코드를 읽기만 했고 아무것도 실행 · 수정하지 않았다.

---

## 1. 지금 협업 구조 — 팀원 창은 데이터를 어떻게 받나

### Takeaway
지금은 **덱 주인 한 곳이 쓰고 나머지는 받아 보는 중앙(호스트) 구조**다. 덱 주인 앱 안의 HTTP+WebSocket 서버(127.0.0.1)가 상태를 밀어 주고, 팀원 앱은 iroh 흐름을 TCP 로 이어 그 서버를 원격 웹 화면으로 띄운다. 팀원 쪽에는 덱 사본도 git 도 없다(「내 Claude」용 파일 거울만 있다). 목표 설계와는 데이터 소유 방향이 정반대다.

### Cited Findings
**서버(덱 주인)**
- 협업 서버는 「공유」를 켤 때 덱 주인 앱 안에서 `127.0.0.1` 에만 연다. 사무실 망(0.0.0.0)은 「브라우저로 들어오게 하기」(`collab_lan`)를 켤 때만 따로 연다 — [src-tauri/src/collab.rs:1-3](../../../src-tauri/src/collab.rs), bind 는 [collab.rs:519 부근 `collab_start`](../../../src-tauri/src/collab.rs) (`TcpListener::bind(("127.0.0.1", 0))`)
- **쓰기는 호스트 한 곳에서만**: 브라우저 · 팀원 창의 쓰기는 「collab-intent」 사건으로 덱 주인 화면에 넘기고 답을 기다린다. 「두 화면이 같은 파일 · 대화 기록을 따로 쓰면 하나가 다른 것을 덮는다」가 까닭이다 — [collab.rs:13-14](../../../src-tauri/src/collab.rs)
- 공유는 켤 때 연 덱 하나(`Hub.dir`)에 묶이고 장부(링크 · 기기)도 덱마다 따로다 — [collab.rs:22-24](../../../src-tauri/src/collab.rs), `Hub` 정의 [collab.rs:71-104](../../../src-tauri/src/collab.rs)
- 상태 흐름: 덱 주인 화면이 `collab_publish` 로 바뀐 칸만 올리면 `Hub::publish` 가 `Shared{seq,set,order,turns}` 에 쌓고 `broadcast` 로 모든 연결에 보낸다 — [collab.rs:339-386](../../../src-tauri/src/collab.rs), `Shared` [collab.rs:107-113](../../../src-tauri/src/collab.rs), `Out::{Text,State,Snap}` [collab.rs:116-124](../../../src-tauri/src/collab.rs). 화면 쪽 올리는 칸 목록 `SHARED = ["dir","id","deck","rev","sessions","bind","talkKey","versions","releases","holds","running","runs","pins","assign","editing","histBy"]` — [src/lib/collab.ts:104](../../../src/lib/collab.ts), `flush` [collab.ts:124-152](../../../src/lib/collab.ts)
- 새로 붙거나 따라가지 못한(Lagged) 연결에는 `snapshot()` 으로 통째 상태를 다시 준다 — [collab.rs:307-315](../../../src-tauri/src/collab.rs), [collab.rs:1179-1186](../../../src-tauri/src/collab.rs)
- 연결마다 볼 몫을 서버가 거른다: `view()` = 세션 묶음 거르기(`pool_view`) + 담당 쪽만(`limit_view`) — [collab.rs:289-300](../../../src-tauri/src/collab.rs), `pool_of` [collab.rs:274-286](../../../src-tauri/src/collab.rs), `pool_view` [collab.rs:481-508](../../../src-tauri/src/collab.rs)
- `limit_view`: 맡지 않은 쪽은 `{id, file:"", title:"", hidden:true}` 자리만 남기고, `rev · editing · assign · bind · pins` 에서 그 쪽을 빼고, `versions · releases · holds` 는 빈 배열, 대화는 그 사람이 보낸 턴만 — [collab.rs:434-478](../../../src-tauri/src/collab.rs). 자리를 남기는 까닭은 「@3」 쪽 번호가 어긋나지 않게 — [collab.rs:434-436](../../../src-tauri/src/collab.rs)
- `Allow`: 담당 쪽만 보는 사람이 읽어도 되는 파일 = 맡은 쪽 HTML · 테마 · `assets/` · `.claudeppt/attach/`. `deck.json` · 남의 쪽 · 판 기록은 안 된다 — [collab.rs:409-432](../../../src-tauri/src/collab.rs). 슬라이드 주소 열쇠는 사람 몫 `member_key = hash(deck_key:device)` — [collab.rs:324-326](../../../src-tauri/src/collab.rs), 검사 [collab.rs:1026-1050](../../../src-tauri/src/collab.rs) (지난 변경 `@커밋` 주소도 막는다 [collab.rs:1043-1048](../../../src-tauri/src/collab.rs))
- 슬라이드는 `/_/d/<덱 열쇠>/<id>[@커밋]/<경로>` 로 sandbox iframe 에 내주고 CSP `connect-src 'none'` — [collab.rs:5-8](../../../src-tauri/src/collab.rs), 라우트 [collab.rs:872-887](../../../src-tauri/src/collab.rs)
- `/_/rpc` 는 읽기 허용 목록뿐: `read` · `exists` · `log`(=`vcs_log`). 그 밖은 「원격에서는 쓸 수 없다」 — [collab.rs:1105-1131](../../../src-tauri/src/collab.rs); 화면 쪽 대응표 `READS = {fs_read_text:"read", fs_exists:"exists", vcs_log:"log"}` — [src/lib/transport.ts:15](../../../src/lib/transport.ts)
- 의도 허용 목록 `INTENTS = ["send","stop","newTalk","direct","undo","redo","pinAdd","pinUpdate","pinRemove","pinResolve","pinSend","upload"]` — [collab.rs:63](../../../src-tauri/src/collab.rs). `on_message` 는 목록 → 장부의 권한(`role.allows`) 순으로 거르고 `collab-intent` 를 덱 주인 화면에 낸 뒤 최대 3시간(`INTENT_WAIT`) 답을 기다린다 — [collab.rs:1199-1265](../../../src-tauri/src/collab.rs), [collab.rs:56](../../../src-tauri/src/collab.rs)
- 덱 주인 화면의 의도 처리기 `handleIntent` 가 호스트 store 로 처리한다. 덱 주인이 다른 덱을 보면 거절 — [src/lib/collab.ts:278-288](../../../src/lib/collab.ts). 쪽 범위는 화면이 다시 막는다: `slideOk` · `scopeFor` · `hiddenFor` — [collab.ts:322-342](../../../src/lib/collab.ts)
- 「담당 쪽만」 요청은 Claude 턴 사본에서 남의 쪽을 비우고(`hideIn`) 담당 밖 쓰기를 되돌린다(`fenceOf`/`unfence`) — [src/lib/store.ts:526-560](../../../src/lib/store.ts), [store.ts:656-716](../../../src/lib/store.ts)

**신원 · 초대 (invite.rs)**
- `Book{links, devices, locked…}` · `Link` · `Device{id, hash, name, link, created, seen, runner, role, limit}` — [src-tauri/src/invite.rs:14-58](../../../src-tauri/src/invite.rs)
- 들어오면 기기 비밀을 만들고 해시만 장부에 둔다. **같은 이름의 기존 기기 권한 · 제한을 새 기기가 잇는다** — [invite.rs:151-163](../../../src-tauri/src/invite.rs) (158행 `limit = devices.any(name==name && limit)`), `set_role`/`role_of`/`set_limit`/`limited` 이 이름 단위로 움직인다 [invite.rs:199-223](../../../src-tauri/src/invite.rs), 시험 `roles_follow_the_person_and_gate_intents` [invite.rs:350-368](../../../src-tauri/src/invite.rs)
- `Role{Edit, Assigned, Comment, View}` 와 `allows(intent)`: 편집 · 담당은 모두, 의견만은 핀 의도 4개, 보기만은 없음 — [invite.rs:61-80](../../../src-tauri/src/invite.rs)
- 기기 쿠키 이름 `cppt_d` (HttpOnly) — [collab.rs:52](../../../src-tauri/src/collab.rs), [collab.rs:15-17](../../../src-tauri/src/collab.rs); `auth` 미들웨어가 쿠키 → `Who{device,name}` 를 붙인다. IP 로 믿지 않는다(터널 · iroh 로 온 것도 127.0.0.1) — [collab.rs:895-919](../../../src-tauri/src/collab.rs), [collab.rs:18-21](../../../src-tauri/src/collab.rs)
- **팀원 이름은 서버가 정한 기기 이름**이고 요청 · 편집 · 판의 보낸 사람으로 쓰인다 — [collab.rs:18](../../../src-tauri/src/collab.rs). git 에는 그 이름이 `--author=<이름> <member@claudeppt>` 로만 남는다(서명 없음) — [src-tauri/src/vcs.rs:158-163](../../../src-tauri/src/vcs.rs)
- 장부 파일은 앱 데이터 `collab/<덱 지문>.json` — [collab.rs:16](../../../src-tauri/src/collab.rs), `book_file` [collab.rs:220](../../../src-tauri/src/collab.rs)

**앱끼리 잇기 (p2p.rs)**
- 앱마다 한 번 만든 ed25519 열쇠가 주소다. 앱 데이터 `p2p.key` 에 DPAPI 로 싸 둔다 — [src-tauri/src/p2p.rs:3-4](../../../src-tauri/src/p2p.rs), `key_file`/`secret()` [p2p.rs:45-62](../../../src-tauri/src/p2p.rs) (iroh `SecretKey`)
- ALPN 은 하나 `b"claudeppt/collab/1"`, 엔드포인트는 `presets::N0` + 그 ALPN 만 — [p2p.rs:28](../../../src-tauri/src/p2p.rs), [p2p.rs:65-77](../../../src-tauri/src/p2p.rs). iroh 판은 `1.5` (`tls-ring`, `portmapper`) — [src-tauri/Cargo.toml:54](../../../src-tauri/Cargo.toml)
- 중계는 n0 공용 중계(문서상 시험용, 속도 제한) — [p2p.rs:5-6](../../../src-tauri/src/p2p.rs)
- 덱 주인 쪽 `serve`: 들어온 bi 흐름마다 `127.0.0.1:<협업 포트>` TCP 로 그대로 넘긴다(`pipe`). 협업이 꺼져 있으면 연결을 닫는다. **누가 들어오는지는 iroh 열쇠가 아니라 협업 서버의 링크 · 쿠키가 가린다** — [p2p.rs:7-8](../../../src-tauri/src/p2p.rs), [p2p.rs:87-122](../../../src-tauri/src/p2p.rs)
- 팀원 쪽 `gate`: 덱 주인마다 `http://<열쇠 앞 20자>.localhost:<포트>` 출입구를 열고, 들어온 TCP 를 iroh 흐름 하나로 잇는다 — [p2p.rs:164-209](../../../src-tauri/src/p2p.rs), 「내 Claude」는 127.0.0.1 로 바로(`direct`) [p2p.rs:9-12](../../../src-tauri/src/p2p.rs)
- 시험은 TCP↔iroh 파이프 1개 · 링크 읽기 2개 — [p2p.rs:244-300](../../../src-tauri/src/p2p.rs)

**팀원 창 · 화면 쪽**
- `collab_join`: 링크 → `p2p::canon` · `reach` → 출입구 주소로 **외부 URL 웹뷰 창**을 띄우고 `window.__CPPT_REMOTE__ = true` 를 심는다. 탐색은 그 출처 안으로 막는다 — [collab.rs:720-751](../../../src-tauri/src/collab.rs)
- `transport.ts`: `remote` 면 명령 대신 `/_/rpc` 로, 그 밖 명령은 `RemoteDenied` — [src/lib/transport.ts:1-30](../../../src/lib/transport.ts)
- `join.ts`: 링크 넣기 세 길(붙여 넣기 · claudeppt:// 누르기 · 복사해 두기), 들어가면 `runner_start` 로 「내 Claude」를 처음부터 붙인다 — [src/lib/join.ts:1-30](../../../src/lib/join.ts)
- 팀원 화면은 `connect()` 로 `/_/ws` 상태를 store 에 얹고(`apply`), 쓰기는 `remoteActions()` 가 의도로 바꾼다(예: `applyDirect` → `intent("direct")`, `addPin` → `intent("pinAdd")`) — [src/lib/collab.ts:516-660](../../../src/lib/collab.ts)

**팀원 PC 의 Claude (runner.rs)**
- 팀원 PC 는 앱 데이터 `shared/<호스트>/<덱 id>/` 에 덱 파일 거울을 두고, 턴마다 `/_/runner/manifest` 로 맞추고 그 사이엔 바뀐 경로만 받는다 — [src-tauri/src/runner.rs:9](../../../src-tauri/src/runner.rs), `sync`/`changed`/`fetch` [runner.rs:286-378](../../../src-tauri/src/runner.rs); 서버 쪽 manifest(`.git` · `releases` 제외, `Allow` 적용) [collab.rs:1395-1424](../../../src-tauri/src/collab.rs), file [collab.rs:1431-1440](../../../src-tauri/src/collab.rs)
- 턴 지휘(줄 세우기 · 대화 · 판)는 덱 주인 앱이 하고 claude 프로세스만 팀원 PC 에서 돈다. 팀원 PC 가 보낸 파일은 **덱이 아니라 그 턴의 작업 사본**에 쓰고, 끝나면 덱 주인 화면이 덱 위에 얹는다 — [collab.rs:1262-1272](../../../src-tauri/src/collab.rs), `RemoteRun.work` [collab.rs:1284-1292](../../../src-tauri/src/collab.rs)
- 받는 쓰기 필터 `writable`: `.git` · `.claudeppt` · `releases/` · `..` · 절대 경로 금지 — [collab.rs:1302-1305](../../../src-tauri/src/collab.rs); 거울 필터 `mirrored` [collab.rs:1294-1300](../../../src-tauri/src/collab.rs)
- 「내 Claude」 전용 열쇠는 DPAPI 로 싸서 `runner-keys.json` — [runner.rs:5-7](../../../src-tauri/src/runner.rs), [runner.rs:55-80](../../../src-tauri/src/runner.rs)

**세션 라우팅 (claudeFor)**
- 세션 공유 켬: 모두 덱 주인 세션, 「내 Claude」를 고르면 그 PC. 끔: 앱 팀원은 자기 PC Claude · 자기 묶음(없으면 막음), 브라우저 팀원은 덱 주인 Claude · 덱 주인 묶음. 담당 쪽만 보는 사람은 늘 자기 묶음 — [src/lib/collab.ts:294-320](../../../src/lib/collab.ts); 같은 규칙의 서버판 `pool_of` [collab.rs:272-286](../../../src-tauri/src/collab.rs)

### Inferences
- 팀원 창이 받는 것은 **덱 주인 store 의 JSON 투영(projection)** 과 HTTP 로 내준 슬라이드 파일뿐이다. 팀원 쪽에는 git 이 전혀 없고, 「판 목록」도 `vcs_log` rpc 결과다. 목표 설계에서 이 투영 계층(`publish` · `snapshot` · `view` · `limit_view` · `pool_view` · 의도 왕복)은 앱 팀원에게는 거의 통째로 필요 없어진다 — 각자 main 창에서 자기 사본을 연다.
- p2p 계층은 **iroh 위에 HTTP 를 터널링하는 얇은 관**이다. 열쇠는 주소로만 쓰이고 인증에는 안 쓰인다 — 목표 설계(열쇠 = 서명 신원)로 가려면 열쇠의 쓰임이 「주소」에서 「신원」으로 바뀐다.

### Gaps
- `Collab.tsx`(502줄) · `Workspace.tsx`(910줄) · `Talk.tsx`(791줄) 안에서 `remote` 분기가 몇 곳인지는 세지 않았다 (`useCollab|remote|intent(` 가 든 tsx 9개, 합 3,646줄 — `grep -l` 결과).

---

## 2. 판 관리 (vcs.rs · branch.rs) — 제안 · 승인 · 합치기에 무엇을 그대로 쓰나

### Takeaway
git 을 CLI 로 띄우는 판 관리가 이미 **작업 사본(worktree) → 3방향 얹기(cherry-pick) → 겹치면 보류 갈래(`cppt/hold/`)**, **가지(`cppt/sian/`) → `merge --no-ff` (+ `-Xours/-Xtheirs` 고르기)**, **사본(`clone`) → `push`/`fetch` 로 가지 가져오기(이력 이어짐 검사)** 까지 갖췄다. 「제안 = 가지 · 보류」, 「승인 = 줄기에 넣기」의 뼈대로 거의 그대로 쓸 수 있다. 빠진 것은 **서명 · 검증 · 원격 전송(iroh 위 git) · 줄기 전진 규칙(fast-forward 만)** 이다.

### Cited Findings
- git 호출은 모두 `git(dir)` 하나를 거치고 매번 `-c` 로 설정을 준다: `core.autocrlf=false`, `core.quotepath=false`, `user.name=ClaudePPT`, `user.email=claudeppt@local`, **`commit.gpgsign=false`**, **`tag.gpgsign=false`**, `core.hooksPath=.git/claudeppt-no-hooks`, `core.fsmonitor=false`, **`log.showSignature=false`**, `color.ui=false`, `i18n.logOutputEncoding=utf-8` — [src-tauri/src/vcs.rs:21-41](../../../src-tauri/src/vcs.rs). 실행 · 오류 처리 `run` [vcs.rs:43-49](../../../src-tauri/src/vcs.rs). 사용자 전역 설정이 새지 않는지 시험 `user_git_config_does_not_leak_in` [vcs.rs:621-](../../../src-tauri/src/vcs.rs)
- 저장소는 `git init -q -b main`, `.gitignore` 는 `.claudeppt/` 하나 — [vcs.rs:59-74](../../../src-tauri/src/vcs.rs)
- 판 남기기 `commit_all` = `add -A` + `commit -q --allow-empty -m … [--author=<이름> <member@claudeppt>]` — [vcs.rs:146-166](../../../src-tauri/src/vcs.rs). 앱 · CLI 가 같은 색인을 쓰므로 판 남기기 잠금(`lock`, 최대 60초) — [vcs.rs:97-140](../../../src-tauri/src/vcs.rs), [vcs.rs:11-12](../../../src-tauri/src/vcs.rs)
- 판 목록은 `log --first-parent --format=%H%x09%h%x09%ci%x09%an%x09%s` + 태그 — [vcs.rs:173-212](../../../src-tauri/src/vcs.rs); 릴리즈는 태그 `r<k>` — [vcs.rs:214-216](../../../src-tauri/src/vcs.rs), [vcs.rs:4](../../../src-tauri/src/vcs.rs)
- 되돌리기는 이력을 지우지 않고 지난 판 파일을 덮어 새 판 (`checkout <hash> -- . :(exclude)releases :(exclude)source`) — [vcs.rs:223-248](../../../src-tauri/src/vcs.rs)
- **작업 사본**: 세션 키마다 앱 데이터 `work/<덱 지문>/<키>` 에 `worktree add --detach <base>`. 끝나지 않은 턴의 흔적은 지우기 전에 `cppt/hold/<키>x<시각>` 으로 남긴다 — [vcs.rs:254-300](../../../src-tauri/src/vcs.rs)
- **턴 얹기** `vcs_work_finish` → `land`: 덱에 남은 변경을 먼저 판으로, `cherry-pick <c>`; 같은 내용이면 skip, 겹치면 `--abort` 후 `cppt/hold/<턴>` 갈래로 남기고 겹친 파일 목록을 돌려준다 — [vcs.rs:340-388](../../../src-tauri/src/vcs.rs)
- 보류 목록 · 다시 얹기 · 「보류한 것으로 바꾸기」(파일째 덮기) · 버리기(`cppt/old/hold-…` 로 이름만 옮김) — [vcs.rs:405-455](../../../src-tauri/src/vcs.rs), 시험 `turns_in_copies_land_side_by_side` · `same_file_different_lines_merges` · `overlap_is_held_not_overwritten` · `unfinished_turn_is_kept_not_wiped` [vcs.rs:516-592](../../../src-tauri/src/vcs.rs)
- **가지**: 갈래 `cppt/sian/<id>` + 작업 폴더 앱 데이터 `sian/<덱 지문>/<id>`. 이름 · 만든 이는 `git config branch.<갈래>.description` · `cpptBy` — [src-tauri/src/branch.rs:1-21](../../../src-tauri/src/branch.rs), [branch.rs:32-44](../../../src-tauri/src/branch.rs), 만들기 · 열기 [branch.rs:132-180](../../../src-tauri/src/branch.rs)
- **합치기** `merge_into`: 잠금 → 남은 변경 판으로 → `merge --no-ff --no-edit -m … [-Xours|-Xtheirs] <other>`, 작성자는 `GIT_AUTHOR_NAME` 환경 변수. 겹치면 `merge --abort` 하고 겹친 파일을 돌려준다(줄기는 그대로) — [branch.rs:183-219](../../../src-tauri/src/branch.rs). 가지 넣기 `vcs_sian_merge` · 줄기 받기 `vcs_sian_update` — [branch.rs:221-241](../../../src-tauri/src/branch.rs)
- 변경 그래프: `refs/heads/cppt/` 와 태그를 모아 `log --topo-order` — [branch.rs:291-335](../../../src-tauri/src/branch.rs)
- **사본(fork)**: `clone -q --no-hardlinks` (윈도 `\\?\` 머리 떼기) — [branch.rs:338-357](../../../src-tauri/src/branch.rs). `vcs_fork_send`: 원본이 같은 PC 에 있으면 `push origin HEAD:refs/heads/cppt/sian/<id>` — [branch.rs:359-377](../../../src-tauri/src/branch.rs). `vcs_fork_fetch`(「사본에서 가져오기」): 폴더에서 `fetch -q --no-tags <폴더> HEAD:refs/heads/cppt/sian/<id>` 후 `merge-base` 가 없으면 버리고 거절 — [branch.rs:388-406](../../../src-tauri/src/branch.rs). 다른 PC 에서 받은 `.cppt` 를 푼 폴더도 이 길로 가지가 된다 — [branch.rs:12-13](../../../src-tauri/src/branch.rs), 시험 `fork_sends_back_as_sian_and_strangers_are_refused` [branch.rs:503-](../../../src-tauri/src/branch.rs)
- `.cppt` = 덱 폴더 통째 zip(`.git` 포함, `.claudeppt/run` 만 뺌) — [src-tauri/src/project.rs:1-4](../../../src-tauri/src/project.rs), `pack_deck` [project.rs:100-128](../../../src-tauri/src/project.rs); `unpack_deck` 은 `enclosed_name` 으로 경로를 막고 `deck.json` 이 있어야 받는다 — [project.rs:130-160](../../../src-tauri/src/project.rs)
- 저장소 안 어디에도 `git bundle` · `git notes` · `upload-pack` · `receive-pack` · 서명 검증 호출은 없다 (`vcs.rs` · `branch.rs` 의 git 인자 grep 결과: `clone` · `push` · `fetch` · `merge` · `cherry-pick` · `worktree` · `for-each-ref` · `config` · `tag` 뿐)

### Inferences
- **그대로 쓰는 것**: `git()`/`run()` 실행기, `lock`, `commit_all`, `merge_into`(겹침 알림 · 쪽 고르기), `land`/보류 갈래, 가지 이름 · 만든 이 메타(`branch.*.description`), `vcs_fork_fetch` 의 「이력 이어짐」 검사(`merge-base`), 그래프. 제안(PR) = 지금의 가지/보류 갈래를 그대로 쓰되 이름공간만 `refs/cppt/proposals/<작성자 열쇠>/<id>` 같은 꼴로 늘리면 된다.
- **바꿀 것**: (1) 줄기 `main` 은 지금 덱 폴더 작업 트리가 직접 쥔 갈래라 아무 판 남기기 · 되돌리기 · CLI(`cli.rs`)가 바로 전진시킨다 — 목표에서는 「서명된 승인으로만 전진」이므로 **로컬 편집은 줄기가 아니라 내 작업 갈래**에 쌓이고, 줄기는 검증된 커밋으로만 옮겨야 한다. 지금 덱 폴더 = 줄기 체크아웃이라는 전제(`main_branch()` = 덱 폴더 HEAD, [branch.rs:27-30](../../../src-tauri/src/branch.rs))가 가장 크게 흔들린다. (2) `merge_into` 의 합치기 커밋 작성자는 이름 문자열뿐 — 승인 기록은 별도로 서명해야 한다. (3) `commit.gpgsign=false` 강제는 유지해도 된다(아래 3절 — git 내장 서명을 안 쓰는 설계라면).
- `.cppt` 는 이미 「이력 포함 덱 한 파일」이라 오프라인 인계의 그릇으로 재사용 가능. 다만 지금은 서명 · 매니페스트가 없고 작업 트리 전체(아래 4절 — 수백 MB)를 담는다.

### Gaps
- `cli.rs`(760줄)가 판 남기기 · 되돌리기를 어떤 함수로 부르는지는 훑지 않았다 — 「줄기 직접 전진」 경로가 CLI 에도 있으리라 추정(vcs.rs:12 「CLI 는 같은 함수를 그대로 동기로 부른다」).

---

## 3. 서명을 어디에 붙일 수 있나 (git 호출 · 플래그 · 열쇠)

### Takeaway
git 내장 서명(gpg/ssh)은 일부러 꺼 두었고(`commit.gpgsign=false`, `log.showSignature=false`), 서명할 열쇠는 iroh `SecretKey`(ed25519) 하나가 앱마다 `p2p.key` 에 있다. **git 객체 밖 별도 ref(승인 기록)에 ed25519 서명을 두는 방식**이 지금 구조와 가장 덜 부딪친다.

### Cited Findings
- 전역 `-c commit.gpgsign=false` · `tag.gpgsign=false` · `log.showSignature=false` — [vcs.rs:29-36](../../../src-tauri/src/vcs.rs). `log.showSignature` 를 끈 까닭은 「git log 출력에 줄을 끼워 판 목록 읽기를 깬다」 — [vcs.rs:31-34](../../../src-tauri/src/vcs.rs)
- 판 목록 파서는 탭 구분 한 줄 꼴에 기대고 있다 — [vcs.rs:188](../../../src-tauri/src/vcs.rs), [branch.rs:314](../../../src-tauri/src/branch.rs)
- 열쇠: iroh `SecretKey` 를 32바이트로 DPAPI 보관, 엔드포인트 `secret_key(secret())` — [p2p.rs:50-62](../../../src-tauri/src/p2p.rs), [p2p.rs:70](../../../src-tauri/src/p2p.rs). 공개 열쇠 = `EndpointId`(z32 52자), 링크 꼴 `claudeppt://<열쇠>/j/<링크 열쇠>` — [p2p.rs:3-4](../../../src-tauri/src/p2p.rs), [p2p.rs:125-143](../../../src-tauri/src/p2p.rs), [p2p.rs:168](../../../src-tauri/src/p2p.rs)
- DPAPI 는 「이 PC 의 이 사용자만 푼다」 — [runner.rs:6](../../../src-tauri/src/runner.rs)

### Inferences
- 선택지 비교 (코드 기준 판단):
  - **커밋 트레일러**(`Signed-off-by` 류): 서명은 커밋 해시에 걸려야 하는데 트레일러는 그 커밋 안에 있어 자기 해시를 서명할 수 없다. 승인자는 작성자와 다르고 승인은 커밋 뒤에 생기므로 맞지 않는다.
  - **git 내장 ssh 서명**(`gpg.format=ssh`): ed25519 ssh 열쇠를 쓸 수 있으나 열쇠를 파일/에이전트로 git 에 내놓아야 하고(DPAPI 보관과 충돌), 승인자 ≠ 커미터 문제는 같다. 지금 `-c` 로 끈 설정을 다시 켜야 하고 `showSignature` 파싱 문제도 되살아난다.
  - **git notes**(`refs/notes/cppt-approve`): 커밋에 붙는 메모라 승인 여러 개를 달 수 있다. 다만 notes ref 자체가 덮어쓰기 · 병합(notes merge)이 까다롭고, 줄기 전진 기록의 「순서」를 담기 어렵다.
  - **별도 ref 의 서명 기록 체인**(권장 후보): 예 `refs/cppt/trunk-log` 갈래에 「줄기 n번째 = 커밋 X, 앞 = W, 승인자 열쇠 K, 서명 S, 시각」 같은 작은 파일을 쌓는다. 앞 기록 해시를 묶어 되감기 · 끼워 넣기를 검증하고, 줄기 `main` 은 이 기록의 마지막 X 를 가리키는 결과로만 옮긴다. 서명 대상은 `(덱 id · 커밋 해시 · 트리 해시 · 앞 줄기 커밋 · 승인 명부 판)` 정도.
- iroh `SecretKey` 에 서명 함수가 있으면 새 열쇠 관리 없이 쓸 수 있다(iroh-base 의 `SecretKey::sign` / `PublicKey::verify` — 아래 Gaps). 없으면 같은 32바이트를 `ed25519-dalek` 로 읽어 쓴다.
- 열쇠가 **기기 · 앱 설치 단위**라는 점이 신원 모델을 바꾼다: 한 사람이 PC 두 대면 열쇠가 둘, PC 를 바꾸거나 DPAPI 가 깨지면(프로필 재설치) 승인 권한을 잃는다. 지금 `invite.rs` 는 「같은 이름이면 권한을 잇는다」로 이 문제를 피했지만([invite.rs:151-160](../../../src-tauri/src/invite.rs)), 서명 신원에서는 이름이 아무것도 보증하지 못한다.

### Gaps
- iroh 1.5 의 `SecretKey` 가 공개 `sign()`/`PublicKey::verify()` 를 내놓는지 저장소 안에서는 확인하지 못했다(코드는 `secret_key()` · `from_z32` 만 쓴다). `~/.cargo/registry` 의 iroh-base 소스로 확인 필요.

---

## 4. 덱 파일 꼴 · 합치기 단위 · 실제 크기

### Takeaway
덱은 **쪽마다 HTML 한 파일 + 목차 `deck.json` 하나**라 쪽 단위 3방향 합치기가 git 그대로 잘 된다. 걸림돌은 (1) 쪽 순서 · 제목이 모두 든 `deck.json` 이 모든 쪽 추가 · 이동 · 저장에서 바뀌는 단일 핫스팟(`updated` 시각까지), (2) 가져온 PPTX 덱은 `source/`(원본 쪽 그림) · `assets/` 가 판에 들어가 `.git` 만 200MB 대라는 점이다.

### Cited Findings
- 파일 꼴 `claudeppt/1`: `deck.json`(제목 · 크기 · **쪽 순서의 유일한 정본**) · `theme.css`(공통 서식) · `slides/<id>.html`(한 쪽 한 파일, `<section class="slide">` 1280×720) · `assets/` · `source/`(original.pptx · pages/<n>.png) · `releases/` · `.claudeppt/`(판에 안 넣음: pins.json · talk.json · run/) · `.git/`. 쪽 id = 파일 이름이라 순서를 바꿔도 파일 이름이 안 바뀐다 — [src/lib/deck.ts:1-15](../../../src/lib/deck.ts)
- `Deck` 인터페이스: `slides: SlideRef[{id,file,title?,notes?,hidden?}]`, `theme`, `template?`, `page?.margin`, `created`, `updated` — [deck.ts:21-37](../../../src/lib/deck.ts). **저장할 때마다 `deck.updated = new Date().toISOString()`** — [deck.ts:69](../../../src/lib/deck.ts)
- 쪽 여백은 `theme.css` 안 표시 구획(`/* @page start … @page end */`)에 쓴다 — [deck.ts:43-60](../../../src/lib/deck.ts)
- 직접 편집은 요소 단위 연산(`edit` · `patch` · `remove` · `append` · `after` · `order`)을 「자식 번호 길」로 찾아 **원본 HTML 파일에 되쓴다** — [src/lib/edits.ts:1-12](../../../src/lib/edits.ts)
- 핀 · 담당 · 대화는 `.claudeppt/pins.json` · `.claudeppt/assign.json` · `.claudeppt/talk.json` (판 밖) — [src/lib/store.ts:6-11](../../../src/lib/store.ts), [store.ts:366-377](../../../src/lib/store.ts), [store.ts:835-837](../../../src/lib/store.ts), [store.ts:1025-1030](../../../src/lib/store.ts); `.gitignore` = `.claudeppt/` — [vcs.rs:59-61](../../../src-tauri/src/vcs.rs)
- 시험이 보는 git 합치기 단위: 「같은 파일 다른 줄은 합쳐진다」(`same_file_different_lines_merges`) · 「겹치면 보류」 — [vcs.rs:537-575](../../../src-tauri/src/vcs.rs); 가지가 겹치면 줄기 그대로 — [branch.rs:474-500](../../../src-tauri/src/branch.rs)
- **실측 (이 PC 의 앱 덱 9개, 2026-11-27 `du`)**: 새로 만든 덱 1~2쪽 = 전체 약 4MB(`.git` 약 2MB, 거의 `assets/` 글꼴 2MB). 가져온 PPTX 덱 26쪽 = 전체 116MB · `.git` 58MB · `source/` 52MB · `assets/` 6.1MB · `slides/` 0.9MB. 가져온 PPTX 덱 58~59쪽 = 전체 448~604MB · `.git` 222~223MB · `source/` 148MB · `assets/` 78MB · `slides/` 1.8~2.2MB. 커밋 수는 1~6개. (저장소 안에는 시험용 견본 덱이 없다 — 시험은 임시 폴더에 만든다, [branch.rs:412-420](../../../src-tauri/src/branch.rs))

### Inferences
- **합치기 단위**: 쪽 파일 단위는 지금 git 그대로 충분. 한 쪽 안 요소 단위 합치기는 HTML 줄 diff 에 기대므로 같은 쪽을 둘이 고치면 겹침 → 보류가 흔할 것이다(가져온 PPTX 쪽은 한 요소가 긴 한 줄일 가능성이 높음 — 추정).
- `deck.json` 은 두 사람이 쪽을 하나씩 더하기만 해도 `slides` 배열 같은 자리 · `updated` 줄에서 겹친다. 목표 설계 전에 (a) `updated` 를 판에서 빼거나(git 커밋 시각으로 대신) (b) `deck.json` 전용 합치기(쪽 id 집합 · 순서 3방향 합치기, git merge driver 또는 앱 안 합치기)를 두어야 승인 관문이 「겹침」으로 막히지 않는다.
- 전체 사본 모델에서 첫 동기화 비용은 `.git` 크기(가져온 59쪽 덱 약 222MB) + 작업 트리 체크아웃이다. n0 공용 중계(속도 제한, [p2p.rs:6](../../../src-tauri/src/p2p.rs))를 거치면 분 단위 이상 걸릴 수 있다. 오프라인 `.cppt` 도 지금 꼴(작업 트리 + `.git`)이면 같은 덱이 약 450MB 다 — `.git` 만(또는 `git bundle`) 담으면 절반으로 준다.
- `source/pages/*.png` 는 대조용 원본 그림이라 줄기에 둘 필요가 낮다. 판 밖(LFS 류 · 지연 받기)으로 빼면 사본 크기가 크게 준다(설계 판단 — 코드 근거는 `vcs_restore` 가 `source` 를 되돌리기에서 빼는 것 [vcs.rs:233](../../../src-tauri/src/vcs.rs)).

### Gaps
- 가져온 쪽 HTML 의 줄 구조(한 요소 = 한 줄인지)는 열어 보지 않았다. 요소 단위 합치기 품질 추정은 확인 필요.

---

## 5. 무엇이 깨지나 — 기능별 영향

### Takeaway
목표 설계는 「덱 주인 서버가 보낼 것을 고른다」는 지금의 비밀 유지 모델과 맞지 않는다. **전체 사본을 주는 순간 「담당 쪽만 보이기」는 지킬 수 없다.** 브라우저 팀원 · 공유 Claude 세션 · 핀 · 담당표는 지금 모두 덱 주인 store/파일에 사는 상태라, 사본으로 옮기려면 새 자리가 필요하다.

### Cited Findings
- 「담당 쪽만 보이기」는 「화면에서 감추는 것이 아니라 덱 주인 서버가 보내지 않는다」가 설계 원칙 — [README.md:176-182](../../../README.md), [collab.rs:29-30](../../../src-tauri/src/collab.rs). 남의 쪽 · `deck.json` · 판 기록 · 지난 커밋 주소까지 막는다 — [collab.rs:409-432](../../../src-tauri/src/collab.rs), [collab.rs:1043-1048](../../../src-tauri/src/collab.rs), rpc `log` 은 빈 배열 [collab.rs:1113-1118](../../../src-tauri/src/collab.rs)
- 공유 덱 창에는 명령 권한이 없다: `capabilities/default.json` 의 `windows: ["main"]` 에만 `app-commands` — [src-tauri/capabilities/default.json](../../../src-tauri/capabilities/default.json); 그 묶음은 `build.rs` 가 `generate_handler!` 목록으로 만든다(외부 화면이 창 주소를 앱 주소로 바꿔 명령을 부르는 길을 막으려고) — [src-tauri/build.rs:1-30](../../../src-tauri/build.rs), [README.md:171](../../../README.md)
- 「내 Claude」는 덱 주인 창이 아니라 처음 화면에서 사람이 켠다 — 공유 덱 창은 켜지 못한다(권한 없음) — [runner.rs:16-17](../../../src-tauri/src/runner.rs)
- 브라우저 팀원은 자기 Claude 가 없어 덱 주인 Claude · 덱 주인 묶음을 쓴다 — [collab.ts:296-299](../../../src/lib/collab.ts)
- 핀 · 담당은 `.claudeppt/*.json`(판 밖)이고 원격은 의도(`pinAdd` 등)로만 고친다 — [store.ts:6-7](../../../src/lib/store.ts), [collab.ts:401](../../../src/lib/collab.ts), 담당표는 덱 주인만 고치고 팀원은 보기만 — [README.md:175](../../../README.md)
- 권한 네 단계 · 「같은 이름이면 함께 바뀜」 — [invite.rs:61-80](../../../src-tauri/src/invite.rs), [README.md:172](../../../README.md)

### Inferences
| 기능 | 목표 설계에서 | 판단 |
|---|---|---|
| 브라우저 팀원 (`collab_lan` · 터널) | 브라우저는 git 사본을 못 쥔다 | **지금 호스트 모드를 「읽기 · 의견 창구」로 남기거나 버린다.** 남기면 어느 사본(온라인인 누구든)이 서버가 될지 정해야 하고, 그 서버의 쓰기는 「제안」으로 들어가야 한다 |
| 담당 쪽만 보이기 (`limit_view` · `Allow` · `member_key`) | 전체 사본 = 모든 쪽 · 전체 이력 | **지킬 수 없다.** 대안은 (a) 이 기능을 「보기 제한 없음」으로 접는다, (b) 제한 대상자에게는 사본을 주지 않고 지금 호스트 모드로만 들인다, (c) 쪽별 암호화(이력까지) — 비용 큼. 「편집 범위 제한」(scopeFor)은 승인 관문 검증으로 옮길 수 있다: 제안의 바뀐 파일이 그 사람 담당 쪽 밖이면 자동 거절 |
| 팀원 창 권한 없음 (capabilities) | 각자 자기 main 창에서 자기 사본을 연다 | 오히려 단순해진다 — 공유 덱 창(외부 URL 웹뷰)이 필요 없다. 보안 경계는 「남의 화면」이 아니라 「남이 보낸 git 객체 · 파일」로 옮겨 간다(받은 슬라이드 HTML 의 스크립트는 지금도 sandbox iframe · CSP 로 돈다) |
| 공유 Claude 세션 (`claudeFor` · `pool_of` · runner.rs) | Claude 는 각자 자기 사본에서 돈다 | `runner.rs` 전체(773줄)와 collab.rs 「팀원 PC 의 Claude」 구획(약 1262-1630행)이 필요 없어진다. 세션 공유(남의 Claude 로 돌리기)는 사라지거나 「대화 기록을 제안에 첨부」 꼴로 바뀐다. `talk.json` 은 사람마다 로컬 |
| 핀 · 의견 | `.claudeppt/pins.json` 은 판 밖이라 사본 사이에 안 간다 | 핀을 별도 ref(예 `refs/cppt/pins`, 줄기와 따로 · 승인 없이 서명만)나 제안 메타에 두어야 한다. 의견은 승인 대상이 아니므로 줄기와 다른 규칙(누구나 서명해 덧붙이기)이 맞다 |
| 담당표 (`assign.json`) | 판 밖 | 권한 명부와 함께 **서명된 명부 ref** 로 옮긴다 — 담당이 승인 검증 입력이 되기 때문 |
| 권한 (`Role`) · 장부 (`Book`) | 쿠키 · 이름 기반 | 공개 열쇠 기반 명부로 다시 짠다: 덱 만든 이(창세 열쇠)가 서명한 「열쇠 → 이름 · 권한(승인 가능/편집/의견/보기) · 담당」 목록, 명부 변경도 승인자 서명. 초대 링크는 「명부에 열쇠를 넣어 달라는 요청」으로 바뀐다 |
| 판 · 릴리즈 · 보류 · 가지 | 로컬 git 그대로 | 대부분 그대로. 단 「되돌리기」 · 「릴리즈 태그」가 줄기를 바로 바꾸는 동작이라 승인 대상으로 바뀐다 |

### Gaps
- `Collab.tsx` · `History.tsx` 의 화면 흐름(초대 · 들어온 사람 · 그래프)은 줄 단위로 읽지 않았다 — UI 변경량은 추정치다.

---

## 6. 새로 만들 것 · 위험 · 작업량 · 다시 쓸 시험

### Takeaway
재사용 비율은 판 관리(vcs.rs · branch.rs)에서 높고, 협업 서버 · 러너 · 화면 원격 계층에서는 낮다. 새로 만들 핵심은 **(1) iroh 위 git 전송, (2) 서명 승인 기록과 검증, (3) 열쇠 기반 명부, (4) `deck.json` 합치기, (5) 서명된 `.cppt`** 다. 대략 새 코드 2,000~3,000줄 · 고치거나 걷어 낼 코드 3,000줄 안팎으로 본다(추정).

### Cited Findings
- 시험 위치 · 수 (`#[test]`/`#[tokio::test]` 세기): collab.rs 13 · invite.rs 9 · vcs.rs 8 · runner.rs 5 · claude.rs 5 · p2p.rs 3 · branch.rs 3 · tunnel.rs 3 · fonts/lib/metafile 각 1 (grep 결과). 화면 시험: `route.test.ts`(세션 묶음 5개) · `graph.test.ts`(그래프 줄) · `pin.test.ts` · `page.test.ts` — [src/lib/route.test.ts:1-45](../../../src/lib/route.test.ts), [src/lib/graph.test.ts:1-8](../../../src/lib/graph.test.ts)
- collab.rs 시험 이름: `token_compare_is_exact` · `reads_cookie` · `origin_must_match_host` · `etag_follows_content` · `runner_reads_and_writes_only_deck_files` · `fills_deck_marks_in_json_lines` · `transcript_tail_joins_only_onto_the_same_start` · `join_keeps_the_path_after_the_host` · `only_listed_intents_pass` · `each_pool_gets_only_its_own_talk` · `limited_viewer_gets_only_their_slides` · `away_empties_the_deck_and_talk` · `books_are_per_deck` — [collab.rs:1636-1807](../../../src-tauri/src/collab.rs)
- invite.rs 시험: `public_link_asks_name_personal_link_fixes_it` · `expired_unknown_and_locked_links_are_refused` · `kicked_device_cannot_come_back_with_its_cookie` · `saves_and_loads` · `same_name_on_public_link_gets_a_number` · `runner_key_replaces_and_dies_with_device` · `limit_follows_the_person` · `roles_follow_the_person_and_gate_intents` · `names_are_cleaned` — [invite.rs:242-375](../../../src-tauri/src/invite.rs)
- runner.rs 시험: `only_claude_writes_go_back` · `transcript_goes_back_as_tail_when_it_continues` · `mirror_follows_the_host_and_keeps_unsent_writes` · `dpapi_round_trip` · `mirror_paths_stay_inside` — [runner.rs:632-770](../../../src-tauri/src/runner.rs)
- 파일 크기: collab.rs 1807 · runner.rs 773 · cli.rs 760 · collab.ts 666 · vcs.rs 648 · claude.rs 566 · branch.rs 529 · invite.rs 375 · p2p.rs 303 · project.rs 207 (`wc -l`)

### Inferences
**영역별 작업량 (대략, 추정)**

| 영역 | 재사용 | 바꿀 것 | 새로 만들 것 | 대략 줄 수 |
|---|---|---|---|---|
| p2p.rs | 열쇠 보관(`secret()`), 엔드포인트, `pipe` | ALPN 하나 → 둘(`claudeppt/git/1` 더함), `serve` 가 ALPN 으로 갈래 | git 전송: iroh 흐름 위에 `git upload-pack`/`receive-pack` 를 잇거나(지금 `pipe` 와 같은 꼴), 「가진 ref 광고 → 없는 것 `git bundle`」 교환. 어느 온라인 사본이든 줄기를 내주는 「전달」 | 바꿈 50 · 새 300~500 |
| 서명 · 검증 (새 모듈) | iroh 열쇠 | — | 승인 기록 꼴 · 서명 · 체인 검증 · fetch 뒤 검증 훅(검증 실패 ref 는 받지 않음) · 줄기 fast-forward 만 | 새 400~600 |
| 명부 (invite.rs 대체) | `clean_name`, 시험 일부 | `Book/Device/Role` → 열쇠 명부. 쿠키 · 링크 열쇠 · runner 열쇠는 호스트 모드에만 | 창세 열쇠, 명부 변경 서명, 철회, 한 사람 여러 열쇠 | 바꿈 200 · 새 300 |
| vcs.rs · branch.rs | 거의 전부(`merge_into` · `land` · 보류 · 가지 · fork/fetch · 그래프) | 덱 폴더 = 줄기 체크아웃 전제 → 내 작업 갈래 체크아웃, 줄기 전진은 승인 경로만. 그래프에 제안 · 승인 표시 | 제안 ref 이름공간 · 제안 목록 · 「승인해 넣기」 · `deck.json` 합치기 | 바꿈 200~300 · 새 300~400 |
| project.rs `.cppt` | zip 읽고 쓰기, `enclosed_name` 검사 | 담을 것(작업 트리 대신 `.git` 또는 bundle + 명부 · 승인 기록) | 서명 매니페스트, 받는 쪽 검증 → `vcs_fork_fetch` 길로 가지/제안 들이기 | 바꿈 80 · 새 150 |
| collab.rs | `deck()` 슬라이드 내주기 · `auth` 는 브라우저 모드 남길 때만 | 앱 팀원 경로 대부분 걷기(`publish` · `view` · `limit_view` · `pool_view` · 의도 · runner 구획) | 사본 사이 「새 줄기 · 새 제안 · 핀」 알림(가벼운 gossip) | 걷거나 바꿈 800~1,200 |
| runner.rs | DPAPI 도우미(`dpapi`)는 p2p 가 쓴다 | 파일 거울 · 원격 턴 전부 불필요 | — | 걷기 ~700 |
| collab.ts · transport.ts · join.ts | `Role` 타입, 초대 붙여 넣기 UX | `remote` 분기 · `remoteActions` · `claudeFor` · `handleIntent` 대부분, `join` = 사본 받기로 | 제안 보내기 · 승인 · 줄기 받기 상태 | 바꿈 500~700 |
| 화면(tsx) | 그래프(History) · 가지 화면 | Collab.tsx(초대 · 들어온 사람 → 명부 · 열쇠), 원격 분기 | 제안 목록 · 승인 단추 · 서명 상태 표시 | 바꿈 · 새 400~800 |

**다시 써야 할 시험**
- 걷히거나 뜻이 바뀌는 것: collab.rs 의 `runner_reads_and_writes_only_deck_files` · `fills_deck_marks_in_json_lines` · `transcript_tail_joins_only_onto_the_same_start` · `only_listed_intents_pass` · `each_pool_gets_only_its_own_talk` · `limited_viewer_gets_only_their_slides` · `away_empties_the_deck_and_talk` · `books_are_per_deck`; invite.rs 9개 전부(쿠키 · 이름 승계 → 열쇠 명부); runner.rs 5개(`dpapi_round_trip` 만 남김); `route.test.ts`(세션 묶음 — 세션 공유가 사라지면).
- 남는 것: vcs.rs 8개 · branch.rs 3개(전제가 「덱 폴더 = 줄기」인 `sian_is_a_deck_that_merges_back` 은 고쳐야 함), p2p.rs `pipes_a_tcp_connection_through_iroh`(git 전송 시험의 틀로 재사용), collab.rs 의 `token_compare_is_exact` · `reads_cookie` · `origin_must_match_host` · `etag_follows_content`(브라우저 모드를 남길 때).
- 새로 필요한 것: 서명 위조 · 승인 권한 없는 열쇠 · 줄기 되감기(non-fast-forward) · 승인 기록 재생(replay) · 명부 철회 뒤 서명 · `.cppt` 변조 · 이력 안 이어진 사본 · `deck.json` 동시 쪽 추가 합치기.

**구체적 위험**
1. **비밀 유지 후퇴**: 전체 사본은 모든 쪽 · 전 이력 · 지난 커밋을 준다. 「담당 쪽만 보이기」를 쓰는 사용자에게는 기능 후퇴다([README.md:176-182](../../../README.md)). 한 번 받은 사본은 회수할 수 없다 — 내보내기(kick)가 「연결 끊기」에서 「앞으로의 줄기만 안 줌」으로 약해진다.
2. **신원 = 기기 열쇠**: DPAPI 로 싼 앱 열쇠라 PC 교체 · 윈도 프로필 재설치에서 승인자가 사라진다. 명부에 승인자가 한 명뿐이면 덱이 영영 줄기를 못 옮긴다 — 다중 승인자 · 열쇠 회복(복구 코드) 설계 필요.
3. **줄기를 바로 옮기는 기존 경로**: 판 남기기(`commit_all`) · 되돌리기 · 보류 「바꾸기」 · 가지 넣기 · 바깥 CLI 가 모두 덱 폴더의 `main` 을 바로 전진시킨다([vcs.rs:91-95](../../../src-tauri/src/vcs.rs), [vcs.rs:223-248](../../../src-tauri/src/vcs.rs), [vcs.rs:427-446](../../../src-tauri/src/vcs.rs), [branch.rs:221-232](../../../src-tauri/src/branch.rs)). 하나라도 남으면 검증 안 된 줄기가 생기고, 그 사본이 「전달」하면 남들이 거절해 갈라진다. 받는 쪽 검증이 최종 방어선이어야 한다.
4. **`deck.json` 겹침**: 모든 쪽 추가 · 이동 · 저장이 같은 파일 · `updated` 줄을 고친다([deck.ts:69](../../../src/lib/deck.ts)) — 승인 대기 제안끼리 거의 늘 겹친다.
5. **크기 · 중계**: 가져온 PPTX 덱 `.git` 약 222MB, 작업 트리 포함 약 450MB(실측). n0 공용 중계는 시험용 · 속도 제한([p2p.rs:5-6](../../../src-tauri/src/p2p.rs)). 첫 사본 받기 · 오프라인 `.cppt` 가 무겁다.
6. **git 전송 공격면**: 남의 사본에서 받은 pack 을 내 저장소에 넣는다. 지금은 `fetch` 를 같은 PC 폴더에서만 한다([branch.rs:398](../../../src-tauri/src/branch.rs)). 원격 pack 에는 크기 한도 · ref 이름 검사(`plain()` [vcs.rs:250-252](../../../src-tauri/src/vcs.rs) 재사용) · 검증 전 격리 ref(quarantine)가 필요하다. 훅은 이미 꺼져 있다([vcs.rs:34](../../../src-tauri/src/vcs.rs)) — 이 설정은 반드시 유지.
7. **받은 슬라이드 스크립트**: 지금 원격 화면은 덱 주인이 내준 것을 sandbox iframe 으로 본다. 목표에서는 남이 쓴 쪽 HTML 이 **내 main 창(명령 권한 있음)** 에서 열린다. 지금도 main 창은 `deck://` 로 슬라이드를 열지만 그 내용은 내가(내 Claude 가) 쓴 것이었다 — 남이 쓴 HTML 을 같은 경로로 여는 것이 안전한지 `deck://` 의 sandbox · CSP 를 다시 확인해야 한다(collab.rs:5-8 은 원격 경로의 sandbox 만 말한다).
8. **승인 경쟁**: 두 승인자가 같은 줄기 위에서 서로 다른 제안을 동시에 승인하면 줄기가 둘이 된다 — 「앞 줄기 커밋」을 서명에 묶고 늦게 온 쪽은 다시 얹어(rebase/merge) 재승인해야 한다. 늘 켜진 서버가 없으므로 순서를 정해 줄 곳이 없다.
9. **시각 · 철회 순서**: 명부에서 빠진 승인자의 옛 서명은 유효한가? 오프라인 `.cppt` 는 철회 소식을 못 받을 수 있다. 서명에 명부 판(번호 · 해시)을 묶어 「그 판 명부 기준으로 유효」로 정해야 한다.

### Gaps
- `deck://` 프로토콜의 sandbox · CSP 처리(`crate::serve`, lib.rs)를 읽지 않았다 — 위험 7 확인 필요.
- iroh 위에서 `git upload-pack` 을 stdin/stdout 으로 잇는 방식과 `git bundle` 교환 중 어느 쪽이 Windows 에서 덜 아픈지(git for Windows 의 파이프 · 경로 문제)는 코드로 판단할 수 없다.
- cli.rs · claude.rs 의 줄기 직접 쓰기 경로 전수는 세지 않았다.
