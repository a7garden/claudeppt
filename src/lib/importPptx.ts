// PPTX → 웹 슬라이드. 원본을 최대한 같은 모양의 HTML(절대 위치)로 옮긴다.
//
// 목차
//   readPptx        zip 을 풀고 쪽 순서 · 크기 · 테마(색 · 글꼴)를 읽는다
//   convertSlide    마스터 → 레이아웃 → 쪽 순서로 도형을 그린다. 자리 표시자(placeholder)는 위치 · 글자 서식을 위에서 물려받는다
//   shapeHtml       도형 · 글상자 · 그림 · 그룹 · 표 · 연결선
//   importPptx      프로젝트 폴더에 파일로 쓴다 (그림은 assets/, 원본은 source/original.pptx)
//
// 못 옮기는 것(차트 · SmartArt · 수식 · 애니메이션)은 자리만 점선 상자로 남긴다. 그런 쪽은 원본 쪽 그림(source/pages)을 보고
// Claude 에게 「원본과 같게」 다듬기를 맡긴다. 좌표는 EMU → px 로, 가로를 1280px 에 맞춰 늘이거나 줄인다.

import JSZip from "jszip";
import { api } from "./api";
import { type Deck, FORMAT, embedFont, escapeHtml, newId, slideHtml, themeCss, writeDeck } from "./deck";
import type { Settings } from "./settings";

type El = Element;
const kids = (el: El | null | undefined, name?: string): El[] => (el ? [...el.children].filter((c) => !name || c.tagName === name) : []);
const kid = (el: El | null | undefined, name: string): El | null => kids(el, name)[0] || null;
const path = (el: El | null | undefined, ...names: string[]): El | null => {
	let e: El | null | undefined = el;
	for (const n of names) e = kid(e, n);
	return e || null;
};
/** 1pt = 12700 EMU */
const PT = 12700;
const num = (v: string | null | undefined, d = 0) => (v == null || v === "" ? d : +v);

interface Theme { colors: Record<string, string>; major: string; minor: string; majorEa: string; minorEa: string }
interface Ctx {
	zip: JSZip;
	k: number; // EMU → px
	theme: Theme;
	clrMap: Record<string, string>;
	dir: string;
	media: Map<string, string>; // zip 경로 → assets 상대 경로
	defaults: { title: TextDefaults; body: TextDefaults[]; other: TextDefaults };
	warnings: Set<string>;
	slideNo: number;
}
/** spc = 자간(1/100 pt). 한글 PPT 는 대부분 음수 자간을 준다 — 빼면 글이 넓어져 원본과 다른 자리에서 줄이 바뀐다 */
interface TextDefaults { size?: number; color?: string; bold?: boolean; font?: string; align?: string; spc?: number }

// 레이아웃 · 마스터 · 테마는 쪽마다 같은 것을 다시 읽는다 — 한 번 푼 것을 가져오기가 끝날 때까지 둔다.
// 쪽 XML 은 담지 않는다 (수백 쪽이면 메모리만 먹는다). 읽기만 하는 DOM 이라 나눠 써도 된다.
const shared = new WeakMap<JSZip, Map<string, Promise<Document | null>>>();
const SHARED = /\/(slideLayouts|slideMasters|theme)\//;
async function xml(zip: JSZip, p: string): Promise<Document | null> {
	const parse = async () => {
		const f = zip.file(p);
		return f ? new DOMParser().parseFromString(await f.async("string"), "application/xml") : null;
	};
	if (!SHARED.test(p)) return parse();
	let m = shared.get(zip);
	if (!m) shared.set(zip, (m = new Map()));
	if (!m.has(p)) m.set(p, parse());
	return m.get(p)!;
}

async function rels(zip: JSZip, part: string): Promise<Record<string, string>> {
	const dir = part.slice(0, part.lastIndexOf("/"));
	const name = part.slice(part.lastIndexOf("/") + 1);
	const doc = await xml(zip, `${dir}/_rels/${name}.rels`);
	const out: Record<string, string> = {};
	if (!doc) return out;
	for (const r of doc.getElementsByTagName("Relationship")) {
		const t = r.getAttribute("Target") || "";
		out[r.getAttribute("Id")!] = r.getAttribute("TargetMode") === "External" ? t : resolve(dir, t);
	}
	return out;
}
const resolve = (base: string, rel: string) => {
	if (rel.startsWith("/")) return rel.slice(1);
	const parts = base.split("/");
	for (const s of rel.split("/")) {
		if (s === "..") parts.pop();
		else if (s !== ".") parts.push(s);
	}
	return parts.join("/");
};

