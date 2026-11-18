// 글꼴 맞추기 — 덱이 쓰는 글꼴이 PowerPoint 에서와 똑같이 보이게 한다.
//
// 목차
//   fontIndex      이 PC 에 깔린 글꼴 (Rust font_index) — 한 번 읽어 두고, 새로 깔면 다시 읽는다
//   installedNames 내보내기가 「깔린 글꼴인가」를 가릴 때 쓰는 이름 모음 (가족 · 전체 이름, 모든 나라말)
//   faceResolver   글꼴 이름 → 깔린 글꼴(보통 판)과 굵은 판이 있는지. 가져오기가 줄 자리 · 굵게 흉내를 PowerPoint 와 맞출 때 쓴다
//   linkFonts      덱이 쓰는 글꼴 이름마다 깔린 글꼴을 찾아 theme.css 에 별칭(@font-face)을 쓴다. 못 찾은 이름을 돌려준다
//   askClaude      못 찾은 글꼴을 Claude 가 웹에서 찾고(받을 주소만), 앱이 받아 깔고 다시 잇는다
//
// 왜 별칭인가: 쪽에는 원본 PPTX 의 글꼴 이름(「에스코어 드림 5 Medium」)을 그대로 둔다 — 그래야 내보낸 PPTX 도 원본과 같은 이름을 쓴다.
// 그런데 웹뷰는 가족 이름으로는 영어 이름만 알아보므로, 원본 이름을 가족 이름으로 하는 @font-face 를 두고 src 를 local("영어 전체 이름")으로 잇는다.
// 같은 가족의 굵게 · 기울임 판도 따로 이어서, PowerPoint 처럼 「굵게」를 누르면 굵은 판 글꼴을 쓴다 (없으면 둘 다 흉내 굵게).
import { listen } from "@tauri-apps/api/event";
import { api, type FontFace } from "./api";
import type { Deck } from "./deck";
import { useSettings } from "./settings";

let indexP: Promise<FontFace[]> | null = null;
export const fontIndex = () => (indexP ||= api.fontIndex().catch(() => []));
const refreshIndex = () => { indexP = null; return fontIndex(); };

export async function installedNames(): Promise<Set<string>> {
	const s = new Set<string>();
	for (const f of await fontIndex()) for (const n of [...f.family, ...f.full]) s.add(n.toLowerCase());
	return s;
}

const GENERIC = new Set(["serif", "sans-serif", "monospace", "system-ui", "cursive", "fantasy", "inherit", "initial", "ui-sans-serif", "ui-serif", "ui-monospace"]);
/** 대소문자 · 띄어쓰기 · 붙임표를 가리지 않는다 — 「S-Core Dream」 · 「SCore Dream」 · 「에스코어드림」 이 서로 어긋나 못 찾는 일이 없게 */
const norm = (s: string) => s.toLowerCase().replace(/[\s\-_]/g, "");

const BEGIN = "/* <글꼴> 앱이 고쳐 쓰는 구획 — 덱이 쓰는 글꼴 이름을 이 PC 에 깔린 글꼴로 잇는다. 손으로 고치지 않는다 */";
const END = "/* </글꼴> */";

/** CSS 의 font-family 값 → 글꼴 이름들 */
function namesIn(value: string): string[] {
	const out: string[] = [];
	for (const m of value.matchAll(/"([^"]+)"|'([^']+)'|([^,'"]+)/g)) {
		const n = (m[1] ?? m[2] ?? m[3] ?? "").trim();
		if (n && !n.startsWith("var(") && !GENERIC.has(n.toLowerCase())) out.push(n);
	}
	return out;
}

