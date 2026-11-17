// 웹 슬라이드 → PPTX. 쪽마다 화면 밖 iframe 에 1:1 로 그려 런타임(rt.js extract)이 잰 좌표로 PowerPoint 도형을 만든다.
// 상자 → 도형 · 글자 묶음 → 글상자 · 표 → 표 · 그림/SVG → 그림. 96px = 1in.
import PptxGenJS from "pptxgenjs";
import { b64FromBytes } from "./api";
import type { Deck } from "./deck";
import { ask, offscreen } from "./frames";

const IN = (px: number) => px / 96;
const PT = (px: number) => Math.round(px * 0.75 * 10) / 10;

const dashOf = (d?: string | null) => (d === "dashed" ? "dash" : d === "dotted" ? "sysDot" : "solid") as "dash" | "sysDot" | "solid";

/** 런타임이 잰 글자 조각 → pptxgenjs 글 조각. <br> 은 앞 조각의 줄바꿈이 된다 */
function toRuns(runs: any[]) {
	return runs
		.map((r: any, j: number) => {
			if (r.br) return null;
			const next = runs[j + 1];
			return {
				text: r.text,
				options: {
					fontSize: PT(r.size), bold: r.bold, italic: r.italic, color: r.color, fontFace: r.font || undefined,
					underline: r.underline ? { style: "sng" } : undefined, strike: r.strike ? "sngStrike" : undefined,
					transparency: r.alpha != null && r.alpha < 1 ? Math.round((1 - r.alpha) * 100) : undefined,
					breakLine: !!next?.br,
					// 브라우저가 줄을 바꾼 자리 — 같은 문단 안 줄 바꿈
					softBreakBefore: !!r.soft && j > 0 && !runs[j - 1]?.br,
				},
			};
		})
		.filter(Boolean) as any[];
}

export async function buildPptx(deck: Deck, projectId: string, progress: (i: number, n: number) => void): Promise<string> {
	const pptx = new PptxGenJS();
	pptx.defineLayout({ name: "DECK", width: IN(deck.size.w), height: IN(deck.size.h) });
	pptx.layout = "DECK";
	pptx.title = deck.title;

	for (let i = 0; i < deck.slides.length; i++) {
		progress(i, deck.slides.length);
		const ref = deck.slides[i];
		// 숨은 iframe 이 가끔 답하지 않는다 (2026.11.17 실측 — 같은 쪽을 다시 띄우면 1초 안에 끝났다). 새로 띄워 두 번까지 묻는다
		let res: any;
		for (let attempt = 0; ; attempt++) {
			const { win, dispose } = await offscreen(projectId, ref.file, deck.size.w, deck.size.h);
			try { res = await ask(win, { t: "extract" }, 20000); break; }
			catch (e) { if (attempt >= 1) throw e; }
			finally { dispose(); }
		}
		if (res.error) throw new Error(`${i + 1}쪽: ${res.error}`);
		const data = res.data;
		const slide = pptx.addSlide();
		if (data.background) slide.background = { color: data.background.hex };
		if (ref.notes) slide.addNotes(ref.notes);
		for (const it of data.items) {
			if (it.type === "box") {
				const isRound = it.round;
				const shape = isRound ? pptx.ShapeType.ellipse : it.radius > 0.5 ? pptx.ShapeType.roundRect : pptx.ShapeType.rect;
				slide.addShape(shape, {
					x: IN(it.x), y: IN(it.y), w: IN(it.w), h: IN(it.h),
					fill: it.fill ? { color: it.fill.hex, transparency: Math.round((1 - it.fill.alpha) * 100) } : { type: "none" },
					line: it.line ? { color: it.line.hex, width: PT(it.line.w), dashType: dashOf(it.line.dash), transparency: Math.round((1 - it.line.alpha) * 100) } : { type: "none" },
					rectRadius: !isRound && it.radius > 0.5 ? IN(Math.min(it.radius, Math.min(it.w, it.h) / 2)) : undefined,
				} as any);
			} else if (it.type === "line") {
				slide.addShape(pptx.ShapeType.line, {
					x: IN(Math.min(it.x1, it.x2)), y: IN(Math.min(it.y1, it.y2)), w: IN(Math.abs(it.x2 - it.x1)), h: IN(Math.abs(it.y2 - it.y1)),
					line: { color: it.color, width: PT(it.w), dashType: dashOf(it.dash) },
				});
			} else if (it.type === "image") {
				slide.addImage({ data: it.data.replace(/^data:/, ""), x: IN(it.x), y: IN(it.y), w: IN(it.w), h: IN(it.h), altText: it.alt || undefined });
			} else if (it.type === "text") {
				// PowerPoint 는 같은 글꼴도 브라우저보다 조금 넓게 그린다 — 줄바꿈이 달라지지 않게 너비를 4% 넓힌다 (정렬 방향 반대쪽으로)
				const extra = it.w * 0.04;
				const x = it.align === "center" ? it.x - extra / 2 : it.align === "right" ? it.x - extra : it.x;
				const runs = toRuns(it.runs);
				if (it.bullet && runs[0]) (runs[0] as any).options.bullet = true;
				slide.addText(runs as any, {
					x: IN(x), y: IN(it.y), w: IN(it.w + extra), h: IN(Math.max(it.h, 1)),
					margin: 0, valign: it.valign, align: it.align === "justify" ? "justify" : it.align, fit: "none", wrap: true,
					lineSpacing: it.lineHeight ? PT(it.lineHeight) : undefined,
				} as any);
			} else if (it.type === "table") {
				const rows = it.rows.map((row: any[]) => row.map((c) => ({
					text: c.runs?.length ? toRuns(c.runs) : c.text,
					options: {
						fontSize: PT(c.size), bold: c.bold, color: c.color, fontFace: c.font || undefined, valign: c.valign,
						fill: c.fill ? { color: c.fill } : undefined, align: c.align === "center" ? "center" : c.align === "right" ? "right" : "left",
						colspan: c.colspan > 1 ? c.colspan : undefined, rowspan: c.rowspan > 1 ? c.rowspan : undefined,
						border: c.border && c.bw ? [{ type: "solid", pt: PT(c.bw), color: c.border }, { type: "solid", pt: PT(c.bw), color: c.border }, { type: "solid", pt: PT(c.bw), color: c.border }, { type: "solid", pt: PT(c.bw), color: c.border }] : undefined,
						margin: c.pad ? c.pad.map((v: number) => PT(v)) : 3,
					},
				})));
				slide.addTable(rows, { x: IN(it.x), y: IN(it.y), w: IN(it.w), colW: it.colW.map(IN), rowH: it.rowH.map(IN) } as any);
			}
		}
	}
	progress(deck.slides.length, deck.slides.length);
	const out = (await pptx.write({ outputType: "uint8array" })) as Uint8Array;
	return b64FromBytes(out);
}
