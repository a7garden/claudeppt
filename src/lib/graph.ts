// 변경 그래프의 줄 나누기 (History.tsx) — 화면 없이 시험하려고 따로 둔다 (graph.test.ts)
import type { GraphHead, GraphNode } from "./api";

/** 줄 나누기 — 줄의 끝(본안 · 시안 · 보류)에서 첫 부모를 따라 내려가며 아직 줄이 없는 변경을 그 줄에 넣는다.
 *  끝이 없는 변경(넣고 치운 시안)은 만나는 차례로 새 줄. 줄은 위아래로 겹치지 않으면 같은 칸을 다시 쓴다 */
export function lanes(nodes: GraphNode[], heads: GraphHead[]): { col: Map<string, number>; kind: Map<number, GraphHead["kind"] | "old">; cols: number } {
	const row = new Map(nodes.map((n, i) => [n.hash, i]));
	const lane = new Map<string, number>();
	const span: { from: number; to: number; kind: GraphHead["kind"] | "old" }[] = [];
	const walk = (h: string, kind: GraphHead["kind"] | "old") => {
		if (!row.has(h) || lane.has(h)) return;
		const k = span.length;
		const s = { from: row.get(h)!, to: row.get(h)!, kind };
		span.push(s);
		let at: string | undefined = h;
		while (at && row.has(at) && !lane.has(at)) {
			lane.set(at, k);
			s.to = row.get(at)!;
			at = nodes[row.get(at)!].parents[0];
		}
		// 이어지는 부모(다른 줄)까지 선이 내려가므로 그 행까지 차지한다
		if (at && row.has(at)) s.to = row.get(at)!;
		else if (at) s.to = nodes.length;
	};
	for (const h of heads) walk(h.hash, h.kind);
	for (const n of nodes) walk(n.hash, "old");
	// 칸 나누기 — 본안은 늘 0, 나머지는 위에서부터 비어 있는 가장 왼쪽 칸
	const colOf: number[] = [];
	const busy: number[][] = [];
	span.forEach((s, k) => {
		let c = k === 0 ? 0 : 1;
		while (busy[c]?.some((o) => !(span[o].to < s.from || span[o].from > s.to))) c++;
		(busy[c] ??= []).push(k);
		colOf[k] = c;
	});
	const col = new Map([...lane].map(([h, k]) => [h, colOf[k]]));
	const kind = new Map(span.map((s, k) => [colOf[k], k === 0 ? "main" : s.kind] as const));
	return { col, kind, cols: Math.max(1, ...colOf.map((c) => c + 1)) };
}