/** 덱이 쓰는 글꼴 이름 — 쪽 HTML 의 인라인 서식 · <style> 과 theme.css (앱 구획 밖) */
async function usedFonts(dir: string, deck: Deck, css: string): Promise<{ used: Set<string>; declared: Set<string> }> {
	const used = new Set<string>(), declared = new Set<string>();
	const outside = css.replace(new RegExp(`${esc(BEGIN)}[\\s\\S]*?${esc(END)}\\n?`), "");
	for (const m of outside.matchAll(/@font-face\s*{[^}]*font-family\s*:\s*["']?([^"';}]+)/g)) declared.add(norm(m[1]));
	const scan = (text: string) => {
		// 인라인 style="…" 은 &quot; 로 감싸일 수 있다
		for (const m of text.replace(/&quot;/g, '"').matchAll(/font-family\s*:\s*([^;}<>]+)/g)) for (const n of namesIn(m[1])) used.add(n);
		for (const m of text.matchAll(/--font\s*:\s*([^;}]+)/g)) for (const n of namesIn(m[1])) used.add(n);
	};
	scan(outside);
	for (const s of deck.slides) scan(await api.readText(dir, s.file).catch(() => ""));
	return { used, declared };
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 이름으로 깔린 글꼴을 찾는다 — linkFonts 와 같은 규칙(가족 이름 먼저, 없으면 전체 이름 한 판).
 *  regular 는 보통 판(없으면 처음 찾은 판), bold 는 진짜 굵은 판이 있는지 — 없으면 「굵게」는 흉내 굵게가 된다 */
export async function faceResolver(): Promise<(name: string) => { regular: FontFace; bold: boolean } | null> {
	const faces = await fontIndex();
	const memo = new Map<string, { regular: FontFace; bold: boolean } | null>();
	return (name) => {
		const k = norm(name);
		if (memo.has(k)) return memo.get(k)!;
		const group = faces.filter((f) => f.family.some((n) => norm(n) === k));
		const one = group.length ? null : faces.find((f) => f.full.some((n) => norm(n) === k));
		const regular = one || group.find((f) => !f.bold && !f.italic) || group[0];
		const r = regular ? { regular, bold: !one && group.some((f) => f.bold && !f.italic) } : null;
		memo.set(k, r);
		return r;
	};
}

/** 덱이 쓰는 글꼴을 이 PC 의 글꼴로 잇는다. theme.css 의 앱 구획만 고쳐 쓰고, 바뀐 게 없으면 쓰지 않는다. 못 찾은 이름을 돌려준다. */
export async function linkFonts(dir: string, deck: Deck): Promise<{ missing: string[]; changed: boolean }> {
	const css = await api.readText(dir, "theme.css").catch(() => "");
	const { used, declared } = await usedFonts(dir, deck, css);
	const faces = await fontIndex();
	const rules: string[] = [];
	const missing: string[] = [];
	const q = (s: string) => `"${s.replace(/["\\]/g, "\\$&")}"`;
	for (const name of [...used].sort()) {
		const k = norm(name);
		if (declared.has(k)) continue;
		// 가족 이름으로 맞으면 그 가족의 보통 · 굵게 · 기울임 판을 모두 잇는다. 전체 이름으로만 맞으면 그 한 판을 보통 굵기로 쓴다 (PowerPoint 와 같다)
		let group = faces.filter((f) => f.family.some((n) => norm(n) === k));
		const single = !group.length;
		if (single) group = faces.filter((f) => f.full.some((n) => norm(n) === k)).slice(0, 1);
		if (!group.length) { missing.push(name); continue; }
		const seen = new Set<string>();
		for (const f of group) {
			const weight = !single && f.bold ? 700 : 400, style = !single && f.italic ? "italic" : "normal";
			if (seen.has(weight + style)) continue;
			seen.add(weight + style);
			// 프로젝트에 같은 글꼴 파일을 넣어 두었으면(Claude 가 받아 깐 글꼴) 그것도 잇는다 — 웹뷰는 새로 깐 글꼴을 다시 켜야 보는 일이 있다
			const base = f.file.split(/[\\/]/).pop()!;
			const local = (await api.exists(dir, `assets/fonts/${base}`)) ? `, url(${q(`assets/fonts/${base}`)})` : "";
			rules.push(`@font-face { font-family: ${q(name)}; src: local(${q(f.local)})${local}; font-weight: ${weight}; font-style: ${style}; }`);
		}
	}
	const block = rules.length ? `${BEGIN}\n${rules.join("\n")}\n${END}\n` : "";
	const rest = css.replace(new RegExp(`${esc(BEGIN)}[\\s\\S]*?${esc(END)}\\n?`), "");
	// 구획은 맨 앞에 둔다 — 다른 서식이 이 글꼴을 쓰기 전에 정의되도록
	const next = block + rest;
	const changed = next !== css;
	if (changed) await api.writeText(dir, "theme.css", next);
	return { missing, changed };
}

// ── 못 찾은 글꼴 → Claude 가 받을 주소를 찾고, 앱이 받아 깐다 ──

const FONT_SYSTEM = `You find official download links for fonts so a desktop app can install them on Windows.
You only have web search and web fetch. Do not write files.

For each requested font name (it may be a Korean or English family name as saved by PowerPoint, often with a weight in the name like "6 SemiBold"):
1. Identify the font family and its official distributor (the type foundry, the company or public body that released it, Google Fonts, or the project's GitHub releases). Korean free-font listings such as noonnu.cc can help you find the official page, but link to the official file.
2. Only use fonts whose license allows free use (OFL, or an explicit free-for-commercial-use license). If the font is paid or the license is unclear, put it in "unavailable" with the reason.
3. Give a direct HTTPS link that downloads the file itself (.zip, .ttf or .otf) — not a web page. For GitHub use a release asset or raw.githubusercontent.com link. One archive may cover several requested names; repeat the same url for each.
4. Prefer TTF or OTF desktop fonts over web fonts (woff/woff2 cannot be installed).

Reply with only this JSON, no prose:
{"fonts":[{"name":"<requested name>","url":"https://…","source":"<official page>","license":"<short license name>"}],"unavailable":[{"name":"<requested name>","reason":"<one short Korean sentence>"}]}`;

interface Found { fonts?: { name: string; url: string; source?: string; license?: string }[]; unavailable?: { name: string; reason: string }[] }

/** Claude 에게 받을 주소를 묻고, 받아 깔고, 프로젝트 assets/fonts 에도 넣은 뒤 다시 잇는다. step 으로 진행을 알린다. */
export async function askClaude(dir: string, deck: Deck, names: string[], step: (note: string) => void): Promise<{ installed: string[]; missing: string[]; reasons: string[] }> {
	const s = useSettings.getState().s;
	const turn = "f" + Date.now().toString(36);
	let result = "";
	const un = await listen<{ turn: string; line: string }>("claude", (e) => {
		if (e.payload.turn !== turn) return;
		try {
			const m = JSON.parse(e.payload.line);
			if (m.type === "result") result = m.result || "";
			else if (m.type === "assistant") for (const c of m.message?.content || []) if (c.type === "tool_use") step(c.name === "WebSearch" ? `찾는 중 · ${c.input?.query ?? ""}` : `읽는 중 · ${c.input?.url ?? ""}`);
		} catch { /* 줄 하나가 깨져도 다음 줄은 읽는다 */ }
	});
	try {
		step("Claude 가 받을 곳을 찾는 중");
		const r = await api.claudeRun({
			turn, dir, mode: "fonts", system: FONT_SYSTEM,
			prompt: `Find download links for these fonts:\n${names.map((n) => `- ${n}`).join("\n")}`,
			claudePath: s.claude.path, model: s.claude.model, effort: s.claude.effort,
		});
		if (r.code !== 0 && !result) throw new Error(r.stderr.trim().split("\n").slice(-2).join(" ") || `Claude exit ${r.code}`);
	} finally {
		un();
	}
	const json = result.match(/\{[\s\S]*\}/)?.[0];
	let found: Found = {};
	try { found = JSON.parse(json || "{}"); } catch { throw new Error("Claude 의 답을 읽지 못했습니다"); }
	const reasons = (found.unavailable || []).map((u) => `${u.name}: ${u.reason}`);
	const urls = [...new Set((found.fonts || []).map((f) => f.url).filter((u) => /^https:\/\//.test(u)))];
	const installed: string[] = [];
	if (urls.length) {
		step("글꼴 받아 까는 중");
		for (const r of await api.fontInstall(urls)) {
			if (r.error) reasons.push(`${r.url.split("/").pop()}: ${r.error}`);
			for (const file of r.files) {
				const base = file.split(/[\\/]/).pop()!;
				// 프로젝트에도 넣어 둔다 — 웹뷰는 새로 깐 글꼴을 다시 켜야 보는 일이 있어, 그 사이에도 바로 보이게 한다
				await api.absCopyIn(file, dir, `assets/fonts/${base}`).catch(() => {});
				installed.push(base);
			}
		}
	}
	await refreshIndex();
	const { missing } = await linkFonts(dir, deck);
	return { installed, missing, reasons };
}
