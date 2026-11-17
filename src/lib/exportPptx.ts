// 웹 슬라이드 → PPTX. 쪽마다 화면 밖 iframe 에 1:1 로 그려 런타임(rt.js extract)이 잰 좌표로 PowerPoint 도형을 만든다.
// 상자 → 도형 · 글자 묶음 → 글상자 · 표 → 표 · 그림/SVG → 그림. 96px = 1in.
import PptxGenJS from "pptxgenjs";
import { api } from "./api";
import type { Deck } from "./deck";
import { ask, offscreen } from "./frames";

const IN = (px: number) => px / 96;
const PT = (px: number) => Math.round(px * 0.75 * 10) / 10;

// PowerPoint 는 「정확히」 줄 간격에서 첫 줄 기준선을 글상자 위에서 약 0.716 × 줄 높이 + 0.089 × 글자 크기 아래에 둔다.
// 브라우저는 글꼴의 위 · 아래 높이로 정한다 — 그 차이만큼 글상자를 옮겨야 글자가 같은 높이에 선다.
// 2026.11.17 : Pretendard 로 크기 12~56px × 줄 높이 1.0~1.8 의 28칸을 내보내 PowerPoint 쪽 그림과 견주어 맞췄다 (남은 어긋남 1px 안 — 줄 높이 1.0 은 글자가 상자 위로 넘쳐 재지 못했다).
const PPT_BASE_LH = 0.716;
const PPT_BASE_SZ = 0.089;
/** 위 두 항을 넣은 뒤에도 남던 한결같은 1px 위로 뜸 */
const PPT_BASE_PX = -0.9;

const dashOf = (d?: string | null) => (d === "dashed" ? "dash" : d === "dotted" ? "sysDot" : "solid") as "dash" | "sysDot" | "solid";

// 굵기 → 글꼴 이름. PowerPoint 는 한 가족 안에서 보통 · 굵게 둘만 고른다 — 500 · 600 같은 굵기는
// 「Pretendard Medium」 · 「Pretendard SemiBold」 처럼 따로 깔린 이름으로 골라야 웹과 같은 굵기가 된다.
const WEIGHT_NAMES: Record<number, string[]> = {
	100: ["Thin", "Hairline"], 200: ["ExtraLight", "UltraLight"], 300: ["Light"], 400: ["Regular"],
	500: ["Medium"], 600: ["SemiBold", "DemiBold"], 700: ["Bold"], 800: ["ExtraBold", "UltraBold"], 900: ["Black", "Heavy"],
};
let installedP: Promise<Set<string>> | null = null;
const installed = () => (installedP ||= api.fonts().then((l) => new Set(l.map((x) => x.toLowerCase())), () => new Set<string>()));
const GENERIC = new Set(["sans-serif", "serif", "monospace", "system-ui", "cursive", "fantasy", ""]);

interface FontCtx { have: Set<string>; missing: Set<string> }
function faceOf(list: string, weight: number, f: FontCtx): { face: string | undefined; bold: boolean } {
	const w = Math.min(900, Math.max(100, Math.round(weight / 100) * 100));
	const has = (n: string) => f.have.has(n.toLowerCase());
	const families = list.split("|").filter(Boolean);
	// 브라우저처럼 목록에서 이 PC 에 깔린 첫 글꼴을 고른다. 하나도 없으면 첫 글꼴을 쓰고 「없는 글꼴」로 알린다
	const family = families.find((x) => !GENERIC.has(x) && (has(x) || WEIGHT_NAMES[w].some((n) => has(`${x} ${n}`))));
	if (!family) {
		const first = families.find((x) => !GENERIC.has(x));
		if (!first) return { face: undefined, bold: weight >= 600 };
		f.missing.add(first);
		return { face: first, bold: w >= 600 };
	}
	if (w !== 400 && w !== 700) for (const n of WEIGHT_NAMES[w]) if (has(`${family} ${n}`)) return { face: `${family} ${n}`, bold: false };
	return { face: family, bold: w >= 600 };
}

