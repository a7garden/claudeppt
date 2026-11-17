# ClaudePPT

Claude 와 대화하며 발표 자료를 웹(HTML)으로 짓고, 다 되면 편집 가능한 PPTX 로 내보내는 데스크톱 앱.
Claude Code CLI 를 헤드리스로 돌려 프로젝트 폴더의 HTML 을 고치게 하고, 앱은 폴더를 감시해 고친 쪽을 바로 다시 그린다(핫 리로드).

Tauri 2 · React 19 · Vite · TypeScript. 화면 서식은 토큰 CSS 한 장(`src/styles/app.css`)이고 컴포넌트 라이브러리를 쓰지 않는다.

## 쓰는 법

| 하고 싶은 것 | 길 |
| - | - |
| 새로 만들기 | 처음 화면의 「주제」에 한 줄을 쓰고 Enter — 빈 덱을 만들고 그 글로 첫 턴을 보낸다. 비워 두고 누르면 표지 한 장만 |
| PPTX 가져오기 | 「PPTX 가져오기」(Ctrl+O) 또는 창에 끌어 놓기. 원본과 같은 모양의 HTML 로 옮기고, PowerPoint 가 있으면 원본 쪽 그림(`source/pages`)도 뽑는다 |
| 고치기 | 오른쪽 대화칸에 쓰고 Enter. 붙여 넣은 그림은 첨부로 간다 |
| 핀 | 제목 줄 「핀」(P) → 슬라이드를 눌러 의견을 단다. 여러 쪽에 찍은 핀이 요청칸 위에 쌓이고 보내기 한 번에 함께 간다 |
| 직접 편집 | 「편집」(E) → 글자를 두 번 눌러 고치기 · 절대 위치 요소 끌어 옮기기 · 방향키 1px(Shift 10px) · Delete 로 지우기. 원본 HTML 에 되쓰고 잠잠해지면 한 판으로 남긴다 |
| 판 | 무대 아래 판 줄기 — 판마다 눈금, 릴리즈는 긴 눈금. 누르면 그 판을 제자리에서 보고 「이 판으로 되돌리기」 |
| 릴리즈 | 제목 줄 「릴리즈」 — 이름 · 메모를 적고 확정하면 `releases/r<k>-v<n>.pptx` 를 만들고 git 태그 `r<k>` 를 단다 |
| 내보내기 | 「내보내기」(Ctrl+E) — PPTX · CPPT 묶음(폴더째 zip) · 폴더 열기 |

쪽 목록: 끌어서 순서 바꾸기 · Delete 로 빼기 · 끝의 + 로 빈 쪽. 무대: ↑↓ · PageUp/Down 으로 쪽 넘기기.

## 프로젝트 파일 꼴 (`claudeppt/1`)

```
<프로젝트 폴더>/
  deck.json            목차 — 제목 · 크기 · 쪽 순서 (쪽 순서의 유일한 정본)
  theme.css            모든 쪽이 함께 쓰는 서식 (색 · 글꼴 변수 · .slide 틀)
  slides/<id>.html     한 쪽에 한 파일, <section class="slide"> 하나 (기본 1280×720)
  assets/              그림 · 글꼴 (gen-*.png 는 그림 생성 도구가 만든 것)
  source/              가져온 원본 — original.pptx · pages/<n>.png
  releases/            r<k>-v<n>.pptx · releases.json
  .claudeppt/          앱 상태 (핀 · 대화 · 임시) — 판에 넣지 않는다
  .git/                판 이력 — v<n> = 커밋 수, 릴리즈 = 태그 r<k>
```

서재(기본 `문서\ClaudePPT`) 아래에 프로젝트 폴더가 쌓인다. 한 파일로 주고받을 때는 `.cppt`(폴더째 zip, 판 이력 포함)를 쓴다.
판 관리에 git 이 필요하다 — 사용자의 git 설정(이름 · 줄끝)과 무관하게 앱이 매번 값을 준다.

## Claude 격리

이 앱의 Claude 는 사용자의 다른 Claude 설정에 영향을 받지 않는다. 인자는 `src-tauri/src/claude.rs` 에 고정돼 있어 화면에서 바꿀 수 없다.

- `--safe-mode` — CLAUDE.md · 스킬 · 플러그인 · 훅 · MCP · 출력 스타일을 끈다
- `--setting-sources ""` — 사용자 · 프로젝트 settings.json 도 읽지 않는다 (`--safe-mode` 만으로는 응답 언어 설정이 남았다)
- `--system-prompt-file` — 기본 시스템 프롬프트 대신 이 앱의 프롬프트(`src/lib/prompt.ts`). 「설정 › Claude › 프롬프트」에서 갈아 끼우고, 「추가 지침」은 끝에 붙는다
- `--tools Read,Edit,Write,Glob,Grep` — 셸 · 웹 없음. `--permission-prompts none` — 물을 일이 생기면 기다리지 않고 거절
- 구독 로그인은 그대로 쓴다. 대화는 `--resume` 으로 프로젝트마다 한 세션을 잇는다

## 그림 · 도형 설정

- 그림 공급자: **SVG**(기본 — Claude 가 직접 그린다) · Codex CLI · Gemini CLI(자동 감지) · OpenAI API · Gemini API(키 등록).
  SVG 가 아니면 Claude 는 `<img data-gen="…">` 자리만 두고, 턴이 끝난 뒤 앱이 공급자로 그림을 만들어 `assets/` 에 넣는다.
  CLI 두 가지는 그 도구가 파일을 정한 자리에 썼는지로 판단한다 — Gemini CLI 는 그림 확장(예: nanobanana)이 있어야 한다.