// ── 색 ──
function colorOf(el: El | null, ctx: Ctx, phClr?: string): string | null {
	if (!el) return null;
	const c = el.children[0];
	if (!c) return null;
	let hex: string | null = null;
	let alpha = 1;
	if (c.tagName === "a:srgbClr") hex = c.getAttribute("val");
	else if (c.tagName === "a:schemeClr") {
		const v = c.getAttribute("val")!;
		if (v === "phClr") hex = phClr || null;
		else hex = ctx.theme.colors[ctx.clrMap[v] || v] || null;
	} else if (c.tagName === "a:sysClr") hex = c.getAttribute("lastClr") || (c.getAttribute("val") === "window" ? "FFFFFF" : "000000");
	else if (c.tagName === "a:prstClr") hex = ({ black: "000000", white: "FFFFFF", red: "FF0000", blue: "0000FF", green: "00FF00", gray: "808080" } as Record<string, string>)[c.getAttribute("val")!] || "000000";
	if (!hex) return null;
	let [r, g, b] = [0, 2, 4].map((i) => parseInt(hex!.slice(i, i + 2), 16));
	for (const m of c.children) {
		const v = num(m.getAttribute("val")) / 100000;
		if (m.tagName === "a:lumMod" || m.tagName === "a:lumOff") {
			let [h, s, l] = rgbToHsl(r, g, b);
			l = m.tagName === "a:lumMod" ? l * v : l + v;
			[r, g, b] = hslToRgb(h, s, Math.max(0, Math.min(1, l)));
		} else if (m.tagName === "a:tint") [r, g, b] = [r, g, b].map((x) => x + (255 - x) * (1 - v));
		else if (m.tagName === "a:shade") [r, g, b] = [r, g, b].map((x) => x * v);
		else if (m.tagName === "a:alpha") alpha = v;
	}
	const h = [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");
	return alpha < 1 ? `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha.toFixed(2)})` : "#" + h;
}
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
	r /= 255; g /= 255; b /= 255;
	const max = Math.max(r, g, b), min = Math.min(r, g, b);
	let h = 0, s = 0;
	const l = (max + min) / 2;
	if (max !== min) {
		const d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
		h /= 6;
	}
	return [h, s, l];
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	if (s === 0) return [l * 255, l * 255, l * 255];
	const f = (p: number, q: number, t: number) => {
		if (t < 0) t += 1;
		if (t > 1) t -= 1;
		if (t < 1 / 6) return p + (q - p) * 6 * t;
		if (t < 1 / 2) return q;
		if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
		return p;
	};
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
	return [f(p, q, h + 1 / 3) * 255, f(p, q, h) * 255, f(p, q, h - 1 / 3) * 255];
}

function fillOf(spPr: El | null, ctx: Ctx, style: El | null): string | null | "none" {
	if (spPr) {
		if (kid(spPr, "a:noFill")) return "none";
		const s = kid(spPr, "a:solidFill");
		if (s) return colorOf(s, ctx);
		const g = kid(spPr, "a:gradFill");
		if (g) {
			const stops = [...g.getElementsByTagName("a:gs")].map((gs) => ({ pos: num(gs.getAttribute("pos")) / 1000, c: colorOf(gs, ctx) })).filter((x) => x.c);
			if (stops.length) {
				const ang = num(path(g, "a:lin")?.getAttribute("ang")) / 60000;
				return `linear-gradient(${ang + 90}deg, ${stops.map((s) => `${s.c} ${s.pos}%`).join(", ")})`;
			}
		}
	}
	const ref = path(style, "a:fillRef");
	if (ref && num(ref.getAttribute("idx")) > 0) return colorOf(ref, ctx);
	return null;
}

function lineOf(spPr: El | null, ctx: Ctx, style: El | null): { w: number; c: string; dash: boolean } | null {
	const ln = kid(spPr, "a:ln");
	if (ln && kid(ln, "a:noFill")) return null;
	let c = ln ? colorOf(kid(ln, "a:solidFill"), ctx) : null;
	if (!c) {
		const ref = path(style, "a:lnRef");
		if (ref && num(ref.getAttribute("idx")) > 0) c = colorOf(ref, ctx);
	}
	if (!c) return null;
	const w = Math.max(0.75, num(ln?.getAttribute("w"), 9525) * ctx.k);
	const dash = !!ln && ["dash", "sysDash", "dot", "sysDot", "lgDash", "dashDot"].includes(path(ln, "a:prstDash")?.getAttribute("val") || "");
	return { w, c, dash };
}

// ── 위치 ──
interface Box { x: number; y: number; w: number; h: number; rot: number; flipH: boolean; flipV: boolean }
type Tx = (b: Box) => Box;
function xfrmOf(x: El | null, ctx: Ctx, tx: Tx): Box | null {
	if (!x) return null;
	const off = kid(x, "a:off"), ext = kid(x, "a:ext");
	if (!off || !ext) return null;
	return tx({
		x: num(off.getAttribute("x")) * ctx.k,
		y: num(off.getAttribute("y")) * ctx.k,
		w: num(ext.getAttribute("cx")) * ctx.k,
		h: num(ext.getAttribute("cy")) * ctx.k,
		rot: num(x.getAttribute("rot")) / 60000,
		flipH: x.getAttribute("flipH") === "1",
		flipV: x.getAttribute("flipV") === "1",
	});
}
const posCss = (b: Box) => `position:absolute;left:${r1(b.x)}px;top:${r1(b.y)}px;width:${r1(b.w)}px;height:${r1(b.h)}px` + (b.rot ? `;transform:rotate(${r1(b.rot)}deg)` : "");
const r1 = (v: number) => Math.round(v * 10) / 10;

// ── 글자 ──
interface PhInfo { box: Box | null; body: El | null; type: string }
function phKey(sp: El) {
	const ph = path(sp, "p:nvSpPr", "p:nvPr", "p:ph") || path(sp, "p:nvPicPr", "p:nvPr", "p:ph");
	if (!ph) return null;
	return { type: ph.getAttribute("type") || "body", idx: ph.getAttribute("idx") || "" };
}
function findPh(tree: El | null, key: { type: string; idx: string }): El | null {
	if (!tree) return null;
	const sps = [...tree.getElementsByTagName("p:sp")];
	const norm = (t: string) => (t === "ctrTitle" ? "title" : t === "subTitle" ? "body" : t);
	return (
		(key.idx && sps.find((s) => phKey(s)?.idx === key.idx)) ||
		sps.find((s) => { const k = phKey(s); return k && norm(k.type) === norm(key.type); }) ||
		null
	);
}

