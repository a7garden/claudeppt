// 변경 그래프 줄 나누기 (2026.11.27) — 본안은 늘 첫 칸, 시안 · 보류는 갈라진 자리부터 제 칸, 넣고 치운 시안도 제 칸 (npm test)
import { describe, expect, it } from "vitest";
import type { GraphHead, GraphNode } from "./api";
import { lanes } from "./graph";

const n = (hash: string, ...parents: string[]): GraphNode => ({ hash, short: hash, parents, author: "a", date: "", subject: hash, tags: [] });

describe("변경 그래프 줄", () => {
	// m3 = 시안 s 를 넣음(부모 m2, s2) · h1 = 보류(부모 m2) · m2 ← m1
	const nodes = [n("m3", "m2", "s2"), n("h1", "m2"), n("s2", "s1"), n("m2", "m1"), n("s1", "m1"), n("m1")];
	const heads: GraphHead[] = [{ kind: "main", id: "main", name: "main", hash: "m3" }, { kind: "hold", id: "t1", name: "x", hash: "h1" }];

	it("본안은 첫 칸, 보류는 제 칸, 넣고 치운 시안도 제 칸", () => {
		const { col, kind, cols } = lanes(nodes, heads);
		expect(["m3", "m2", "m1"].map((h) => col.get(h))).toEqual([0, 0, 0]);
		expect(col.get("h1")).toBe(1);
		expect(kind.get(1)).toBe("hold");
		expect(col.get("s2")).toBe(col.get("s1"));
		expect(col.get("s2")).not.toBe(0);
		expect(cols).toBeLessThanOrEqual(3);
	});

	it("위아래로 겹치지 않는 줄은 같은 칸을 다시 쓴다", () => {
		// a2 ← a1 (시안 a, 위) · b2 ← b1 (시안 b, 아래) 가 본안의 다른 구간에서 갈라졌다
		const ns = [n("m4", "m3", "a2"), n("a2", "a1"), n("a1", "m3"), n("m3", "m2", "b2"), n("b2", "b1"), n("b1", "m1"), n("m2", "m1"), n("m1")];
		const { col, cols } = lanes(ns, [{ kind: "main", id: "main", name: "main", hash: "m4" }]);
		expect(col.get("a1")).toBe(col.get("b1"));
		expect(cols).toBe(2);
	});
});
