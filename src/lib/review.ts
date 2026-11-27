// 점검의 「Claude 검토」 — 규칙 점검(audit.ts)이 잰 것을 받아, 규칙으로는 못 보는 것을 Claude 가 쪽 그림과 글로 본다. 고치지는 않는다.
//
// 규칙 점검과 나눈 몫
//   규칙   잴 수 있는 것: 글꼴 · 색 · 크기 · 여백 · 넘침 · 긴 줄표 · 이모지 · 상투어 · 카드 나열 (빠르고 매번 같다)
//   Claude 읽어야 아는 것: 쪽의 메시지 · 쪽 사이 흐름 · 숫자가 맞는지 · 글 · 보이는 위계 · 도표 · 사람이 적은 추가 지시
//   함께   규칙이 짚은 것 가운데 의도한 것(쪽 끝까지 깐 띠 · 로고의 브랜드 색 · 내용에 맞는 카드 줄)을 Claude 가 그림을 보고 가려 「의도」로 내린다.
//          Claude 가 짚은 글은 규칙 점검이 잰 요소 자리에서 찾아 무대에 상자를 그린다
//
// 목차
//   지침          REVIEW_GUIDE (볼 것 · 바깥 CLI 의 audit 도 돌려준다) · reviewSystem (답 꼴까지 붙인 시스템 프롬프트)
//   요청          reviewPrompt — 쪽마다 그림 · 파일 · 글 · 규칙 점검이 짚은 것
//   합치기        mergeReview — Claude 의 답을 점검 결과에 넣는다 (순수 함수 · page.test.ts)
//   돌리기        runReview · stopReview — 읽기 · 찾기만 주고 띄운다 (claude.rs mode = "review")
//
// 2026.11.27 : 처음 만들었다. 쪽당 다섯 건 · 그림 너비 1280px 은 실제 덱을 돌려 보며 조정한다
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { type AuditReport, type Box, type Finding, type Node, SHOT_W, SHOTS } from "./audit";
import type { Deck } from "./deck";
import { type Key, tNow } from "./i18n";
import { houseStyle } from "./prompt";
import { useSettings } from "./settings";

/** 볼 것 — 앱 안 검토와 바깥 CLI 세션이 같은 지침으로 본다. 규칙 점검이 이미 보는 것은 넣지 않는다 (겹치면 같은 것을 두 번 짚는다) */
export const REVIEW_GUIDE = `What to look for (topic id in brackets). The app's rules already measure fonts, colors, type scale, margins, overflow, em dashes, emoji, filler words, gradients and look-alike card rows: do not report those yourself.
[message] One slide, one message. The title states the point as a short claim ("Night calls doubled after the March change"), not a topic label ("Call trends"), except on a cover, section divider, agenda or closing slide. The body supports the title; anything that does not belongs on another slide or in the notes.
[flow] Across slides: an order that makes the argument hard to follow, a missing step, the same point made on two slides, a conclusion shown before its evidence, an agenda that does not match the slides that follow.
[facts] Totals that do not add up, shares that do not sum to 100%, a figure that differs between slides, missing units or periods, dates out of order, a claim the audience will question with no source on the slide. When two slides disagree, quote both. Never guess the right number.
[wording] Typos and spacing, mixed sentence endings or politeness in one deck (in Korean: ~다 vs ~습니다, noun-ending bullets vs full sentences), one thing called by different names, unexplained abbreviations or internal jargon, sentences too long to say aloud.
[visual] As the audience sees the picture: the eye lands first on something other than the main point, text too small or too faint to read from the back of a room, a crowded area, elements that look slightly misaligned or unevenly spaced, a picture or icon that adds nothing.
[chart] A chart type that does not fit the data, missing axis labels or units, a cut axis that exaggerates a change, a legend far from its data, too many series, a table where one highlighted number would do, no source line under data.
[instruction] If the person gave additional instructions for this check, every place that does not follow them.

Report what a careful reviewer would raise in a real rehearsal. Skip matters of taste and give no praise. A slide that is fine gets no findings. Fewer, sharper findings beat many small ones: at most 5 per slide.`;

const TOPICS = ["message", "flow", "facts", "wording", "visual", "chart", "instruction"] as const;
export type ReviewTopic = (typeof TOPICS)[number];
export type Severity = "high" | "medium" | "low";