function textDefaultsOf(lvl: El | null, ctx: Ctx): TextDefaults {
	const d = kid(lvl, "a:defRPr");
	const out: TextDefaults = {};
	if (d?.getAttribute("sz")) out.size = num(d.getAttribute("sz")) / 100;
	if (d?.getAttribute("spc")) out.spc = num(d.getAttribute("spc"));
	if (d?.getAttribute("b")) out.bold = d.getAttribute("b") === "1";
	const c = colorOf(kid(d, "a:solidFill"), ctx);
	if (c) out.color = c;
	const f = path(d, "a:latin")?.getAttribute("typeface") || path(d, "a:ea")?.getAttribute("typeface");
	if (f) out.font = f;
	if (lvl?.getAttribute("algn")) out.align = lvl.getAttribute("algn")!;
	return out;
}

/** 글꼴 이름은 원본 PPTX 에 적힌 그대로 둔다(한글 이름 포함). 웹뷰가 그 이름을 알아보게 하는 것은 fonts.ts 의 별칭(@font-face)이 맡는다 —
 *  이름을 바꿔 적으면 내보낸 PPTX 에도 바뀐 이름이 들어가 원본과 달라진다. */
function fontName(f: string | undefined | null, ctx: Ctx) {
	if (!f) return null;
	if (f === "+mj-lt") return ctx.theme.major;
	if (f === "+mn-lt") return ctx.theme.minor;
	if (f === "+mj-ea") return ctx.theme.majorEa || ctx.theme.major;
	if (f === "+mn-ea") return ctx.theme.minorEa || ctx.theme.minor;
	return f;
}

function textHtml(txBody: El, ctx: Ctx, inh: TextDefaults[]): { html: string; anchor: string; ins: number[] } {
	const bodyPr = kid(txBody, "a:bodyPr");
	const anchor = bodyPr?.getAttribute("anchor") || "t";
	const ins = ["lIns", "tIns", "rIns", "bIns"].map((a, i) => num(bodyPr?.getAttribute(a), i % 2 ? 45720 : 91440) * ctx.k);
	const scale = num(path(bodyPr, "a:normAutofit")?.getAttribute("fontScale"), 100000) / 100000;
	const lst = kid(txBody, "a:lstStyle");
	const ps: string[] = [];
	const autoNum: number[] = [];
	for (const p of kids(txBody, "a:p")) {
		const pPr = kid(p, "a:pPr");
		const lvl = num(pPr?.getAttribute("lvl"));
		const lstLvl = kid(lst, `a:lvl${lvl + 1}pPr`);
		const own = textDefaultsOf(lstLvl, ctx);
		// 문단 자체의 기본 글자 서식(a:pPr/a:defRPr)이 가장 가깝다 — 목록 서식 · 자리 표시자 서식보다 먼저
		const base = { ...(inh[lvl] || inh[0] || {}), ...strip(own), ...strip(textDefaultsOf(pPr, ctx)) };
		const algn = pPr?.getAttribute("algn") || base.align || "l";
		const align = ({ l: "left", ctr: "center", r: "right", just: "justify", dist: "justify" } as Record<string, string>)[algn] || "left";
		const marL = num(pPr?.getAttribute("marL") ?? lstLvl?.getAttribute("marL")) * ctx.k;
		const indent = num(pPr?.getAttribute("indent") ?? lstLvl?.getAttribute("indent")) * ctx.k;
		const lnPct = path(pPr, "a:lnSpc", "a:spcPct")?.getAttribute("val");
		const spcBef = path(pPr, "a:spcBef", "a:spcPts")?.getAttribute("val");
		const spcAft = path(pPr, "a:spcAft", "a:spcPts")?.getAttribute("val");
		let firstSize = base.size || 18;
		const runs: string[] = [];
		for (const r of p.children) {
			if (r.tagName === "a:br") { runs.push("<br>"); continue; }
			if (r.tagName !== "a:r" && r.tagName !== "a:fld") continue;
			const rPr = kid(r, "a:rPr");
			const t = r.tagName === "a:fld" && r.getAttribute("type") === "slidenum" ? String(ctx.slideNo) : kid(r, "a:t")?.textContent ?? "";
			const size = (num(rPr?.getAttribute("sz")) / 100 || base.size || 18) * scale;
			if (!runs.length) firstSize = size;
			const bold = rPr?.getAttribute("b") ? rPr.getAttribute("b") === "1" : base.bold;
			const italic = rPr?.getAttribute("i") === "1";
			const u = rPr?.getAttribute("u") && rPr.getAttribute("u") !== "none";
			const strike = rPr?.getAttribute("strike") && rPr.getAttribute("strike") !== "noStrike";
			const color = colorOf(kid(rPr, "a:solidFill"), ctx) || base.color;
			const latin = fontName(path(rPr, "a:latin")?.getAttribute("typeface"), ctx);
			const ea = fontName(path(rPr, "a:ea")?.getAttribute("typeface"), ctx);
			const fam = [latin, ea, fontName(base.font, ctx)].filter(Boolean).map((f) => `'${f}'`);
			const st = [`font-size:${r1(size * PT * ctx.k)}px`];
			if (bold) st.push("font-weight:700");
			if (italic) st.push("font-style:italic");
			const spc = rPr?.getAttribute("spc") != null ? num(rPr.getAttribute("spc")) : base.spc || 0;
			if (spc) st.push(`letter-spacing:${r1((spc / 100) * PT * ctx.k)}px`);
			if (u || strike) st.push(`text-decoration:${[u && "underline", strike && "line-through"].filter(Boolean).join(" ")}`);
			if (color) st.push(`color:${color}`);
			if (fam.length) st.push(`font-family:${fam.join(",")},var(--font)`);
			const sup = num(rPr?.getAttribute("baseline"));
			if (sup) st.push(`vertical-align:${sup > 0 ? "super" : "sub"};font-size:${r1(size * 0.65 * PT * ctx.k)}px`);
			runs.push(`<span style="${st.join(";")}">${escapeHtml(t)}</span>`);
		}
		// 글머리
		let bullet = "";
		const bu = kid(pPr, "a:buChar") || kid(lstLvl, "a:buChar");
		const an = kid(pPr, "a:buAutoNum") || kid(lstLvl, "a:buAutoNum");
		const none = kid(pPr, "a:buNone");
		if (!none && (bu || an) && runs.length) {
			if (an) { autoNum[lvl] = (autoNum[lvl] || num(an.getAttribute("startAt"), 1) - 1) + 1; bullet = `${autoNum[lvl]}.`; }
			else bullet = bu!.getAttribute("char") || "•";
			if (bullet === "Ø" || bullet === "§" || bullet === "ü") bullet = "•";
		}
		// 빈 문단의 높이는 문단 끝 서식(endParaRPr)의 크기다 — PowerPoint 가 빈 줄을 그 크기로 띄운다
		if (!runs.length) {
			const end = num(kid(p, "a:endParaRPr")?.getAttribute("sz")) / 100;
			if (end) firstSize = end * scale;
		}
		const pxSize = firstSize * PT * ctx.k;
		// 문단 글자 크기를 첫 조각 크기로 준다. 안 주면 문단이 덱 기본 크기(24px)를 물려받아, 글이 작아도 줄마다 24px × 줄 간격 높이를 차지한다
		// (2026.11.18 16px 글이 줄마다 29px 씩 벌어져 칸을 넘쳤다)
		const pst = [`text-align:${align}`, `margin:0`, `padding-left:${r1(marL)}px`, `text-indent:${r1(indent)}px`, `font-size:${r1(pxSize)}px`];
		if (lnPct) pst.push(`line-height:${num(lnPct) / 100000 * 1.2}`);
		if (spcBef) pst.push(`margin-top:${r1(num(spcBef) / 100 * PT * ctx.k)}px`);
		if (spcAft) pst.push(`margin-bottom:${r1(num(spcAft) / 100 * PT * ctx.k)}px`);
		if (!runs.length) { ps.push(`<p style="${pst.join(";")};min-height:1em"></p>`); continue; }
		ps.push(`<p style="${pst.join(";")}">${bullet ? `<span style="display:inline-block;min-width:${r1(Math.max(0, -indent))}px;font-size:${r1(pxSize)}px">${escapeHtml(bullet)}</span>` : ""}${runs.join("")}</p>`);
	}
	return { html: ps.join(""), anchor, ins };
}