/** 런타임이 잰 글자 조각 → pptxgenjs 글 조각. <br> 은 앞 조각의 줄바꿈이 된다 */
function toRuns(runs: any[], f: FontCtx) {
	return runs
		.map((r: any, j: number) => {
			if (r.br) return null;
			const next = runs[j + 1];
			const fc = faceOf(r.font || "", r.weight ?? (r.bold ? 700 : 400), f);
			return {
				text: r.text,
				options: {
					fontSize: PT(r.size), bold: fc.bold, italic: r.italic, color: r.color, fontFace: fc.face,
					charSpacing: r.spacing ? PT(r.spacing) : undefined,
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

/** data 는 날바이트 — base64 로 싸면 큰 덱에서 메모리가 몇 벌로 불어난다 (가져오기와 같은 까닭) */
export interface Built { data: Uint8Array; missingFonts: string[] }

/**
 * exact=true 면 쪽마다 웹을 2배로 구운 그림 한 장을 깔고, 그 위에 같은 자리의 글상자를 투명하게 얹는다.
 * 글자 획 가장자리까지 웹과 같다 — 대신 PowerPoint 에서 모양을 고치지 못한다(글은 찾기 · 복사만).
 */
export async function buildPptx(deck: Deck, projectId: string, progress: (i: number, n: number) => void, exact = false): Promise<Built> {
	const fonts: FontCtx = { have: await installed(), missing: new Set() };
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
		if (exact) {
			const { win, dispose } = await offscreen(projectId, ref.file, deck.size.w, deck.size.h);
			let snap: any;
			try { snap = await ask(win, { t: "snapshot", scale: 2 }, 60000); } finally { dispose(); }
			if (snap.error) throw new Error(`${i + 1}쪽: ${snap.error}`);
			slide.addImage({ data: snap.data.replace(/^data:/, ""), x: 0, y: 0, w: IN(deck.size.w), h: IN(deck.size.h) });
			if (ref.notes) slide.addNotes(ref.notes);
			for (const it of data.items) {
				if (it.type !== "text") continue;
				slide.addText(toRuns(it.runs, fonts).map((r: any) => ({ ...r, options: { ...r.options, transparency: 100 } })) as any, { x: IN(it.x), y: IN(it.y), w: IN(it.w * 1.04), h: IN(Math.max(it.h, 1)), margin: 0, valign: it.valign, fit: "none", wrap: true } as any);
			}
			continue;
		}
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
				// 위 맞춤일 때만 옮긴다 — 가운데 · 아래 맞춤은 PowerPoint 가 줄 묶음 전체를 상자 안에서 다시 놓는다
				const shift = it.baseline != null && it.lineHeight && it.valign === "top" ? it.baseline - (PPT_BASE_LH * it.lineHeight + PPT_BASE_SZ * it.size0 + PPT_BASE_PX) : 0;
				const runs = toRuns(it.runs, fonts);
				if (it.bullet && runs[0]) (runs[0] as any).options.bullet = true;
				slide.addText(runs as any, {
					x: IN(x), y: IN(it.y + shift), w: IN(it.w + extra), h: IN(Math.max(it.h, 1)),
					margin: 0, valign: it.valign, align: it.align === "justify" ? "justify" : it.align, fit: "none", wrap: true,
					lineSpacing: it.lineHeight ? PT(it.lineHeight) : undefined,
				} as any);
			} else if (it.type === "table") {
				const rows = it.rows.map((row: any[]) => row.map((c) => ({
					text: c.runs?.length ? toRuns(c.runs, fonts) : c.text,
					options: {
						fontSize: PT(c.size), bold: c.bold, color: c.color, fontFace: faceOf(c.font || "", c.bold ? 700 : 400, fonts).face, valign: c.valign,
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
	return { data: out, missingFonts: [...fonts.missing] };
}
