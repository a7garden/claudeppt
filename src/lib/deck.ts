// 프로젝트 파일 꼴 (claudeppt/1)
//
//   <프로젝트 폴더>/
//     deck.json            목차 — 제목 · 크기 · 쪽 순서. 쪽 순서는 이 배열 하나만 정본이다
//     theme.css            모든 쪽이 함께 쓰는 서식 (글꼴 · 색 변수 · .slide 틀 · 공통 부품)
//     slides/<id>.html     한 쪽에 한 파일. <section class="slide"> 하나가 1280×720 한 장이다
//     assets/              그림 · 글꼴. gen-*.png 는 그림 생성 도구가 만든 것
//     source/              가져온 원본 — original.pptx · pages/<n>.png (PowerPoint 가 그린 원본 쪽 그림)
//     releases/            릴리즈 — r<k>-v<n>.pptx · releases.json
//     .claudeppt/          앱 상태(판에 넣지 않는다) — pins.json · talk.json · run/
//     .git/                판 이력. v<n> = 커밋 수 · 릴리즈 = 태그 r<k>
//
// 한 파일로 주고받을 때는 폴더째 zip 으로 묶은 .cppt 를 쓴다 (판 이력 포함).
// 쪽 id 는 파일 이름과 같다 — 순서를 바꿔도 파일 이름이 바뀌지 않아 판 사이 비교가 쉽다.

import fontUrl from "pretendard/dist/web/variable/woff2/PretendardVariable.woff2?url";
import { api, b64FromBytes } from "./api";
import { type Settings, type Template, templateOf } from "./settings";

export const FORMAT = "claudeppt/1";

/** hidden — 공유 덱 창에서 담당이 아니라 내용 없이 자리만 받은 쪽 (collab.rs limit_view). file 이 빈 글이다 */
export interface SlideRef { id: string; file: string; title?: string; notes?: string; hidden?: boolean }
export interface Deck {
	format: string;
	title: string;
	size: { w: number; h: number };
	slides: SlideRef[];
	theme: string;
	source?: { kind: "new" | "pptx"; file?: string; pages?: number };
	/** 만들 때 쓴 템플릿 id (settings.templates) — 매 턴 그 템플릿의 스타일 규칙이 실린다. 가져온 PPTX 는 없다 */
	template?: string;
	/** 쪽 설정 — 이 덱의 쪽 여백(px). 없으면 템플릿 여백을 네 변에 똑같이 쓴다 (2026.11.26) */
	page?: { margin: Margins };
	created: string;
	/** 2026.11.27 부터 쓰지 않는다: 저장할 때마다 바뀌어 두 사람의 변경이 늘 겹쳤다. 옛 덱에 남은 값은 저장할 때 지운다 */
	updated?: string;
}

/** 쪽 여백 — 위 · 오른쪽 · 아래 · 왼쪽 (CSS padding 차례) */
export interface Margins { t: number; r: number; b: number; l: number }

/** 쪽 설정 구획 — 템플릿 구획 뒤에 둔다. 「이 덱에 적용」(rethemeCss)은 템플릿 구획만 갈아 끼우므로 쪽 설정이 남는다 */
const PAGE_START = "/* @page start";
const PAGE_END = "/* @page end */";

/** theme.css 에 쪽 여백 변수(--margin-t · -r · -b · -l)를 쓴다. null 이면 구획을 걷는다 — 그때 Claude 에게는 var(--margin) 만 말한다(prompt.ts pageRules) */
export function repageCss(css: string, m: Margins | null) {
	const a = css.indexOf(PAGE_START), b = css.indexOf(PAGE_END);
	const rest = a >= 0 && b > a ? css.slice(0, a).replace(/\n+$/, "\n") + css.slice(b + PAGE_END.length).replace(/^\n+/, "\n") : css;
	if (!m) return rest;
	const block = `${PAGE_START} · 쪽 설정(제목 줄 「쪽 설정」)이 쓰는 구획. 여백은 거기서 바꾼다 */
:root { --margin-t: ${m.t}px; --margin-r: ${m.r}px; --margin-b: ${m.b}px; --margin-l: ${m.l}px; }
${PAGE_END}`;
	const e = rest.indexOf(TPL_END);
	if (e >= 0) { const at = e + TPL_END.length; return rest.slice(0, at) + "\n\n" + block + rest.slice(at); }
	const root = /:root\s*\{[^}]*\}/.exec(rest);
	if (root) { const at = root.index + root[0].length; return rest.slice(0, at) + "\n\n" + block + rest.slice(at); }
	return block + "\n\n" + rest;
}

