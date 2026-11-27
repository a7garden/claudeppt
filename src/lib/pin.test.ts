// @vitest-environment happy-dom
// 핀이 가리킨 요소 찾기 (2026.11.27) — 보낼 때 원본에서 그 요소를 찾아 CSS 경로 · HTML 조각을 붙인다 (npm test)
import { describe, expect, it, vi } from "vitest";

// edits.ts 가 부르는 앱 명령은 여기서 쓰지 않는다
vi.mock("./api", () => ({ api: {} }));
import { locate } from "./edits";
import { pinLine } from "./prompt";

const SLIDE = `<!doctype html><html><head></head><body><section class="slide">
<h1>분기 <b>실적</b> 보고</h1>
<div class="card"><p>매출 120억</p><img src="a.png" alt="매출 그래프"></div>
<div class="card"><p>매출 120억</p></div>
</section></body></html>`;

describe("핀이 가리킨 요소", () => {
	it("같은 글이 두 곳에 있어도 꽂은 그 요소를 가리킨다", () => {
		const a = locate(SLIDE, [1, 0], "매출 120억")!;
		const b = locate(SLIDE, [2, 0], "매출 120억")!;
		expect(a.css).toBe("section.slide > div:nth-child(2) > p:nth-child(1)");
		expect(b.css).toBe("section.slide > div:nth-child(3) > p:nth-child(1)");
		expect(a.html).toBe("<p>매출 120억</p>");
	});

	it("글 없는 요소(그림)는 alt 로 맞춰 본다", () => {
		expect(locate(SLIDE, [1, 1], "매출 그래프")?.css).toBe("section.slide > div:nth-child(2) > img:nth-child(2)");
	});

	it("낱말 하나에 꽂혀도 그 제목을 가리킨다", () => {
		const r = locate(SLIDE, [0, 0], "실적")!;
		expect(r.css).toBe("section.slide > h1:nth-child(1)");
		expect(r.html).toContain("분기 <b>실적</b> 보고");
	});

	it("그 뒤 쪽이 바뀌어 같은 길이 다른 요소면 쓰지 않는다 · 없는 길 · 쪽 뿌리도", () => {
		expect(locate(SLIDE, [1, 0], "전혀 다른 글")).toBeNull();
		expect(locate(SLIDE, [9], "")).toBeNull();
		expect(locate(SLIDE, [], "")).toBeNull();
		expect(locate(SLIDE, null, "")).toBeNull();
	});

	it("찾았으면 Claude 에게 그 요소만 고치라 이른다 · 못 찾았으면 전처럼", () => {
		const at = locate(SLIDE, [1, 0], "매출 120억")!;
		const base = { n: 1, slide: "s1", slideNo: 3, x: 10, y: 20, text: "굵게", file: "slides/s1.html" };
		const line = pinLine({ ...base, target: { tag: "p", text: "매출 120억", path: [1, 0], ...at } });
		expect(line).toContain("on the element `section.slide > div:nth-child(2) > p:nth-child(1)`");
		expect(line).toContain("That element now: <p>매출 120억</p>");
		expect(line).toContain("change it (and what is inside it) only");
		expect(pinLine({ ...base, target: { tag: "p", text: "매출 120억", path: [1, 0] } })).toContain('on <p> "매출 120억"');
	});
});
