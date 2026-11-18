// 이 PC 에서 서명해 만든 설치 파일을 GitHub 릴리즈로 올린다 — 저장소에 서명 키 비밀값이 없을 때 쓰는 배포 길.
//
// 쓰는 법 (서명 키가 있는 PC 에서):
//   TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/claudeppt.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npm run tauri build
//   git push origin main && node tools/release-local.mjs
//
// 하는 일: tauri.conf.json 의 버전으로 설치 파일 · 서명을 찾고, CHANGELOG.md 의 그 판 구획을 노트로 latest.json 을 만들어
// v<버전> 릴리즈(태그 포함)에 함께 올린다. 설치된 앱은 releases/latest/download/latest.json 을 보고 업데이트한다.
// latest.json 의 서명이 앱에 박힌 공개 키와 맞지 않으면 앱이 업데이트를 거절한다 — 그래서 빌드할 때 서명 키가 꼭 있어야 한다.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const { version, productName } = conf;
const repo = conf.plugins.updater.endpoints[0].match(/github\.com\/([^/]+\/[^/]+)\//)[1];
const tag = `v${version}`;
const dir = "src-tauri/target/release/bundle/nsis";
const exe = `${productName}_${version}_x64-setup.exe`;
const sig = `${exe}.sig`;
for (const f of [exe, sig]) if (!existsSync(join(dir, f))) fail(`${dir}/${f} 가 없다 — 서명 키를 주고 npm run tauri build 를 먼저 돌린다`);

const lines = readFileSync("CHANGELOG.md", "utf8").split(/\r?\n/);
const start = lines.findIndex((l) => l === `## ${version}` || l.startsWith(`## ${version} `));
if (start < 0) fail(`CHANGELOG.md 에 ## ${version} 구획이 없다`);
let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
if (end < 0) end = lines.length;
const notes = lines.slice(start + 1, end).join("\n").trim();

const url = `https://github.com/${repo}/releases/download/${tag}/${exe}`;
const signature = readFileSync(join(dir, sig), "utf8").trim();
const platform = { signature, url };
// windows-x86_64-nsis 는 설치 방식까지 맞춰 고르는 이름, windows-x86_64 는 그 밖의 판이 찾는 이름 — 둘 다 둔다
const latest = { version, notes, pub_date: new Date().toISOString(), platforms: { "windows-x86_64": platform, "windows-x86_64-nsis": platform } };
const latestPath = join(tmpdir(), "latest.json");
writeFileSync(latestPath, JSON.stringify(latest, null, 2));
const notesPath = join(tmpdir(), "release-notes.md");
writeFileSync(notesPath, notes);

const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
execFileSync("gh", ["release", "create", tag, "-R", repo, "--target", head, "--title", `${productName} ${tag}`, "--notes-file", notesPath, join(dir, exe), join(dir, sig), latestPath], { stdio: "inherit" });
console.log(`올렸다: https://github.com/${repo}/releases/tag/${tag}`);

function fail(msg) {
	console.error(msg);
	process.exit(1);
}
