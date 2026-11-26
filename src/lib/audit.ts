// 점검(audit) — 쪽마다 서식(템플릿) · 배치 · 표현에서 규칙에 걸린 곳을 짚는다. 고치지는 않는다: 「Claude 에게 고치기」가 따로 보낸다.
// 앱의 「점검」 단추와 바깥 CLI 의 audit 가 같은 함수다. 결과는 .claudeppt/audit/report.json 에도 남는다.
// 2026.11.26 : 화면 이름을 「감사」에서 「점검」으로, 갈래 「AI 티」를 「표현」으로 바꿨다 (감사는 「고맙다」로도 읽힌다). 코드 안 이름(audit · slop)은 그대로다.
//              걸린 요소의 자리(boxes)를 함께 남겨 무대에 표시하고, 사람이 적은 추가 지시(note.md)를 고치기 요청에 싣는다
//
// 목차
//   재기          런타임(rt.js)의 audit 이 보이는 요소마다 자리 · 계산된 서식을 준다 (굽지 않아 빠르다)
//   템플릿        글꼴 · 색 · 글자 위계 · 모서리 · 그림자 · 여백 — 덱의 템플릿 값과 견준다. 가져온 PPTX 덱은 템플릿이 없어 건너뛴다
//   표현          긴 대시 · 장식 이모지 · 상투어 · 그라데이션 · 글자 그림자 · 긴 글 · 글머리 과다 · 강조색 남발 · 같은 꼴 카드 나열 · 작은 대문자 머리표
//   배치          쪽 밖으로 넘친 것 · 쪽 제목 자리가 쪽마다 조금씩 다른 것 (덱 전체를 보고 정한다)
//
// 짚는 기준은 prompt.ts templateRules 가 Claude 에게 말한 규칙과 같아야 한다 — 말하지 않은 것으로 짚으면 고쳐도 다시 걸린다.
// 2026.11.26 : 처음 만들었다. 문턱(글 300자 · 글머리 6줄 · 강조색 3곳 · 크기 4가지 · 제목 자리 12~80px)은 실제 덱을 돌려 보며 조정한다
import { api } from "./api";
import type { Deck, Margins } from "./deck";
import { ask, offscreen } from "./frames";
import { type Key, tNow } from "./i18n";
import type { Template } from "./settings";

export type AuditKind = "template" | "slop" | "layout";
export interface Box { x: number; y: number; w: number; h: number }
export interface Finding {
	rule: string;
	kind: AuditKind;
	/** 화면에 보일 한 줄 (설정 말) */
	msg: string;
	/** Claude 에게 보낼 한 줄 (영어 · 어느 요소인지 포함) */
	fix: string;
	/** 걸린 요소의 자리 (쪽 px) — 무대에 겹쳐 그린다. 쪽 전체에 걸린 것(글 양 · 크기 가짓수)은 비어 있다 */
	boxes?: Box[];
}
export interface SlideAudit { id: string; no: number; title?: string; findings: Finding[] }
/** kinds: 고른 갈래 · note: 사람이 적은 추가 지시 · margins: 쪽 여백 */
export interface AuditReport { at: string; template: string | null; kinds: AuditKind[]; note: string; margins: Margins | null; slides: SlideAudit[] }
export const AUDIT_KINDS: AuditKind[] = ["template", "layout", "slop"];

/** 추가 지시 — 덱 안(.claudeppt/audit/note.md)에 두어 팀원 · 바깥 CLI 도 같은 지시를 쓴다 */
const NOTE = ".claudeppt/audit/note.md";
export const readAuditNote = (dir: string) => api.readText(dir, NOTE).then((t) => t.trim(), () => "");
export const writeAuditNote = (dir: string, text: string) => api.writeText(dir, NOTE, text.trim() + "\n");

/** 런타임이 주는 요소 하나 (rt.js auditNodes) */
interface Node {
	path: number[] | null; tag: string; cls: string;
	x: number; y: number; w: number; h: number;
	text: string; tbox: { x: number; y: number; w: number; h: number } | null;
	font: string; size: number; weight: number;
	color: string | null; fill: string | null; border: string | null;
	radius: number; shadow: boolean; tshadow: boolean; gradient: boolean; clip: boolean;
	upper: boolean; ls: number; li: boolean;
}