// ── 도형 그림 (사각형 · 둥근 사각형 · 타원 밖의 프리셋) ──
function presetSvg(prst: string, w: number, h: number, fill: string, line: { w: number; c: string; dash: boolean } | null): string | null {
	const s = line ? `stroke="${line.c}" stroke-width="${r1(line.w)}"${line.dash ? ' stroke-dasharray="6 4"' : ""}` : "";
	const f = fill === "none" ? "none" : fill;
	const P = (pts: number[][]) => `<polygon points="${pts.map((p) => p.map(r1).join(",")).join(" ")}" fill="${f}" ${s}/>`;
	let body: string | null = null;
	const a = Math.min(w, h);
	switch (prst) {
		case "triangle": body = P([[w / 2, 0], [w, h], [0, h]]); break;
		case "rtTriangle": body = P([[0, 0], [w, h], [0, h]]); break;
		case "diamond": body = P([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]); break;
		case "parallelogram": body = P([[a * 0.25, 0], [w, 0], [w - a * 0.25, h], [0, h]]); break;
		case "trapezoid": body = P([[a * 0.25, 0], [w - a * 0.25, 0], [w, h], [0, h]]); break;
		case "pentagon": case "homePlate": body = P([[0, 0], [w - h / 2, 0], [w, h / 2], [w - h / 2, h], [0, h]]); break;
		case "chevron": body = P([[0, 0], [w - h / 2, 0], [w, h / 2], [w - h / 2, h], [0, h], [h / 2, h / 2]]); break;
		case "hexagon": body = P([[a * 0.25, 0], [w - a * 0.25, 0], [w, h / 2], [w - a * 0.25, h], [a * 0.25, h], [0, h / 2]]); break;
		case "octagon": { const c = a * 0.29; body = P([[c, 0], [w - c, 0], [w, c], [w, h - c], [w - c, h], [c, h], [0, h - c], [0, c]]); break; }
		case "rightArrow": body = P([[0, h * 0.25], [w - h / 2, h * 0.25], [w - h / 2, 0], [w, h / 2], [w - h / 2, h], [w - h / 2, h * 0.75], [0, h * 0.75]]); break;
		case "leftArrow": body = P([[w, h * 0.25], [h / 2, h * 0.25], [h / 2, 0], [0, h / 2], [h / 2, h], [h / 2, h * 0.75], [w, h * 0.75]]); break;
		case "upArrow": body = P([[w * 0.25, h], [w * 0.25, w / 2], [0, w / 2], [w / 2, 0], [w, w / 2], [w * 0.75, w / 2], [w * 0.75, h]]); break;
		case "downArrow": body = P([[w * 0.25, 0], [w * 0.75, 0], [w * 0.75, h - w / 2], [w, h - w / 2], [w / 2, h], [0, h - w / 2], [w * 0.25, h - w / 2]]); break;
		case "plus": case "mathPlus": { const t = a * 0.3; body = P([[(w - t) / 2, 0], [(w + t) / 2, 0], [(w + t) / 2, (h - t) / 2], [w, (h - t) / 2], [w, (h + t) / 2], [(w + t) / 2, (h + t) / 2], [(w + t) / 2, h], [(w - t) / 2, h], [(w - t) / 2, (h + t) / 2], [0, (h + t) / 2], [0, (h - t) / 2], [(w - t) / 2, (h - t) / 2]]); break; }
		case "star5": {
			const pts: number[][] = [];
			for (let i = 0; i < 10; i++) { const r = i % 2 ? 0.38 : 0.5, an = -Math.PI / 2 + (i * Math.PI) / 5; pts.push([w / 2 + Math.cos(an) * w * r, h / 2 + Math.sin(an) * h * r]); }
			body = P(pts); break;
		}
		case "donut": body = `<circle cx="${w / 2}" cy="${h / 2}" r="${a * 0.375}" fill="none" stroke="${f}" stroke-width="${a * 0.25}"/>`; break;
		case "flowChartProcess": return null;
		case "flowChartDecision": body = P([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]); break;
		case "flowChartTerminator": return null;
	}
	if (!body) return null;
	return `<svg width="${r1(w)}" height="${r1(h)}" viewBox="0 0 ${r1(w)} ${r1(h)}" style="position:absolute;left:0;top:0;overflow:visible">${body}</svg>`;
}

