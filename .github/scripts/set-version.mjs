// 태그 v<판> 으로 돌 때 tauri.conf.json 의 판 번호를 태그에 맞춘다. release.yml 이 부른다.
// automerge 가 단 패치 태그는 main 의 판 번호보다 앞선다(main 파일은 고치지 않는다). 맞추지 않으면 설치 파일 · latest.json 이
// 옛 판 번호로 나가 깔린 앱이 새 판을 알아보지 못한다. 앱이 보이는 판 번호도 tauri.conf.json 에서 온다.
import { readFileSync, writeFileSync } from "node:fs";

const path = "src-tauri/tauri.conf.json";
const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : "";
const m = /^v(\d+\.\d+\.\d+)$/.exec(tag);
if (!m) process.exit(0);
const text = readFileSync(path, "utf8");
const { version } = JSON.parse(text);
if (version === m[1]) process.exit(0);
// 파일 꼴(들여쓰기 · 줄끝)을 그대로 두려고 첫 "version" 값만 바꾼다
writeFileSync(path, text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${m[1]}$2`));
console.log(`tauri.conf.json 판 ${version} → ${m[1]}`);
