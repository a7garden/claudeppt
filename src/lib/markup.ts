// 표시 — 무대에 그은 펜 · 화살표 · 상자. 핀과 같은 것으로 다룬다(번호 · 의견 · 요청칸 위 쌓기 · 보내기 한 번에 함께 감).
// 핀은 「여기」 한 점이지만 표시는 「이 줄 · 이 범위 · 이쪽으로」를 말한다 — 말로 풀기 어려운 위치 지시를 손으로 그리게 한다.
//
// 목차
//   Shape · shapePath     표시 모양 → SVG 경로 (무대 그리기 · 그림 굽기가 같은 경로를 쓴다)
//   describe              Claude 에게 보낼 말 — 좌표로 푼다
//   markedPictures        보낼 때 표시를 그 쪽 그림 위에 그려 첨부로 남긴다 (Claude 가 Read 로 본다)
import { api } from "./api";
import type { Deck } from "./deck";
import { ask, offscreen } from "./frames";
import type { PinNote } from "./prompt";

/** 도구는 셋이다. 어느 도구든 끌지 않고 누르기만 하면 핀이 된다 — 핀 도구를 따로 두면 「누르기 · 긋기」마다 도구를 바꿔야 한다 */
export type Tool = "pen" | "arrow" | "box";
/** pts 는 슬라이드 1:1 픽셀의 [x0, y0, x1, y1, …]. 화살표 · 상자는 시작점과 끝점 두 점 */
export interface Shape { kind: Tool; pts: number[] }

/** 표시 색 — 그림에 구워 넣을 때도 같은 색. 슬라이드 위에서 눈에 띄도록 테마와 무관하게 고정한다 */
export const MARK = "#e8553a";

export function shapePath(s: Shape): string {
	const p = s.pts;
	if (s.kind === "box") {
		const [x0, y0, x1, y1] = p;
		return `M${x0} ${y0}H${x1}V${y1}H${x0}Z`;
	}
	if (s.kind === "arrow") {
		const [x0, y0, x1, y1] = p;
		const a = Math.atan2(y1 - y0, x1 - x0), h = 18;
		const l = [x1 - h * Math.cos(a - 0.45), y1 - h * Math.sin(a - 0.45)], r = [x1 - h * Math.cos(a + 0.45), y1 - h * Math.sin(a + 0.45)];
		return `M${x0} ${y0}L${x1} ${y1}M${l[0]} ${l[1]}L${x1} ${y1}L${r[0]} ${r[1]}`;
	}
	// 펜 — 점 사이 가운데를 잇는 2차 곡선으로 매끈하게. 손떨림 각이 그대로 보이면 지저분하다
	if (p.length < 4) return `M${p[0]} ${p[1]}l0.01 0`;
	let d = `M${p[0]} ${p[1]}`;
	for (let i = 2; i < p.length - 2; i += 2) d += `Q${p[i]} ${p[i + 1]} ${(p[i] + p[i + 2]) / 2} ${(p[i + 1] + p[i + 3]) / 2}`;
	return d + `L${p[p.length - 2]} ${p[p.length - 1]}`;
}

export function bbox(s: Shape) {
	const xs = s.pts.filter((_, i) => i % 2 === 0), ys = s.pts.filter((_, i) => i % 2 === 1);
	return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** 너무 작게 그은 것(실수로 누른 것)은 표시로 치지 않는다 */
export const tiny = (s: Shape) => { const b = bbox(s); return Math.max(b.x1 - b.x0, b.y1 - b.y0) < 6; };

const R = Math.round;
export function describe(s: Shape): string {
	const b = bbox(s);
	if (s.kind === "arrow") return `an arrow from (${R(s.pts[0])}, ${R(s.pts[1])}) pointing to (${R(s.pts[2])}, ${R(s.pts[3])})`;
	if (s.kind === "box") return `a box around (${R(b.x0)}, ${R(b.y0)})–(${R(b.x1)}, ${R(b.y1)})`;
	return `a freehand mark over (${R(b.x0)}, ${R(b.y0)})–(${R(b.x1)}, ${R(b.y1)})`;
}

/** 번호 표식 자리 — 펜은 끝점, 화살표는 꼬리(머리에 두면 표식이 가리키는 곳을 덮는다), 상자는 오른쪽 위 모서리(안 글을 가리지 않게) */
export function anchor(s: Shape) {
	if (s.kind === "box") { const b = bbox(s); return { x: b.x1, y: b.y0 }; }
	if (s.kind === "arrow") return { x: s.pts[0], y: s.pts[1] };
	return { x: s.pts[s.pts.length - 2], y: s.pts[s.pts.length - 1] };
}

/** 핀 · 표시가 있는 쪽마다 지금 모양을 굽고 그 위에 표시와 번호를 그려 .claudeppt/attach 에 둔다.
 *  좌표 글만으로는 Claude 가 「어디를 가리키는지」를 자주 잘못 짚는다 — 그림을 같이 주면 바로 본다 */
export async function markedPictures(dir: string, id: string, deck: Deck, notes: PinNote[]): Promise<string[]> {
	const out: string[] = [];
	const { w, h } = deck.size;
	for (const slide of [...new Set(notes.map((n) => n.slide))]) {
		const ref = deck.slides.find((s) => s.id === slide);
		if (!ref) continue;
		const { win, dispose } = await offscreen(id, ref.file, w, h);
		let snap: any;
		try { snap = await ask(win, { t: "snapshot", scale: 1 }, 60000); } finally { dispose(); }
		if (snap.error) continue;
		const img = new Image();
		img.src = snap.data;
		await img.decode();
		const c = document.createElement("canvas");
		c.width = w;
		c.height = h;
		const g = c.getContext("2d")!;
		g.drawImage(img, 0, 0, w, h);
		g.lineCap = g.lineJoin = "round";
		for (const n of notes.filter((x) => x.slide === slide)) {
			let at = { x: n.x, y: n.y };
			if (n.shape) {
				g.strokeStyle = MARK;
				g.lineWidth = 4;
				g.stroke(new Path2D(shapePath(n.shape)));
				at = anchor(n.shape);
			}
			g.fillStyle = MARK;
			g.beginPath();
			g.arc(at.x, at.y, 13, 0, Math.PI * 2);
			g.fill();
			g.fillStyle = "#fff";
			g.font = "600 14px sans-serif";
			g.textAlign = "center";
			g.textBaseline = "middle";
			g.fillText(String(n.n), at.x, at.y + 1);
		}
		const rel = `.claudeppt/attach/marks-${slide}-${Date.now().toString(36)}.png`;
		await api.writeB64(dir, rel, c.toDataURL("image/png").split(",")[1]);
		out.push(rel);
	}
	return out;
}