async function mediaPath(ctx: Ctx, zipPath: string): Promise<string | null> {
	if (ctx.media.has(zipPath)) return ctx.media.get(zipPath)!;
	const f = ctx.zip.file(zipPath);
	if (!f) return null;
	const name = zipPath.split("/").pop()!.toLowerCase();
	const ext = name.split(".").pop();
	if (ext === "emf" || ext === "wmf") { ctx.warnings.add("emf"); return null; }
	const rel = `assets/${name}`;
	await api.writeBytes(ctx.dir, rel, await f.async("uint8array"));
	ctx.media.set(zipPath, "../" + rel);
	return "../" + rel;
}

// ── 도형 하나 → HTML ──
async function shapeHtml(el: El, ctx: Ctx, rel: Record<string, string>, tx: Tx, layer: { layoutTree: El | null; masterTree: El | null; inh: (key: { type: string; idx: string } | null) => { ph: PhInfo | null; defaults: TextDefaults[]; kind: "title" | "body" | "other" } }, isSlide: boolean): Promise<string> {
	const tag = el.tagName;
	if (tag === "p:grpSp") {
		const x = path(el, "p:grpSpPr", "a:xfrm");
		const off = kid(x, "a:off"), ext = kid(x, "a:ext"), chOff = kid(x, "a:chOff"), chExt = kid(x, "a:chExt");
		let inner: Tx = tx;
		if (off && ext && chOff && chExt) {
			const sx = num(ext.getAttribute("cx")) / (num(chExt.getAttribute("cx")) || 1), sy = num(ext.getAttribute("cy")) / (num(chExt.getAttribute("cy")) || 1);
			const ox = num(off.getAttribute("x")) * ctx.k, oy = num(off.getAttribute("y")) * ctx.k, cx = num(chOff.getAttribute("x")) * ctx.k, cy = num(chOff.getAttribute("y")) * ctx.k;
			inner = (b) => tx({ ...b, x: ox + (b.x - cx) * sx, y: oy + (b.y - cy) * sy, w: b.w * sx, h: b.h * sy });
		}
		const parts: string[] = [];
		for (const c of el.children) parts.push(await shapeHtml(c, ctx, rel, inner, layer, isSlide));
		return parts.join("\n");
	}
	if (tag === "p:sp") {
		const key = phKey(el);
		// 마스터 · 레이아웃의 자리 표시자는 빈 틀이다 — 쪽에서 채운 것만 그린다
		if (key && !isSlide) return "";
		const info = layer.inh(key);
		const spPr = kid(el, "p:spPr");
		const style = kid(el, "p:style");
		let box = xfrmOf(kid(spPr, "a:xfrm"), ctx, tx) || info.ph?.box || null;
		if (!box) return "";
		const prst = path(spPr, "a:prstGeom")?.getAttribute("prst") || (kid(spPr, "a:custGeom") ? "custom" : "rect");
		const fill = fillOf(spPr, ctx, style) || (info.ph?.body ? fillOf(info.ph.body, ctx, null) : null);
		const line = lineOf(spPr, ctx, style);
		const st = [posCss(box)];
		let svg: string | null = null;
		const solid = fill && fill !== "none" ? fill : null;
		if (prst === "rect" || prst === "roundRect" || prst === "ellipse" || prst === "flowChartProcess" || prst === "flowChartTerminator" || prst === "custom" || prst === "snip1Rect" || prst === "round1Rect" || prst === "round2SameRect") {
			if (solid) st.push(`background:${solid}`);
			if (line) st.push(`border:${r1(line.w)}px ${line.dash ? "dashed" : "solid"} ${line.c}`);
			if (prst === "ellipse") st.push("border-radius:50%");
			if (prst === "roundRect" || prst === "flowChartTerminator") {
				const adj = num(path(spPr, "a:prstGeom", "a:avLst", "a:gd")?.getAttribute("fmla")?.replace("val ", ""), prst === "flowChartTerminator" ? 50000 : 16667);
				st.push(`border-radius:${r1(Math.min(box.w, box.h) * adj / 100000)}px`);
			}
			if (prst === "custom") ctx.warnings.add("custGeom");
		} else {
			svg = presetSvg(prst, box.w, box.h, fill || "none", line);
			if (!svg) { if (solid) st.push(`background:${solid}`); if (line) st.push(`border:${r1(line.w)}px solid ${line.c}`); }
		}
		const txBody = kid(el, "p:txBody");
		let text = "";
		if (txBody && txBody.textContent?.trim()) {
			const fontRef = path(style, "a:fontRef");
			const refColor = fontRef ? colorOf(fontRef, ctx) : null;
			const defs = info.defaults.map((d) => ({ ...d, color: d.color || refColor || undefined }));
			const t = textHtml(txBody, ctx, defs.length ? defs : [{ color: refColor || undefined }]);
			const phBody = info.ph?.body ? kid(info.ph.body, "a:bodyPr") : null;
			const anchor = kid(txBody, "a:bodyPr")?.getAttribute("anchor") || phBody?.getAttribute("anchor") || (info.kind === "title" ? "ctr" : t.anchor);
			const jc = ({ t: "flex-start", ctr: "center", b: "flex-end" } as Record<string, string>)[anchor] || "flex-start";
			text = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;justify-content:${jc};padding:${t.ins.map((v) => r1(v) + "px").join(" ").replace(/^(\S+) (\S+) (\S+) (\S+)$/, "$2 $3 $4 $1")};line-height:1.2">${t.html}</div>`;
		}
		if (!svg && !text && !solid && !line) return "";
		return `<div style="${st.join(";")}">${svg || ""}${text}</div>`;
	}
	if (tag === "p:pic") {
		const box = xfrmOf(path(el, "p:spPr", "a:xfrm"), ctx, tx);
		if (!box) return "";
		const blip = path(el, "p:blipFill", "a:blip");
		const svgBlip = blip?.getElementsByTagName("asvg:svgBlip")[0];
		const rid = svgBlip?.getAttribute("r:embed") || blip?.getAttribute("r:embed");
		const src = rid && rel[rid] ? await mediaPath(ctx, rel[rid]) : null;
		if (!src) return `<div style="${posCss(box)};border:1px dashed #b9b9b9"></div>`;
		const crop = path(el, "p:blipFill", "a:srcRect");
		let img = `<img src="${src}" alt="" style="${posCss(box)};object-fit:fill">`;
		if (crop && ["l", "t", "r", "b"].some((a) => crop.getAttribute(a))) {
			const [l, t, r, b] = ["l", "t", "r", "b"].map((a) => num(crop.getAttribute(a)) / 100000);
			const fw = box.w / (1 - l - r), fh = box.h / (1 - t - b);
			img = `<div style="${posCss(box)};overflow:hidden"><img src="${src}" alt="" style="position:absolute;left:${r1(-l * fw)}px;top:${r1(-t * fh)}px;width:${r1(fw)}px;height:${r1(fh)}px"></div>`;
		}
		return img;
	}
	if (tag === "p:cxnSp") {
		const box = xfrmOf(path(el, "p:spPr", "a:xfrm"), ctx, tx);
		if (!box) return "";
		const line = lineOf(kid(el, "p:spPr"), ctx, kid(el, "p:style")) || { w: 1, c: "#000", dash: false };
		const [x1, y1, x2, y2] = [box.flipH ? box.w : 0, box.flipV ? box.h : 0, box.flipH ? 0 : box.w, box.flipV ? 0 : box.h];
		const ln = path(el, "p:spPr", "a:ln");
		const head = path(ln, "a:headEnd")?.getAttribute("type"), tail = path(ln, "a:tailEnd")?.getAttribute("type");
		const id = "m" + Math.random().toString(36).slice(2, 7);
		const marker = (head && head !== "none") || (tail && tail !== "none") ? `<defs><marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${line.c}"/></marker></defs>` : "";
		return `<svg style="position:absolute;left:${r1(box.x)}px;top:${r1(box.y)}px;overflow:visible" width="${r1(Math.max(box.w, 1))}" height="${r1(Math.max(box.h, 1))}">${marker}<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" stroke="${line.c}" stroke-width="${r1(line.w)}"${line.dash ? ' stroke-dasharray="6 4"' : ""}${tail && tail !== "none" ? ` marker-end="url(#${id})"` : ""}${head && head !== "none" ? ` marker-start="url(#${id})"` : ""}/></svg>`;
	}
	if (tag === "p:graphicFrame") {
		const box = xfrmOf(kid(el, "p:xfrm"), ctx, tx);
		if (!box) return "";
		const tbl = el.getElementsByTagName("a:tbl")[0];
		if (tbl) {
			const cols = [...(kid(tbl, "a:tblGrid")?.children || [])].map((g) => num(g.getAttribute("w")) * ctx.k);
			const rows = kids(tbl, "a:tr").map((tr) => {
				const h = num(tr.getAttribute("h")) * ctx.k;
				const cells = kids(tr, "a:tc").filter((tc) => tc.getAttribute("hMerge") !== "1" && tc.getAttribute("vMerge") !== "1").map((tc) => {
					const tcPr = kid(tc, "a:tcPr");
					const f = fillOf(tcPr, ctx, null);
					const tb = kid(tc, "a:txBody");
					const t = tb ? textHtml(tb, ctx, [{ size: 14, color: "#000000" }]).html : "";
					const span = [tc.getAttribute("gridSpan") ? ` colspan="${tc.getAttribute("gridSpan")}"` : "", tc.getAttribute("rowSpan") ? ` rowspan="${tc.getAttribute("rowSpan")}"` : ""].join("");
					// 줄 간격 1.2 = PowerPoint 의 「한 줄」. 안 주면 덱 기본(.slide 1.45)을 물려받아 칸 글이 넘친다
					return `<td${span} style="border:1px solid #c8c8c8;padding:4px 8px;vertical-align:middle;line-height:1.2${f && f !== "none" ? `;background:${f}` : ""}">${t}</td>`;
				});
				return `<tr style="height:${r1(h)}px">${cells.join("")}</tr>`;
			});
			return `<table style="${posCss(box)};height:auto;border-collapse:collapse;table-layout:fixed"><colgroup>${cols.map((w) => `<col style="width:${r1(w)}px">`).join("")}</colgroup>${rows.join("")}</table>`;
		}
		const isChart = !!el.getElementsByTagName("c:chart")[0];
		ctx.warnings.add(isChart ? "chart" : "object");
		return `<div data-import="${isChart ? "chart" : "object"}" style="${posCss(box)};border:1.5px dashed #b9b9b9;display:flex;align-items:center;justify-content:center;color:#8a8a8a;font-size:16px">${isChart ? "chart" : "object"}</div>`;
	}
	if (tag === "mc:AlternateContent") {
		const choice = kid(el, "mc:Fallback") || kid(el, "mc:Choice");
		const parts: string[] = [];
		for (const c of choice?.children || []) parts.push(await shapeHtml(c, ctx, rel, tx, layer, isSlide));
		return parts.join("\n");
	}
	return "";
}