const BASE = ".claudeppt/audit";

// ── 색 ──
type RGB = [number, number, number];
const rgb = (hex: string): RGB => { const h = hex.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB; };
const far = (a: RGB, b: RGB) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
const mix = (a: RGB, b: RGB, p: number): RGB => [0, 1, 2].map((i) => a[i] * p + b[i] * (1 - p)) as RGB;

/** 템플릿 색인가 — 템플릿 색 · 파생색(muted · line · soft)과 같거나, 템플릿 색을 바탕 · 흰색 · 검은색 쪽으로 옅게 · 짙게 한 색이면 된다.
 *  옅게 깐 강조색 바탕(color-mix 10%)까지 짚으면 짚는 것이 너무 많아 진짜 벗어난 색이 묻힌다 */
function colorCheck(tpl: Template) {
	const ink = rgb(tpl.ink), paper = rgb(tpl.paper);
	const bases = [tpl.ink, tpl.accent, ...tpl.palette].map(rgb);
	const fixed = [ink, paper, ...bases, mix(ink, paper, 0.55), mix(ink, paper, 0.14), mix(ink, paper, 0.05)];
	const ends: RGB[] = [paper, [255, 255, 255], [0, 0, 0], ink];
	return (hex: string) => {
		const x = rgb(hex);
		if (fixed.some((c) => far(c, x) <= 10)) return true;
		for (const c of bases) for (const e of ends) {
			const d = [e[0] - c[0], e[1] - c[1], e[2] - c[2]];
			const len = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
			if (!len) continue;
			const t = Math.max(0, Math.min(1, ((x[0] - c[0]) * d[0] + (x[1] - c[1]) * d[1] + (x[2] - c[2]) * d[2]) / len));
			if (far(x, [c[0] + d[0] * t, c[1] + d[1] * t, c[2] + d[2] * t]) <= 8) return true;
		}
		return false;
	};
}

// ── 말 ──
// 상투어 — 발표 자료를 AI 가 썼을 때 흔히 끼는 말. 한 낱말만으로 단정하지 않으려고 「고도화」 「핵심」처럼 업무 문서에 흔한 말은 넣지 않았다
const BUZZ_KO = ["혁신적", "획기적", "시너지", "극대화", "새로운 차원", "패러다임 전환", "게임 체인저", "게임체인저", "한 단계 도약", "최적의 솔루션", "새로운 지평", "미래를 선도", "무한한 가능성", "놀라운 성과", "완벽한 솔루션", "차원이 다른"];
const BUZZ_EN = ["seamless", "seamlessly", "unlock", "elevate", "empower", "revolutionize", "revolutionary", "game-changer", "game changer", "cutting-edge", "leverage", "synergy", "delve", "unleash", "next-level", "fast-paced", "transformative", "holistic", "world-class", "best-in-class", "supercharge"];
const BUZZ_RE = new RegExp(`(${BUZZ_KO.join("|")})|\\b(${BUZZ_EN.map((w) => w.replace(/-/g, "\\-")).join("|")})\\b`, "gi");
// 그림 글자로 그려지는 것만 — ↗ ▶ ★ 처럼 글자로 그려지는 기호는 도표에 흔히 써서 뺀다
const EMOJI = new RegExp("\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F", "gu");

const say = (k: Key, v: Record<string, string | number> = {}) => tNow(k).replace(/\{(\w+)\}/g, (_, n) => String(v[n] ?? ""));
const quote = (t: string) => `"${t.length > 40 ? t.slice(0, 38) + "…" : t}"`;
const uniq = <T,>(a: T[]) => [...new Set(a)];
const list = (a: (string | number)[], n = 4) => a.slice(0, n).join(" · ") + (a.length > n ? ` +${a.length - n}` : "");