/** 시스템 프롬프트 — 볼 것 · 일하는 순서 · 규칙 점검 결과를 다루는 법 · 답 꼴 */
export function reviewSystem(lang: "ko" | "en") {
	const L = lang === "ko" ? "Korean" : "English";
	return `You review a presentation deck the way a demanding editor and presentation coach would, before it goes in front of an audience.
You do not edit anything. You only have Read, Glob and Grep.

How to work
1. For each slide in the request, Read its picture first and judge it as the audience will see it. Use the text given in the request for exact wording. Open the slide HTML only when you need to know what an element is.
2. Then look across the whole deck for flow and facts that span slides.
3. Answer with the JSON below.

${REVIEW_GUIDE}

The app's rule findings
Each slide in the request lists what the app's fixed rules found (rule id and description). Look at the picture and decide whether each one is a real problem or intentional: a color band or picture that runs to the edge on purpose, a brand color inside a logo, a row of cards that really fits the content. Put only the intentional ones under "dismiss" with a short reason in ${L}. Do not repeat rule findings as your own.

Each finding
- "msg": one short sentence in ${L} for the person: what is wrong and where. Plain words, no jargon, no em dashes.
- "fix": one English instruction for the assistant who will edit the slide later: which element (quote its text) and what to change. It must make sense without this review.
- "quote": a short exact piece of the text of the element concerned, copied from the request, or "" when the finding is about the whole slide.
- "severity": "high" when the audience will be misled or lost, "medium" when it weakens the slide, "low" for polish.

Reply with only this JSON, no text before or after it. Leave out slides with nothing to report.
{"slides":[{"no":3,"findings":[{"topic":"message","severity":"medium","msg":"…","fix":"…","quote":"…"}],"dismiss":[{"rule":"cards","reason":"…"}]}],"deck":[{"topic":"flow","severity":"medium","slides":[4,7],"msg":"…","fix":"…"}]}
Topics: ${TOPICS.join(", ")}.`;
}

/** 쪽 하나에 실을 글 — 보이는 글을 위에서 아래로. 너무 길면 자른다 (그림에 다 있다) */
const slideText = (nodes: Node[]) => {
	const t = nodes.filter((n) => n.text).sort((a, b) => a.y - b.y || a.x - b.x).map((n) => n.text.replace(/\s+/g, " ").trim()).filter(Boolean);
	const out = [...new Set(t)].join(" / ");
	return out.length > 1500 ? out.slice(0, 1500) + " …" : out;
};

/** 요청 — 덱 · 서식 규칙 · 추가 지시 · 쪽마다 그림 · 파일 · 글 · 규칙 점검이 짚은 것 */
export function reviewPrompt(deck: Deck, r: AuditReport, per: Node[][], style: string) {
	const slides = r.slides.map((s, i) => {
		const ref = deck.slides[i];
		const rules = s.findings.map((f) => `  - [${f.rule}] ${f.fix}`).join("\n");
		return `## Slide ${s.no}${s.title ? ` "${s.title.replace(/\s+/g, " ").slice(0, 60)}"` : ""}
Picture: ${SHOTS}/${s.no}.png · HTML: ${ref?.file ?? `slides/${s.id}.html`}
Text: ${slideText(per[i] || []) || "(no text)"}
Rule findings:${rules ? "\n" + rules : " none"}`;
	});
	return [
		`Review this deck: "${deck.title}", ${deck.slides.length} slides, ${deck.size.w}×${deck.size.h}px. Pictures are ${SHOT_W}px wide or less.`,
		style ? `The deck's house style, for reference (the app's rules already check it; use it to judge what is intentional):\n${style}` : "",
		r.note?.trim() ? `Additional instructions from the person for this check. Report every place that does not follow them (topic "instruction"):\n${r.note.trim()}` : "",
		slides.join("\n\n"),
	].filter(Boolean).join("\n\n");
}

// ── 합치기 ──

interface Answer {
	slides?: { no: number; findings?: Raw[]; dismiss?: { rule: string; reason: string }[] }[];
	deck?: (Raw & { slides?: number[] })[];
}
interface Raw { topic?: string; severity?: string; msg?: string; fix?: string; quote?: string }

const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
/** 짚은 글이 놓인 자리 — 그 글을 품은 요소 가운데 가장 작은 것(가장 안쪽). 못 찾으면 비운다(쪽 전체에 대한 말로 본다) */
export function quoteBoxes(nodes: Node[], quote?: string): Box[] {
	const q = norm(quote || "");
	if (q.length < 2) return [];
	const hit = nodes.filter((n) => n.text && norm(n.text).includes(q)).sort((a, b) => a.w * a.h - b.w * b.h)[0];
	if (!hit) return [];
	const b = hit.tbox ?? hit;
	return [{ x: b.x, y: b.y, w: b.w, h: b.h }];
}