function bgOf(cSld: El | null, ctx: Ctx): { css: string | null; blip: string | null } | null {
	const bg = kid(cSld, "p:bg");
	if (!bg) return null;
	const pr = kid(bg, "p:bgPr");
	if (pr) {
		const blip = path(pr, "a:blipFill", "a:blip")?.getAttribute("r:embed") || null;
		const f = fillOf(pr, ctx, null);
		return { css: f && f !== "none" ? f : null, blip };
	}
	const ref = kid(bg, "p:bgRef");
	if (ref) return { css: colorOf(ref, ctx), blip: null };
	return null;
}

async function readTheme(zip: JSZip, masterPath: string): Promise<Theme> {
	const r = await rels(zip, masterPath);
	const tp = Object.values(r).find((p) => p.includes("theme/"));
	const doc = tp ? await xml(zip, tp) : null;
	const colors: Record<string, string> = {};
	const cs = doc?.getElementsByTagName("a:clrScheme")[0];
	for (const c of cs?.children || []) {
		const v = c.children[0];
		colors[c.tagName.replace("a:", "")] = (v?.getAttribute("val") && v.tagName === "a:srgbClr" ? v.getAttribute("val") : v?.getAttribute("lastClr")) || "000000";
	}
	const font = (n: string, t: string) => doc?.getElementsByTagName(n)[0]?.getElementsByTagName(t)[0]?.getAttribute("typeface") || "";
	return { colors, major: font("a:majorFont", "a:latin"), minor: font("a:minorFont", "a:latin"), majorEa: font("a:majorFont", "a:ea"), minorEa: font("a:minorFont", "a:ea") };
}