/** 표시할 자리 — 글은 글이 실제로 놓인 범위(tbox), 아니면 요소 상자. 너무 많으면 앞의 것만 */
const boxOf = (ns: Node[], text = false): Box[] => ns.slice(0, 24).map((n) => (text && n.tbox ? n.tbox : { x: n.x, y: n.y, w: n.w, h: n.h }));

/** 쪽 하나를 잰다 — 쪽 제목 자리는 덱 전체를 본 뒤 audit 끝에서 따로 짚는다. margins 는 여백을 잴 값(없으면 재지 않는다) */
function auditSlide(nodes: Node[], W: number, H: number, tpl: Template | null, margins: Margins | null): Finding[] {
	const out: Finding[] = [];
	const add = (rule: string, kind: AuditKind, msg: string, fix: string, ns: Node[] = [], text = false) => out.push({ rule, kind, msg, fix, boxes: boxOf(ns, text) });
	const texts = nodes.filter((n) => n.text);
	const boxes = nodes.filter((n) => n.path?.length && (n.fill || n.border));

	if (tpl) {
		// 글꼴
		const fonts = [tpl.font, tpl.headFont].filter(Boolean).map((f) => f.toLowerCase());
		const offFont = texts.filter((n) => !["code", "pre", "kbd"].includes(n.tag) && n.font && !fonts.includes(n.font.toLowerCase()));
		if (offFont.length) {
			const names = uniq(offFont.map((n) => n.font));
			add("font", "template", say("auditFont", { v: list(names) }), `fonts outside the template (${names.join(", ")}) on ${offFont.slice(0, 3).map((n) => quote(n.text)).join(", ")}. Use var(--font) / var(--font-head).`, offFont, true);
		}
		// 색
		const ok = colorCheck(tpl);
		const off = new Map<string, string[]>();
		const offN = new Set<Node>();
		for (const n of nodes) {
			for (const [c, what] of [[n.color, "text"], [n.fill, "fill"], [n.border, "border"]] as const) {
				if (c && !ok(c)) { off.set("#" + c, [...(off.get("#" + c) || []), what === "text" ? quote(n.text) : `${what} of <${n.tag}>`]); offN.add(n); }
			}
		}
		if (off.size) {
			const cs = [...off.keys()];
			add("color", "template", say("auditColor", { v: list(cs) }), `colors outside the template: ${cs.map((c) => `${c} (${uniq(off.get(c)!).slice(0, 2).join(", ")})`).join("; ")}. Use the template variables or a tint of them.`, [...offN]);
		}
		// 글자 위계
		const levels = Object.values(tpl.scale).map((x) => x.size);
		const offSize = texts.filter((n) => n.size < tpl.scale.display.size && !levels.some((l) => Math.abs(l - n.size) <= 1.5));
		if (offSize.length) {
			const sz = uniq(offSize.map((n) => Math.round(n.size))).sort((a, b) => b - a);
			add("size", "template", say("auditSize", { v: list(sz.map((x) => x + "px")) }), `font sizes off the type scale (${sz.join(", ")}px) on ${offSize.slice(0, 3).map((n) => quote(n.text)).join(", ")}. Use the .t-* classes.`, offSize, true);
		}
		// 모서리 — 알약(높이 절반 이상)은 된다
		const offR = boxes.filter((n) => n.radius > 0.5 && n.radius < Math.min(n.w, n.h) / 2 - 1 && Math.abs(n.radius - tpl.radius) > 1.5);
		if (offR.length) {
			const rs = uniq(offR.map((n) => Math.round(n.radius)));
			add("radius", "template", say("auditRadius", { v: list(rs.map((r) => r + "px")), r: tpl.radius }), `corner radius ${rs.join(", ")}px on ${offR.length} shapes; the template uses ${tpl.radius}px (var(--radius)).`, offR);
		}
		if (tpl.shadow === "none") {
			const sh = nodes.filter((n) => n.shadow);
			if (sh.length) add("shadow", "template", say("auditShadow"), `box-shadow on ${sh.length} elements; the template uses no shadows.`, sh);
		}
		// 강조색 남발
		const acc = rgb(tpl.accent);
		const accs = nodes.filter((n) => (n.color && far(rgb(n.color), acc) <= 6) || (n.fill && far(rgb(n.fill), acc) <= 6));
		if (accs.length > 3) add("accent", "slop", say("auditAccent", { n: accs.length }), `the accent color is used on ${accs.length} elements; keep it for the one thing that matters.`, accs);
	}

	// 여백 — 글이 실제로 놓인 범위로 잰다 (가운데 맞춤 글은 칸이 넓어도 가장자리에서 멀다)
	if (margins) {
		const m = margins;
		const tight = texts.filter((n) => n.tbox && (n.tbox.x < m.l - 4 || n.tbox.x + n.tbox.w > W - m.r + 4 || n.tbox.y < m.t - 4 || n.tbox.y + n.tbox.h > H - m.b + 4));
		if (tight.length) add("margin", "layout", say("auditMargin", { n: tight.length }), `text inside the page margins (top ${m.t}, right ${m.r}, bottom ${m.b}, left ${m.l}px): ${tight.slice(0, 3).map((n) => quote(n.text)).join(", ")}.`, tight, true);
	}

	// 글자 크기 가짓수 · 그라데이션 · 글자 효과 · 글 양 · 글머리 수는 템플릿으로 만든 덱만 본다.
	// 가져온 PPTX 는 사람이 정한 원본 모양이라, 쪽마다 걸려 정작 고친 뒤 새로 생긴 것이 묻혔다 (2026.11.26 착수보고 26쪽 덱에서 25쪽이 걸렸다)
	const own = !!tpl;
	const sizes = uniq(texts.map((n) => Math.round(n.size)));
	if (own && sizes.length > 4) add("levels", "template", say("auditLevels", { n: sizes.length }), `${sizes.length} different font sizes (${sizes.sort((a, b) => b - a).join(", ")}px); use at most 4 levels.`);

	// 넘침 — 쪽은 overflow:hidden 이라 넘친 글은 잘려 보이지 않는다
	const over = nodes.filter((n) => n.path?.length && (n.text || n.fill) && (n.x < -2 || n.y < -2 || n.x + n.w > W + 2 || n.y + n.h > H + 2));
	if (over.length) add("overflow", "layout", say("auditOverflow", { n: over.length }), `${over.length} elements run past the slide edge: ${over.slice(0, 3).map((n) => (n.text ? quote(n.text) : `<${n.tag}>`) + ` at x${n.x} y${n.y} ${n.w}×${n.h}`).join(", ")}.`, over);

	// ── 표현 ──
	const all = texts.map((n) => n.text).join("\n");
	const dash = (all.match(/—/g) || []).length;
	if (dash) add("dash", "slop", say("auditDash", { n: dash }), `${dash} em dashes (—); rewrite with a comma, colon, period or parentheses.`, texts.filter((n) => n.text.includes("—")), true);
	const emo = uniq(texts.flatMap((n) => n.text.match(EMOJI) || []));
	if (emo.length) add("emoji", "slop", say("auditEmoji", { v: emo.slice(0, 6).join(" ") }), `decorative emoji (${emo.join(" ")}); remove them or draw a proper SVG icon.`, texts.filter((n) => new RegExp(EMOJI.source, "u").test(n.text)), true);
	const buzz = uniq((all.match(BUZZ_RE) || []).map((w) => w.toLowerCase()));
	if (buzz.length) add("buzz", "slop", say("auditBuzz", { v: list(buzz.map((w) => `「${w}」`)) }), `filler wording (${buzz.join(", ")}); say the concrete fact instead.`, texts.filter((n) => new RegExp(BUZZ_RE.source, "i").test(n.text)), true);
	const grad = nodes.filter((n) => n.gradient && !n.clip);
	if (own && grad.length) add("gradient", "slop", say("auditGradient", { n: grad.length }), `gradient backgrounds on ${grad.map((n) => `<${n.tag}>`).slice(0, 3).join(", ")}; use flat template colors (gradients become pictures in PowerPoint).`, grad);
	const glow = nodes.filter((n) => n.tshadow || n.clip);
	if (own && glow.length) add("glow", "slop", say("auditGlow", { n: glow.length }), `text-shadow or gradient-filled text on ${glow.length} elements; use plain colored text.`, glow, true);
	const chars = all.replace(/\s/g, "").length;
	if (own && chars > 300) add("wordy", "slop", say("auditWordy", { n: chars }), `${chars} characters of text; cut to the one message of the slide (split or move detail to speaker notes).`);
	const bl = texts.filter((n) => n.li || /^[•·▪◦\-–]\s/.test(n.text));
	const bullets = bl.length;
	if (own && bullets > 6) add("bullets", "slop", say("auditBullets", { n: bullets }), `${bullets} bullet lines; keep at most 6.`, bl, true);
	// 같은 꼴 카드 — 한 부모 아래 크기가 같은 상자 셋 이상이 저마다 아이콘(svg)과 글을 품는다. AI 가 가장 흔히 까는 배치다
	const byParent = new Map<string, Node[]>();
	for (const b of boxes) {
		const k = JSON.stringify(b.path!.slice(0, -1));
		byParent.set(k, [...(byParent.get(k) || []), b]);
	}
	const inside = (p: number[], q: number[] | null) => !!q && q.length > p.length && p.every((v, i) => q[i] === v);
	for (const sib of byParent.values()) {
		if (sib.length < 3) continue;
		const same = sib.filter((b) => sib.filter((c) => Math.abs(c.w - b.w) <= 3 && Math.abs(c.h - b.h) <= 3).length >= 3);
		const cards = same.filter((b) => nodes.some((n) => n.tag === "svg" && inside(b.path!, n.path)) && nodes.some((n) => n.text && inside(b.path!, n.path)));
		if (cards.length >= 3) {
			add("cards", "slop", say("auditCards", { n: cards.length }), `${cards.length} look-alike cards (icon + heading + text, same size) in a row; that is the default AI layout. Choose a form that fits the content (a table, a sequence, one highlighted item with the rest smaller, or plain text).`, cards);
			break;
		}
	}
	const eyebrow = texts.filter((n) => n.upper && n.ls >= 1 && n.size <= 18 && n.text.length <= 40 && /[A-Za-z]/.test(n.text));
	if (eyebrow.length) add("eyebrow", "slop", say("auditEyebrow", { v: eyebrow[0].text.slice(0, 24) }), `small spaced-out uppercase labels (${eyebrow.map((n) => quote(n.text)).slice(0, 3).join(", ")}); drop them unless they carry information.`, eyebrow, true);
	return out;
}

