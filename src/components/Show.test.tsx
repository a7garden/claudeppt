// @vitest-environment happy-dom
// 확대 걸음 · 슬라이드 쇼 키 (npm test). 슬라이드 창은 그리지 않는다
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./Workspace", () => ({ SlideFrame: () => null }));
vi.mock("../lib/store", async () => {
	const { create } = await import("zustand");
	const useDeck = create<{ deck: unknown; current: number; rev: Record<string, number>; setCurrent: (i: number) => void }>()((set, get) => ({
		deck: { size: { w: 1280, h: 720 }, slides: [{ id: "a", file: "a.html" }, { id: "b", file: "b.html" }, { id: "c", file: "c.html" }] },
		current: 0,
		rev: {},
		setCurrent: (i) => set({ current: Math.max(0, Math.min(i, (get().deck as { slides: unknown[] }).slides.length - 1)) }),
	}));
	return { useDeck };
});
vi.mock("../lib/i18n", () => ({ useT: () => (k: string) => k }));

import { useDeck } from "../lib/store";
import { SlideShow, startShow, useView, zoomStep } from "./Show";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("확대 걸음 (zoomStep)", () => {
	afterEach(() => useView.getState().setZoom(null));

	it("맞춤에서 한 걸음씩 오르내린다", () => {
		zoomStep(1, 0.6);
		expect(useView.getState().zoom).toBe(0.66);
		zoomStep(1, 0.6);
		expect(useView.getState().zoom).toBe(0.75);
	});

	it("맞춤 배율을 지나가면 맞춤에서 한 번 멈춘다", () => {
		useView.getState().setZoom(0.66);
		zoomStep(-1, 0.6);
		expect(useView.getState().zoom).toBeNull();
	});
});

describe("슬라이드 쇼", () => {
	const key = (k: string) => act(() => { dispatchEvent(new KeyboardEvent("keydown", { key: k })); });

	it("→ 다음 · ← 이전 · 끝 화면 다음에 닫힌다 · 숫자+Enter 로 그 쪽", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		startShow(0);
		expect(useView.getState().show).toBe(true);
		await act(async () => root.render(<SlideShow />));
		await key("ArrowRight");
		expect(useDeck.getState().current).toBe(1);
		await key("ArrowLeft");
		expect(useDeck.getState().current).toBe(0);
		await key("3");
		await key("Enter");
		expect(useDeck.getState().current).toBe(2);
		await key(" ");
		expect(host.querySelector(".show-end")).not.toBeNull();
		await key(" ");
		expect(useView.getState().show).toBe(false);
		act(() => root.unmount());
	});

	it("Esc 로 닫는다", async () => {
		const host = document.createElement("div");
		const root = createRoot(host);
		startShow();
		await act(async () => root.render(<SlideShow />));
		await key("Escape");
		expect(useView.getState().show).toBe(false);
		act(() => root.unmount());
	});
});
