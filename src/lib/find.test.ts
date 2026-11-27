// @vitest-environment happy-dom
// 찾기 · 바꾸기 — 글자만 바꾸고 태그 · 속성은 건드리지 않으며, 쪽마다 되돌리기 한 걸음 (npm test)
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
vi.mock("./api", () => ({
	api: new Proxy({
		readText: async (_d: string, f: string) => { if (!files.has(f)) throw new Error("none"); return files.get(f)!; },
		writeText: async (_d: string, f: string, t: string) => void files.set(f, t),
	} as Record<string, unknown>, { get: (o, k) => o[k as string] ?? (async () => null) }),
	deckUrl: () => "",
}));

import { useDeck } from "./store";

const page = (body: string) => `<!doctype html><html><head><style>.a{content:"Alpha"}</style></head><body><section class="slide">${body}</section></body></html>`;

describe("찾기 · 바꾸기", () => {
	beforeEach(() => {
		files.clear();
		files.set("s/1.html", page(`<h1 title="Alpha">Alpha beta</h1><p>alpha <b>ALPHA</b></p>`));
		files.set("s/2.html", page(`<p>nothing</p>`));
		useDeck.setState({ dir: "D", deck: { format: "1", title: "t", size: { w: 1280, h: 720 }, theme: "theme.css", created: "", updated: "", slides: [{ id: "a", file: "s/1.html" }, { id: "b", file: "s/2.html" }] } as never });
	});

	it("쪽마다 찾은 수 — 대소문자 구분 끔 · 켬, 속성 · 스타일은 세지 않는다", async () => {
		expect(await useDeck.getState().findText("alpha", false)).toEqual([3, 0]);
		expect(await useDeck.getState().findText("Alpha", true)).toEqual([1, 0]);
	});

	it("모두 바꾸기는 글자만 바꾸고, 특수 문자도 글자 그대로 찾는다", async () => {
		expect(await useDeck.getState().replaceText("alpha", "$&γ.", false)).toBe(3);
		const out = files.get("s/1.html")!;
		expect(out).toContain(`title="Alpha"`);
		expect(out).toContain(`content:"Alpha"`);
		expect(out).toContain(">$&amp;γ. beta<");
		expect(out).toContain("<b>$&amp;γ.</b>");
		expect(await useDeck.getState().findText("a.b", false)).toEqual([0, 0]);
	});

	it("쪽을 골라 바꾸고 되돌리기로 돌아간다", async () => {
		const before = files.get("s/1.html");
		expect(await useDeck.getState().replaceText("beta", "B", true, ["b"])).toBe(0);
		expect(await useDeck.getState().replaceText("beta", "B", true, ["a"])).toBe(1);
		await useDeck.getState().undo();
		expect(files.get("s/1.html")).toBe(before);
	});
});