/** 쪽 제목 자리 — 위쪽 1/3 안에서 가장 큰 글. 쪽마다 조금씩(12~80px) 다르면 손으로 맞춘 티가 난다. 크게 다른 쪽(표지 · 구역 머리)은 일부러 다른 배치로 본다 */
function titleSpots(per: { nodes: Node[]; H: number }[], tpl: Template | null) {
	const min = tpl ? tpl.scale.title.size * 0.8 : 28;
	return per.map(({ nodes, H }) => {
		const t = nodes.filter((n) => n.tbox && n.size >= min && n.tbox.y < H * 0.35).sort((a, b) => b.size - a.size || a.tbox!.y - b.tbox!.y)[0];
		return t ? { x: t.tbox!.x, y: t.tbox!.y, text: t.text, box: t.tbox! } : null;
	});
}

/** kinds: 볼 갈래(없으면 모두) · margins: 쪽 여백(prompt.ts pageMargins). 쪽 설정 없이 템플릿 여백만 있으면 위아래는 머리글 · 쪽 번호 자리라 24px 로 넉넉히 본다 */
export async function runAudit(dir: string, id: string, deck: Deck, tpl: Template | null, step: (i: number, n: number) => void, opt: { kinds?: AuditKind[]; margins?: Margins | null } = {}): Promise<AuditReport> {
	const kinds = opt.kinds?.length ? opt.kinds : AUDIT_KINDS;
	const pm = opt.margins ?? null;
	const margins = deck.page || !pm ? pm : { ...pm, t: 24, b: 24 };
	const { w, h } = deck.size;
	const per: { nodes: Node[]; H: number }[] = [];
	const slides: SlideAudit[] = [];
	for (let i = 0; i < deck.slides.length; i++) {
		const ref = deck.slides[i];
		step(i, deck.slides.length);
		const { win, dispose } = await offscreen(id, ref.file, w, h);
		let res: any;
		try { res = await ask(win, { t: "audit" }, 20000); } finally { dispose(); }
		if (res.error) throw new Error(`${i + 1}: ${res.error}`);
		const nodes: Node[] = res.data.nodes;
		per.push({ nodes, H: res.data.h });
		slides.push({ id: ref.id, no: i + 1, title: ref.title, findings: auditSlide(nodes, res.data.w, res.data.h, tpl, margins) });
	}
	step(deck.slides.length, deck.slides.length);
	// 쪽 제목 자리 — 표지(1쪽)는 빼고, 가장 많은 쪽이 쓰는 자리(8px 칸)를 기준으로 삼는다
	const spots = titleSpots(per, tpl);
	const votes = new Map<string, number>();
	spots.forEach((s, i) => { if (s && i > 0) { const k = `${Math.round(s.x / 8)},${Math.round(s.y / 8)}`; votes.set(k, (votes.get(k) || 0) + 1); } });
	const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
	if (best && best[1] >= 2) {
		const [bx, by] = best[0].split(",").map((v) => +v * 8);
		spots.forEach((s, i) => {
			if (!s || i === 0) return;
			const d = Math.max(Math.abs(s.x - bx), Math.abs(s.y - by));
			if (d > 12 && d <= 80) slides[i].findings.push({ rule: "titlePos", kind: "layout", msg: say("auditTitlePos", { d }), fix: `the slide title ${quote(s.text)} sits at x${s.x} y${s.y}, but most slides put it at about x${bx} y${by}; align it.`, boxes: [s.box] });
		});
	}
	for (const s of slides) s.findings = s.findings.filter((f) => kinds.includes(f.kind));
	const report: AuditReport = { at: new Date().toISOString(), template: tpl?.name ?? null, kinds, note: await readAuditNote(dir), margins: pm, slides };
	await api.writeText(dir, `${BASE}/report.json`, JSON.stringify(report, null, 1)).catch(() => {});
	return report;
}