const say = (k: Key, v: Record<string, string | number> = {}) => tNow(k).replace(/\{(\w+)\}/g, (_, n) => String(v[n] ?? ""));
const sev = (s?: string): Severity => (s === "high" || s === "low" ? s : "medium");
const topic = (t?: string): ReviewTopic => (TOPICS as readonly string[]).includes(t || "") ? (t as ReviewTopic) : "visual";
const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Claude 의 답(글)을 점검 결과에 넣는다. 답에서 JSON 을 못 꺼내면 throw. per — 쪽마다 규칙 점검이 잰 요소 (상자 찾기) */
export function mergeReview(r: AuditReport, per: Node[][], text: string): AuditReport {
	const json = text.match(/\{[\s\S]*\}/)?.[0];
	let a: Answer;
	try { a = JSON.parse(json || ""); } catch { throw new Error(tNow("reviewBadAnswer")); }
	const slides = r.slides.map((s) => ({ ...s, findings: [...s.findings] }));
	const at = (no: number) => slides.findIndex((s) => s.no === no);
	const make = (x: Raw, i: number, msg?: string): Finding | null => {
		if (!x.msg?.trim() || !x.fix?.trim()) return null;
		return { rule: `review:${topic(x.topic)}`, kind: "review", sev: sev(x.severity), msg: msg ?? x.msg.trim(), fix: x.fix.trim(), boxes: quoteBoxes(per[i] || [], x.quote) };
	};
	for (const s of a.slides || []) {
		const i = at(s.no);
		if (i < 0) continue;
		const own = (s.findings || []).slice(0, 5).map((x) => make(x, i)).filter((f): f is Finding => !!f);
		own.sort((p, q) => ORDER[p.sev!] - ORDER[q.sev!]);
		slides[i].findings.push(...own);
		// 의도라고 본 규칙 결과 — 지우지 않고 까닭을 달아 둔다. 고치기 요청 · 건수에서는 빠진다
		for (const d of s.dismiss || []) for (const f of slides[i].findings) if (f.kind !== "review" && f.rule === d.rule && !f.ok) f.ok = d.reason?.trim() || "-";
	}
	// 여러 쪽에 걸친 것 — 처음 쪽에 단다
	for (const x of a.deck || []) {
		const nos = (x.slides || []).filter((n) => at(n) >= 0);
		const i = nos.length ? at(nos[0]) : 0;
		if (!slides[i]) continue;
		const f = make(x, i, nos.length > 1 ? `${say("reviewAcross", { v: nos.join(" · ") })} ${x.msg?.trim()}` : undefined);
		if (f) slides[i].findings.push({ ...f, fix: nos.length > 1 ? `(across slides ${nos.join(", ")}) ${f.fix}` : f.fix });
	}
	return { ...r, slides };
}

// ── 돌리기 ──

let current = "";
let stopping = "";
/** 멈춤 — 도는 검토를 끈다. 규칙 점검 결과는 그대로 남는다 */
export const stopReview = () => { if (current) { stopping = current; api.claudeStop(current).catch(() => {}); } };

/** Claude 를 띄워 답을 받아 합친다. note — 진행 한 줄 (몇 쪽을 보는 중인지). 멈추면 null */
export async function runReview(dir: string, deck: Deck, r: AuditReport, per: Node[][], note: (t: string) => void): Promise<AuditReport | null> {
	const s = useSettings.getState().s;
	const turn = "r" + Date.now().toString(36);
	current = turn;
	let result = "";
	const un = await listen<{ turn: string; line: string }>("claude", (e) => {
		if (e.payload.turn !== turn) return;
		try {
			const m = JSON.parse(e.payload.line);
			if (m.type === "result") result = m.result || "";
			else if (m.type === "assistant") {
				for (const c of m.message?.content || []) {
					if (c.type !== "tool_use") continue;
					const no = /shots\/(\d+)\.png/.exec(String(c.input?.file_path ?? ""))?.[1];
					note(no ? say("reviewLooking", { n: no, of: deck.slides.length }) : say("reviewReading"));
				}
			}
		} catch { /* 줄 하나가 깨져도 다음 줄은 읽는다 */ }
	});
	try {
		note(say("reviewStarting"));
		const out = await api.claudeRun({
			turn, dir, mode: "review", system: reviewSystem(s.lang), prompt: reviewPrompt(deck, r, per, houseStyle(s, deck)),
			claudePath: s.claude.path, model: s.claude.model, effort: s.claude.effort,
		});
		if (!result) {
			if (stopping === turn) return null;
			throw new Error(out.stderr.trim().split("\n").slice(-2).join(" ") || `Claude exit ${out.code}`);
		}
	} finally {
		un();
		if (current === turn) current = "";
	}
	return mergeReview(r, per, result);
}
