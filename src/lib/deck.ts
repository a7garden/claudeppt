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
import type { Settings } from "./settings";

export const FORMAT = "claudeppt/1";

export interface SlideRef { id: string; file: string; title?: string; notes?: string }
export interface Deck {
	format: string;
	title: string;
	size: { w: number; h: number };
	slides: SlideRef[];
	theme: string;
	source?: { kind: "new" | "pptx"; file?: string; pages?: number };
	created: string;
	updated: string;
}

export const newId = () => "s" + Math.random().toString(36).slice(2, 8);

export async function readDeck(dir: string): Promise<Deck> {
	const d = JSON.parse(await api.readText(dir, "deck.json"));
	return { size: { w: 1280, h: 720 }, theme: "theme.css", slides: [], ...d };
}

export async function writeDeck(dir: string, deck: Deck) {
	deck.updated = new Date().toISOString();
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

export function themeCss(sh: Settings["shape"], size = { w: 1280, h: 720 }) {
	const font = sh.font === "Pretendard" ? `"Pretendard", "Malgun Gothic", sans-serif` : `"${sh.font}", "Malgun Gothic", sans-serif`;
	return `/* 모든 쪽이 함께 쓰는 서식. 색 · 글꼴은 변수로만 쓴다 — 바꾸면 모든 쪽이 따라 바뀐다. */
@font-face { font-family: "Pretendard"; src: url("assets/fonts/PretendardVariable.woff2") format("woff2"); font-weight: 45 920; }

:root {
	--ink: ${sh.ink};
	--paper: ${sh.paper};
	--accent: ${sh.accent};
	--muted: color-mix(in srgb, var(--ink) 55%, var(--paper));
	--line: color-mix(in srgb, var(--ink) 14%, var(--paper));
	--soft: color-mix(in srgb, var(--ink) 5%, var(--paper));
	--radius: ${sh.radius}px;
	--stroke: ${sh.stroke}px;
	--font: ${font};
}

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

/** 빈 프로젝트를 만든다. 첫 쪽은 표지 하나. */
export async function createDeck(dir: string, title: string, s: Settings): Promise<Deck> {
	await api.vcsInit(dir);
	const id = newId();
	const deck: Deck = {
		format: FORMAT,
		title,
		size: { w: 1280, h: 720 },
		slides: [{ id, file: `slides/${id}.html`, title }],
		theme: "theme.css",
		source: { kind: "new" },
		created: new Date().toISOString(),
		updated: new Date().toISOString(),
	};
	await embedFont(dir);
	await api.writeText(dir, "theme.css", themeCss(s.shape));
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