export const findingCount = (r: AuditReport) => r.slides.reduce((n, s) => n + s.findings.length, 0);

/** Claude 에게 보낼 요청 — 짚은 쪽만, 쪽마다 한 줄씩. kinds 를 주면 그 갈래만. 추가 지시(note)가 있으면 모든 쪽을 그 지시로도 보게 한다 */
export function auditFixPrompt(r: AuditReport, kinds?: AuditKind[]) {
	const bad = r.slides.map((s) => ({ ...s, findings: s.findings.filter((f) => !kinds || kinds.includes(f.kind)) })).filter((s) => s.findings.length);
	const note = r.note?.trim();
	if (!bad.length && !note) return "";
	return [
		bad.length
			? "The app checked the deck. Fix each finding below by editing the slide HTML/CSS. Keep the meaning and the content; change how it is styled and worded."
			: "The app checked the deck and its rules found nothing. Review every slide against the person's instructions below and fix what does not follow them.",
		r.template
			? "Follow the house style: template variables and the .t-* type classes, flat colors, plain concrete wording. If a finding is intentional (a full-bleed band, a brand color in a logo), leave it and say so in one line."
			: "This deck was imported from a PPTX: keep its original look; fix only wording and layout findings.",
		...bad.map((s) => `- slide ${s.no} (slides/${s.id}.html): ` + s.findings.map((f) => f.fix).join(" ")),
		...(note ? ["", `Additional instructions from the person for this check. Apply them to every slide${bad.length ? ", not only the ones listed above" : ""}:`, note] : []),
	].join("\n");
}