export const newId = () => "s" + Math.random().toString(36).slice(2, 8);

export async function readDeck(dir: string): Promise<Deck> {
	const d = JSON.parse(await api.readText(dir, "deck.json"));
	return { size: { w: 1280, h: 720 }, theme: "theme.css", slides: [], ...d };
}

export async function writeDeck(dir: string, deck: Deck) {
	delete deck.updated;
	await api.writeText(dir, "deck.json", JSON.stringify(deck, null, 2) + "\n");
}

export function slideHtml(body: string, lang = "ko") {
	return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="../theme.css">
</head>
<body>
${body}
</body>
</html>
`;
}

const family = (f: string) => `"${f}", "Malgun Gothic", sans-serif`;

// 템플릿 구획 — theme.css 안에서 템플릿이 쓰는 곳. 「이 덱에 적용」은 이 구획만 갈아 끼운다 (rethemeCss).
// 2026.11.26 : 글자 위계(.t-*) · 제목 글꼴 · 보조 색 · 여백을 더하며 구획을 표시로 둘렀다. 전에는 :root 변수 여섯 개만 바꿨다
const TPL_START = "/* @template start";
const TPL_END = "/* @template end */";

/** 템플릿 구획 — :root 변수와 글자 위계 클래스. 쪽은 색 · 글꼴 · 크기를 이 이름으로만 쓴다 */
export function templateBlock(sh: Template) {
	const s = sh.scale;
	const step = (l: keyof Template["scale"], extra: string) =>
		`.t-${l} { font-size: var(--fs-${l}); font-weight: var(--fw-${l}); ${extra} }`;
	return `${TPL_START} 「${sh.name.replace(/\*\//g, "")}」 · 설정 › 템플릿이 쓰는 구획. 고치려면 템플릿을 바꾸고 「이 덱에 적용」 */
:root {
	--ink: ${sh.ink};
	--paper: ${sh.paper};
	--accent: ${sh.accent};
${sh.palette.map((c, i) => `\t--c${i + 1}: ${c};\n`).join("")}	--muted: color-mix(in srgb, var(--ink) 55%, var(--paper));
	--line: color-mix(in srgb, var(--ink) 14%, var(--paper));
	--soft: color-mix(in srgb, var(--ink) 5%, var(--paper));
	--radius: ${sh.radius}px;
	--stroke: ${sh.stroke}px;
	--margin: ${sh.margin}px;
	--font: ${family(sh.font)};
	--font-head: ${sh.headFont.trim() ? family(sh.headFont.trim()) : "var(--font)"};
${(Object.keys(s) as (keyof Template["scale"])[]).map((l) => `\t--fs-${l}: ${s[l].size}px; --fw-${l}: ${s[l].weight};\n`).join("")}}
${step("display", "font-family: var(--font-head); line-height: 1.15; letter-spacing: -0.02em;")}
${step("title", "font-family: var(--font-head); line-height: 1.2; letter-spacing: -0.01em;")}
${step("subtitle", "font-family: var(--font-head); line-height: 1.3;")}
${step("body", "line-height: 1.45;")}
${step("caption", "line-height: 1.4; color: var(--muted);")}
${TPL_END}`;
}

export function themeCss(sh: Template, size = { w: 1280, h: 720 }) {
	return `/* 모든 쪽이 함께 쓰는 서식. 색 · 글꼴 · 글자 크기는 변수와 .t-* 클래스로만 쓴다 — 바꾸면 모든 쪽이 따라 바뀐다. */
@font-face { font-family: "Pretendard"; src: url("assets/fonts/PretendardVariable.woff2") format("woff2"); font-weight: 45 920; }

${templateBlock(sh)}

html, body { margin: 0; padding: 0; background: var(--paper); }
* { box-sizing: border-box; }

.slide {
	position: relative;
	width: ${size.w}px;
	height: ${size.h}px;
	overflow: hidden;
	background: var(--paper);
	color: var(--ink);
	font-family: var(--font);
	font-size: 24px;
	line-height: 1.45;
	word-break: keep-all;
}
.slide h1, .slide h2, .slide h3, .slide p { margin: 0; }
`;
}

/** 덱의 theme.css 에서 템플릿 구획만 갈아 끼운다 — 쪽마다 쓴 클래스 · 글자 틀 같은 나머지 서식은 그대로 둔다.
 *  구획 표시가 없는 옛 덱은 첫 :root 규칙 바로 뒤에 구획을 넣는다. 같은 :root 라 뒤에 온 구획의 값이 이긴다 —
 *  옛 :root 를 지우지 않는 것은 Claude 가 거기 더해 둔 변수를 살리려고 */
export function rethemeCss(css: string, tpl: Template) {
	const block = templateBlock(tpl);
	const a = css.indexOf(TPL_START), b = css.indexOf(TPL_END);
	if (a >= 0 && b > a) return css.slice(0, a) + block + css.slice(b + TPL_END.length);
	const root = /:root\s*\{[^}]*\}/.exec(css);
	if (root) return css.slice(0, root.index + root[0].length) + "\n\n" + block + css.slice(root.index + root[0].length);
	return block + "\n\n" + css;
}

/** theme.css 의 :root 변수 → 템플릿 값. 「지금 덱에서 가져오기」가 쓴다 — 가져온 PPTX 의 글꼴 · 색을 템플릿으로 남겨 다음 덱에 다시 쓰려고.
 *  색 칸이 #RRGGBB 만 받으므로 그 꼴이 아닌 값(color-mix · rgb)은 건너뛴다. 같은 변수가 여러 번 있으면 뒤의 것(템플릿 구획)이 이긴다 */
export function themeVars(css: string): Partial<Template> {
	const get = (k: string) => [...css.matchAll(new RegExp(`(?<![\\w-])${k}\\s*:\\s*([^;]+);`, "g"))].pop()?.[1].trim();
	const hex = (v?: string) => {
		if (!v) return undefined;
		if (/^#[0-9a-f]{6}$/i.test(v)) return v.toUpperCase();
		if (/^#[0-9a-f]{3}$/i.test(v)) return ("#" + [...v.slice(1)].map((c) => c + c).join("")).toUpperCase();
		return undefined;
	};
	const num = (v?: string) => (v && !isNaN(parseFloat(v)) ? parseFloat(v) : undefined);
	const first = (v?: string) => (v && !v.startsWith("var(") ? v.split(",")[0].trim().replace(/^["']|["']$/g, "") : undefined);
	const palette = Array.from({ length: 6 }, (_, i) => hex(get(`--c${i + 1}`))).filter((c): c is string => !!c);
	const scale: Partial<Template["scale"]> = {};
	for (const l of ["display", "title", "subtitle", "body", "caption"] as const) {
		const size = num(get(`--fs-${l}`)), weight = num(get(`--fw-${l}`));
		if (size) scale[l] = { size, weight: weight || 400 };
	}
	const out: Partial<Template> = {
		ink: hex(get("--ink")), paper: hex(get("--paper")), accent: hex(get("--accent")),
		radius: num(get("--radius")), stroke: num(get("--stroke")), margin: num(get("--margin")),
		font: first(get("--font")), headFont: first(get("--font-head")),
		palette: palette.length ? palette : undefined,
		scale: Object.keys(scale).length === 5 ? (scale as Template["scale"]) : undefined,
	};
	return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && v !== ""));
}

/** 빈 프로젝트를 만든다. 첫 쪽은 표지 하나. 템플릿을 주지 않으면 기본 템플릿 */
export async function createDeck(dir: string, title: string, s: Settings, template?: string): Promise<Deck> {
	const tpl = templateOf(s, template);
	await api.vcsInit(dir);
	const id = newId();
	const deck: Deck = {
		format: FORMAT,
		title,
		size: { w: 1280, h: 720 },
		slides: [{ id, file: `slides/${id}.html`, title }],
		theme: "theme.css",
		source: { kind: "new" },
		template: tpl.id,
		created: new Date().toISOString(),
	};
	await embedFont(dir);
	await api.writeText(dir, "theme.css", themeCss(tpl));
	await api.writeText(dir, `slides/${id}.html`, slideHtml(`<section class="slide" style="display:flex;flex-direction:column;justify-content:center;padding:0 120px">
	<h1 style="font-size:64px;font-weight:700;letter-spacing:-0.02em">${escapeHtml(title)}</h1>
</section>`, s.lang));
	await writeDeck(dir, deck);
	return deck;
}

export async function embedFont(dir: string) {
	if (await api.exists(dir, "assets/fonts/PretendardVariable.woff2")) return;
	const buf = new Uint8Array(await (await fetch(fontUrl)).arrayBuffer());
	await api.writeB64(dir, "assets/fonts/PretendardVariable.woff2", b64FromBytes(buf));
}

export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** 폴더 이름으로 쓸 수 있게 다듬는다. */
export const safeName = (s: string) => s.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "deck";
