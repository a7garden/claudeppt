// @vitest-environment happy-dom
// 손 편집을 원본 HTML 에 되쓰기 — 묶음(batch)은 런타임이 한 차례대로 적용되어야 같은 요소를 찾는다 (npm test)
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
vi.mock("./api", () => ({
	api: {
		readText: async (_d: string, f: string) => files.get(f) ?? "",
		writeText: async (_d: string, f: string, t: string) => void files.set(f, t),
	},
}));

import { applyOp } from "./edits";

const SLIDE = `<!doctype html><html><head></head><body><section class="slide"><div id="a" style="position:absolute;left:10px"></div><div id="b"></div><div id="c"></div></section></body></html>`;
const ids = () => [...new DOMParser().parseFromString(files.get("s.html")!, "text/html").querySelector(".slide")!.children].map((e) => e.id || e.tagName.toLowerCase());

describe("묶음 편집 (batch)", () => {
	beforeEach(() => files.set("s.html", SLIDE));

	it("지우기를 차례로 — 앞의 것을 지운 뒤의 길로 다음 것을 찾는다", async () => {
		// 런타임: b([1]) 를 지우면 c 가 [1] 이 된다
		expect(await applyOp("d", "s.html", [], { t: "batch", ops: [{ path: [1], op: { t: "remove" } }, { path: [1], op: { t: "remove" } }] })).toBe(true);
		expect(ids()).toEqual(["a"]);
	});

	it("그룹: 마지막 것 뒤에 묶음을 넣고 원래 것들을 지운다", async () => {
		const g = `<div data-group="" id="g"><div id="a2"></div><div id="c2"></div></div>`;
		const ok = await applyOp("d", "s.html", [], { t: "batch", ops: [
			{ path: [2], op: { t: "after", html: g } },
			{ path: [0], op: { t: "remove" } },
			{ path: [1], op: { t: "remove" } },
		] });
		expect(ok).toBe(true);
		expect(ids()).toEqual(["b", "g"]);
	});

	it("한 op 라도 길을 못 찾으면 아무것도 쓰지 않는다", async () => {
		const ok = await applyOp("d", "s.html", [], { t: "batch", ops: [{ path: [0], op: { t: "patch", style: { left: "99px" } } }, { path: [9], op: { t: "remove" } }] });
		expect(ok).toBe(false);
		expect(files.get("s.html")).toBe(SLIDE);
	});

	it("쪽 뿌리는 지우지 못한다", async () => {
		expect(await applyOp("d", "s.html", [], { t: "batch", ops: [{ path: [], op: { t: "remove" } }] })).toBe(false);
	});
});