export interface ImportResult { deck: Deck; warnings: string[] }

export async function importPptx(bytes: Uint8Array, src: string, dir: string, title: string, s: Settings, progress: (i: number, n: number) => void): Promise<ImportResult> {
	const zip = await JSZip.loadAsync(bytes);
	const pres = await xml(zip, "ppt/presentation.xml");
	if (!pres) throw new Error("presentation.xml 이 없다 — PPTX 가 아니다");
	const sz = pres.getElementsByTagName("p:sldSz")[0];
	const cx = num(sz?.getAttribute("cx"), 12192000), cy = num(sz?.getAttribute("cy"), 6858000);
	const W = 1280;
	const k = W / cx;
	const H = Math.round(cy * k);
	const presRels = await rels(zip, "ppt/presentation.xml");
	const order = [...pres.getElementsByTagName("p:sldId")].map((e) => presRels[e.getAttribute("r:id")!]).filter(Boolean);

	await api.vcsInit(dir);
	await embedFont(dir);
	const deck: Deck = { format: FORMAT, title, size: { w: W, h: H }, slides: [], theme: "theme.css", source: { kind: "pptx", file: "source/original.pptx" }, created: new Date().toISOString(), updated: new Date().toISOString() };
	await api.absCopyIn(src, dir, "source/original.pptx");
	const warnings = new Set<string>();
	const media = new Map<string, string>();
	let themeFont = "";

	for (let i = 0; i < order.length; i++) {
		progress(i, order.length);
		// 쪽마다 화면에 한 번 숨을 돌려준다 — 안 그러면 진행 표시가 멈춰 보이고 창이 「응답 없음」이 된다
		await new Promise((r) => setTimeout(r, 0));
		const sp = order[i];
		const slide = await xml(zip, sp);
		if (!slide) continue;
		const sRel = await rels(zip, sp);
		const layoutPath = Object.values(sRel).find((p) => p.includes("slideLayouts/"))!;
		const layout = layoutPath ? await xml(zip, layoutPath) : null;
		const lRel = layoutPath ? await rels(zip, layoutPath) : {};
		const masterPath = Object.values(lRel).find((p) => p.includes("slideMasters/"));
		const master = masterPath ? await xml(zip, masterPath) : null;
		const mRel = masterPath ? await rels(zip, masterPath) : {};
		const theme = masterPath ? await readTheme(zip, masterPath) : { colors: {}, major: "", minor: "", majorEa: "", minorEa: "" };
		themeFont ||= theme.minorEa || theme.minor;
		const cm = master?.getElementsByTagName("p:clrMap")[0];
		const clrMap: Record<string, string> = {};
		for (const a of cm?.attributes || []) clrMap[a.name] = a.value;
		const ovr = slide.getElementsByTagName("a:overrideClrMapping")[0];
		for (const a of ovr?.attributes || []) clrMap[a.name] = a.value;
		const ctx: Ctx = { zip, k, theme, clrMap, dir, media, defaults: { title: {}, body: [], other: {} }, warnings, slideNo: i + 1 };

		const txStyles = master?.getElementsByTagName("p:txStyles")[0];
		const lvls = (st: El | null) => Array.from({ length: 9 }, (_, n) => textDefaultsOf(kid(st, `a:lvl${n + 1}pPr`), ctx));
		const titleDefs = lvls(kid(txStyles, "p:titleStyle")), bodyDefs = lvls(kid(txStyles, "p:bodyStyle")), otherDefs = lvls(kid(txStyles, "p:otherStyle"));

		const tree = (d: Document | null) => d?.getElementsByTagName("p:spTree")[0] || null;
		const layoutTree = tree(layout), masterTree = tree(master);
		const inh = (key: { type: string; idx: string } | null) => {
			if (!key) return { ph: null, defaults: otherDefs, kind: "other" as const };
			const kind = key.type === "title" || key.type === "ctrTitle" ? "title" : key.type === "body" || key.type === "subTitle" || key.type === "obj" ? "body" : "other";
			const lp = findPh(layoutTree, key), mp = findPh(masterTree, key);
			const pick = (e: El | null) => (e ? xfrmOf(path(e, "p:spPr", "a:xfrm"), ctx, (b) => b) : null);
			const box = pick(lp) || pick(mp);
			const lst = (e: El | null) => path(e, "p:txBody", "a:lstStyle");
			const base = kind === "title" ? titleDefs : kind === "body" ? bodyDefs : otherDefs;
			const merged = base.map((d, n) => {
				const m = textDefaultsOf(kid(lst(mp), `a:lvl${n + 1}pPr`), ctx), l = textDefaultsOf(kid(lst(lp), `a:lvl${n + 1}pPr`), ctx);
				return { ...d, ...strip(m), ...strip(l) };
			});
			return { ph: { box, body: lp ? kid(lp, "p:spPr") : null, type: key.type } as PhInfo, defaults: merged, kind: kind as "title" | "body" | "other" };
		};
		const layer = { layoutTree, masterTree, inh };

		const parts: string[] = [];
		const cSld = kid(slide.documentElement, "p:cSld");
		const bg = bgOf(cSld, ctx) || bgOf(kid(layout?.documentElement, "p:cSld"), ctx) || bgOf(kid(master?.documentElement, "p:cSld"), ctx);
		let bgCss = bg?.css || "#ffffff";
		if (bg?.blip) {
			const rr = { ...mRel, ...lRel, ...sRel };
			const src = rr[bg.blip] ? await mediaPath(ctx, rr[bg.blip]) : null;
			if (src) bgCss = `url('${src}') center/cover no-repeat`;
		}
		const showMaster = slide.documentElement.getAttribute("showMasterSp") !== "0" && layout?.documentElement.getAttribute("showMasterSp") !== "0";
		if (showMaster && masterTree) for (const c of masterTree.children) parts.push(await shapeHtml(c, ctx, mRel, (b) => b, layer, false));
		if (layoutTree) for (const c of layoutTree.children) parts.push(await shapeHtml(c, ctx, lRel, (b) => b, layer, false));
		const sTree = tree(slide);
		for (const c of sTree?.children || []) parts.push(await shapeHtml(c, ctx, sRel, (b) => b, layer, true));

		// 제목 — 제목 자리 표시자의 글자
		let stitle = "";
		for (const spEl of sTree?.getElementsByTagName("p:sp") || []) {
			const k2 = phKey(spEl);
			if (k2 && (k2.type === "title" || k2.type === "ctrTitle")) { stitle = (spEl.textContent || "").replace(/\s+/g, " ").trim(); break; }
		}
		// 발표자 메모
		const notesPath = Object.values(sRel).find((p) => p.includes("notesSlides/"));
		let notes = "";
		if (notesPath) {
			const nd = await xml(zip, notesPath);
			for (const spEl of nd?.getElementsByTagName("p:sp") || []) {
				if (phKey(spEl)?.type === "body") notes = [...spEl.getElementsByTagName("a:p")].map((p) => p.textContent).join("\n").trim();
			}
		}

		const sid = newId();
		const body = `<section class="slide" style="background:${bgCss}">\n${parts.filter(Boolean).join("\n")}\n</section>`;
		await api.writeText(dir, `slides/${sid}.html`, slideHtml(body, s.lang));
		deck.slides.push({ id: sid, file: `slides/${sid}.html`, title: stitle.slice(0, 60) || undefined, notes: notes || undefined });
	}
	progress(order.length, order.length);
	const css = themeCss({ ...s.shape, font: themeFont || s.shape.font }, deck.size) + `\n/* 가져온 PPTX 의 글자 틀 */\n.slide p { white-space: pre-wrap; }\n`;
	await api.writeText(dir, "theme.css", css);
	await writeDeck(dir, deck);
	return { deck, warnings: [...warnings] };
}

const strip = (o: TextDefaults) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ""));