- 도형: 글꼴 · 글자색 · 바탕색 · 강조색 · 모서리 · 선 굵기 · 그림자 · 아이콘(선/면). 견본이 바로 따라 바뀌고, 다음 턴의 프롬프트에 실린다.
  「theme.css ← 덱」은 열린 덱의 색 · 글꼴 변수만 바꾼다.

## PPTX 내보내기가 옮기는 것

쪽마다 화면 밖 iframe 에 1:1 로 그려 런타임(`src-tauri/runtime/rt.js`)이 잰 좌표로 만든다 — 웹과 PPT 가 따로 놀지 않게 PPT 쪽에서 배치를 다시 계산하지 않는다.

| 웹 | PPTX |
| - | - |
| 바탕색 · 테두리 · 둥근 모서리가 있는 요소 | 도형 (편집 가능) |
| 안쪽이 인라인뿐인 글자 묶음 | 글상자 (조각마다 크기 · 굵기 · 색 · 글꼴) |
| `<table>` | 표 |
| `<img>` · 인라인 `<svg>` · 배경 그림 | 그림 (PNG 2배) |
| `::before/::after` · 그림자 · 변형(회전) · 필터 | 옮기지 않는다 · 그라데이션은 첫 색 |

글자 너비는 PowerPoint 가 조금 넓게 그려 글상자를 4% 넓힌다. 받는 PC 에 글꼴이 없으면 다른 글꼴로 보인다.

## PPTX 가져오기가 옮기는 것

마스터 → 레이아웃 → 쪽 순서로 그리고, 자리 표시자는 위치 · 글자 서식을 위에서 물려받는다. 테마 색(lumMod · tint · shade) · 그룹 좌표 · 표 · 그림 자르기 · 연결선 화살표 · 글머리 · 쪽 번호 필드를 옮긴다.
차트 · SmartArt · EMF 그림 · 자유형 도형은 자리만 점선으로 남기고 알림에 적는다 — 원본 쪽 그림을 보고 Claude 에게 「원본과 같게」 다듬기를 맡긴다.

## 개발

```
npm install
npm run tauri dev       # 개발 실행
npm run tauri build     # 설치 파일 (src-tauri/target/release/bundle/nsis)
npx tsc --noEmit        # 화면 타입 검사
cd src-tauri && cargo check
```

- 화면을 자동으로 시험하려면 WebView2 원격 디버깅을 켜고 띄운 뒤 `tools/cdp.mjs` 로 JS 를 돌리거나 화면을 찍는다.
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 npm run tauri dev` → `node tools/cdp.mjs eval "<js>"` · `node tools/cdp.mjs shot out.png` (`@파일` 로 스크립트 파일).
  개발 실행에서는 `window.__app` 에 상태 저장소(deck · settings) · 흐름(flows) · api 가 걸린다.

### 릴리즈 · 자동 업데이트

- `package.json` · `src-tauri/Cargo.toml` · `src-tauri/tauri.conf.json` 의 버전과 `CHANGELOG.md` 구획을 함께 올리고 커밋한 뒤 `git tag v<버전> && git push origin v<버전>`.
  `.github/workflows/release.yml` 이 설치 파일 · 서명 · `latest.json` 을 GitHub 릴리즈에 올린다.
- 설치된 앱은 켤 때와 1시간마다 `releases/latest/download/latest.json` 을 보고 새 판이면 알림의 「설치」로 받아 다시 켠다. 「설정 › 업데이트」에서 끄고 켠다. 개발 실행에서는 확인하지 않는다.
- 업데이트 주소는 `tauri.conf.json` 의 `plugins.updater.endpoints` (지금 `a7garden/claudeppt` — 저장소를 만들면 맞춘다).
- 서명 키는 `~/.tauri/claudeppt.key`(비밀번호 없음). 저장소 비밀 `TAURI_SIGNING_PRIVATE_KEY` 에 같은 내용을 넣는다.
  **키를 잃으면 이미 깔린 앱은 더는 업데이트를 받지 못한다** — 공개 키가 앱 안에 박혀 있다.

### 구조

| 자리 | 하는 일 |
| - | - |
| `src-tauri/src/lib.rs` | 명령 등록 · `deck://` 프로토콜 (슬라이드에 런타임을 끼워 내준다, `<id>@<커밋>` 이면 그 판의 파일) |
| `src-tauri/src/claude.rs` | claude 헤드리스 실행 · 격리 인자 · stream-json 을 사건으로 |
| `src-tauri/src/vcs.rs` | 판(git) — 남기기 · 이력 · 태그 · 되돌리기(앞으로만) |
| `src-tauri/src/watch.rs` | 프로젝트 폴더 감시 → `deck-fs` 사건 |
| `src-tauri/src/imagegen.rs` | 그림 공급자 감지 · 생성 |
| `src-tauri/src/pptsnap.rs` | PowerPoint 로 원본 쪽 그림 |
| `src-tauri/runtime/rt.js` | 슬라이드 안 런타임 — CSS 다시 읽기 · 핀 위치 · 직접 편집 · PPTX 좌표 |
| `src/lib/store.ts` | 열린 프로젝트 상태 · 대화 턴 · 핀 · 판 · 릴리즈 |
| `src/lib/prompt.ts` | 앱 시스템 프롬프트 · 턴 요청문 |
| `src/lib/importPptx.ts` · `exportPptx.ts` | PPTX ↔ 웹 |
| `src/components/` | 제목 줄 · 처음 화면 · 작업 화면(쪽 목록 · 무대 · 판 줄기) · 대화 · 설정 |
