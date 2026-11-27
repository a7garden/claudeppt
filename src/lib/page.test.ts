// 쪽 설정 · 점검 요청 · 덱 여백 규칙 — 화면 없이 도는 순수 함수만 본다 (npm test)
import { describe, expect, it, vi } from "vitest";

// 점검(audit.ts)이 부르는 슬라이드 창 도구는 브라우저 창이 있어야 한다 — 여기서 쓰지 않으므로 비워 둔다
vi.mock("./frames", () => ({ ask: vi.fn(), offscreen: vi.fn() }));

import { auditFixPrompt, type AuditReport, auditSlide, type Node } from "./audit";
import { type Deck, repageCss, rethemeCss, templateBlock } from "./deck";
import { houseStyle, pageMargins } from "./prompt";
import { mergeReview, quoteBoxes, reviewPrompt } from "./review";
import { BASIC, DEFAULTS } from "./settings";

const deck = (extra: Partial<Deck> = {}): Deck => ({ format: "1", title: "t", size: { w: 1280, h: 720 }, slides: [], theme: "theme.css", created: "", updated: "", ...extra });

describe("쪽 설정 구획 (repageCss)", () => {
	const css = `${templateBlock(BASIC)}\n\nhtml { margin: 0; }\n`;

	it("템플릿 구획 바로 뒤에 넣고, 다시 쓰면 갈아 끼우고, null 이면 걷는다", () => {
		const a = repageCss(css, { t: 40, r: 50, b: 60, l: 70 });
		expect(a).toContain("--margin-t: 40px; --margin-r: 50px; --margin-b: 60px; --margin-l: 70px;");
		expect(a.indexOf("@page start")).toBeGreaterThan(a.indexOf("@template end"));
		const b = repageCss(a, { t: 1, r: 2, b: 3, l: 4 });
		expect(b.match(/@page start/g)).toHaveLength(1);
		expect(b).toContain("--margin-l: 4px");
		expect(repageCss(b, null)).toBe(css);
	});

	it("템플릿을 다시 입혀도(rethemeCss) 쪽 설정은 남는다", () => {
		const a = repageCss(css, { t: 10, r: 10, b: 10, l: 10 });
		const b = rethemeCss(a, { ...BASIC, accent: "#123456" });
		expect(b).toContain("--accent: #123456");
		expect(b).toContain("--margin-t: 10px");
	});
});

describe("덱 여백 (pageMargins · houseStyle)", () => {
	const s = { ...DEFAULTS, templates: [BASIC], template: BASIC.id };

	it("쪽 설정이 있으면 그 값, 없으면 템플릿 여백을 네 변에, 가져온 덱에 둘 다 없으면 null", () => {
		expect(pageMargins(deck({ page: { margin: { t: 1, r: 2, b: 3, l: 4 } } }), BASIC)).toEqual({ t: 1, r: 2, b: 3, l: 4 });
		expect(pageMargins(deck(), BASIC)).toEqual({ t: BASIC.margin, r: BASIC.margin, b: BASIC.margin, l: BASIC.margin });
		expect(pageMargins(deck({ source: { kind: "pptx" } }), null)).toBeNull();
	});

	it("쪽 설정이 있을 때만 Claude 에게 네 변 여백을 말한다 — 없는 덱의 시스템 프롬프트는 그대로(캐시)", () => {
		expect(houseStyle(s, deck())).not.toContain("Page margins");
		const withPage = houseStyle(s, deck({ page: { margin: { t: 48, r: 64, b: 48, l: 64 } } }));
		expect(withPage).toContain("Top 48px, right 64px, bottom 48px, left 64px");
		expect(withPage.slice(withPage.indexOf("## Page margins"))).not.toContain("—");
	});
});

describe("점검 → Claude 에게 고치기 (auditFixPrompt)", () => {
	const report = (over: Partial<AuditReport> = {}): AuditReport => ({
		at: "", template: "기본", kinds: ["template", "layout", "slop"], note: "", margins: null,
		slides: [
			{ id: "s1", no: 1, findings: [{ rule: "dash", kind: "slop", msg: "", fix: "1 em dash." }] },
			{ id: "s2", no: 2, findings: [{ rule: "font", kind: "template", msg: "", fix: "font off." }] },
		],
		...over,
	});

	it("걸린 쪽만, 고른 갈래만 싣는다", () => {
		const all = auditFixPrompt(report());
		expect(all).toContain("slide 1 (slides/s1.html): 1 em dash.");
		expect(all).toContain("slide 2 (slides/s2.html): font off.");
		const slop = auditFixPrompt(report(), ["slop"]);
		expect(slop).toContain("slide 1");
		expect(slop).not.toContain("slide 2");
	});

	it("추가 지시를 모든 쪽에 맡기고, 걸린 곳이 없어도 지시만 보낸다", () => {
		const r = auditFixPrompt(report({ note: "숫자는 천 단위 쉼표" }));
		expect(r).toContain("Apply them to every slide, not only the ones listed above:\n숫자는 천 단위 쉼표");
		const only = auditFixPrompt(report({ note: "출처를 아래에", slides: [] }));
		expect(only).toContain("its rules found nothing");
		expect(only).toContain("Apply them to every slide:\n출처를 아래에");
	});

	it("걸린 곳도 지시도 없으면 보낼 것이 없다", () => {
		expect(auditFixPrompt(report({ slides: [] }))).toBe("");
	});
});

describe("점검 규칙 (auditSlide)", () => {
	const node = (over: Partial<Node>): Node => ({
		path: [0, 1], tag: "div", cls: "", x: 100, y: 100, w: 200, h: 40, text: "글", tbox: null,
		font: BASIC.font, size: BASIC.scale.body.size, weight: 400, color: null, fill: null, border: null,
		radius: 0, shadow: false, tshadow: false, gradient: false, clip: false, upper: false, ls: 0, li: false, ...over,
	});
	const rules = (nodes: Node[]) => auditSlide(nodes, 1280, 720, null, null).map((f) => f.rule);

	it("쪽 가장자리에 걸려 잘린 요소만 넘침으로 짚는다 — 쪽 완전히 바깥의 요소(가져온 PPTX 마스터)는 보이지 않으니 두고", () => {
		expect(rules([node({ x: 1200, w: 300 })])).toContain("overflow");
		expect(rules([node({ y: 700, h: 60 })])).toContain("overflow");
		expect(rules([node({ x: -60, y: 686, w: 46, h: 41 })])).not.toContain("overflow");
		expect(rules([node({ x: 1300, w: 50 })])).not.toContain("overflow");
		expect(rules([node({})])).not.toContain("overflow");
	});

	it("걸린 요소의 자리를 남긴다 (무대 표시)", () => {
		const f = auditSlide([node({ x: 1200, w: 300, text: "잘린 글" })], 1280, 720, null, null).find((x) => x.rule === "overflow")!;
		expect(f.boxes).toEqual([{ x: 1200, y: 100, w: 300, h: 40 }]);
	});
});

describe("Claude 검토 (review.ts)", () => {
	const node = (over: Partial<Node>): Node => ({
		path: [0, 1], tag: "div", cls: "", x: 0, y: 0, w: 100, h: 20, text: "", tbox: null,
		font: "", size: 20, weight: 400, color: null, fill: null, border: null,
		radius: 0, shadow: false, tshadow: false, gradient: false, clip: false, upper: false, ls: 0, li: false, ...over,
	});
	const per = [
		[node({ text: "야간 신고 추이", y: 40 }), node({ text: "3월 이후 야간 신고가 두 배로 늘었다", x: 80, y: 200, w: 600, h: 40, tbox: { x: 90, y: 205, w: 400, h: 30 } }), node({ path: [0], text: "야간 신고 추이 3월 이후 야간 신고가 두 배로 늘었다", w: 1280, h: 720 })],
		[node({ text: "합계 120건" })],
	];
	const report = (): AuditReport => ({
		at: "", template: "기본", kinds: ["template", "layout", "slop", "review"], note: "출처를 아래에", margins: null,
		slides: [
			{ id: "s1", no: 1, title: "추이", findings: [{ rule: "cards", kind: "slop", msg: "카드", fix: "3 look-alike cards." }, { rule: "overflow", kind: "layout", msg: "넘침", fix: "1 element runs past." }] },
			{ id: "s2", no: 2, findings: [] },
		],
	});
	const d = deck({ slides: [{ id: "s1", file: "slides/s1.html" }, { id: "s2", file: "slides/s2.html" }] as Deck["slides"] });

	it("요청에 쪽 그림 · 파일 · 글 · 규칙 결과 · 추가 지시를 싣는다", () => {
		const p = reviewPrompt(d, report(), per, "");
		expect(p).toContain("Picture: .claudeppt/audit/shots/1.png · HTML: slides/s1.html");
		expect(p).toContain("[cards] 3 look-alike cards.");
		expect(p).toContain("Rule findings: none");
		expect(p).toContain("출처를 아래에");
	});

	it("짚은 글을 품은 가장 안쪽 요소의 글 자리에 상자를 둔다", () => {
		expect(quoteBoxes(per[0], "두 배로  늘었다")).toEqual([{ x: 90, y: 205, w: 400, h: 30 }]);
		expect(quoteBoxes(per[0], "")).toEqual([]);
		expect(quoteBoxes(per[0], "없는 글")).toEqual([]);
	});

	it("답을 합친다: 쪽 검토 · 무게 순서 · 의도로 본 규칙 결과 · 여러 쪽에 걸친 것", () => {
		const answer = "검토했습니다.\n" + JSON.stringify({
			slides: [{ no: 1, findings: [
				{ topic: "wording", severity: "low", msg: "어투", fix: "Use one ending.", quote: "" },
				{ topic: "message", severity: "high", msg: "제목이 주제만 말한다", fix: "Retitle \"야간 신고 추이\".", quote: "두 배로 늘었다" },
				{ topic: "visual", msg: "", fix: "빈 msg 는 버린다" },
			], dismiss: [{ rule: "cards", reason: "내용에 맞는 나열" }] }, { no: 9, findings: [{ msg: "없는 쪽", fix: "x" }] }],
			deck: [{ topic: "facts", severity: "high", slides: [1, 2], msg: "합계가 다르다", fix: "Totals differ." }],
		});
		const r = mergeReview(report(), per, answer);
		const f = r.slides[0].findings;
		expect(f.find((x) => x.rule === "cards")!.ok).toBe("내용에 맞는 나열");
		expect(f.find((x) => x.rule === "overflow")!.ok).toBeUndefined();
		const own = f.filter((x) => x.kind === "review");
		expect(own.map((x) => x.rule)).toEqual(["review:message", "review:wording", "review:facts"]);
		expect(own[0].boxes).toEqual([{ x: 90, y: 205, w: 400, h: 30 }]);
		expect(own[2].fix).toBe("(across slides 1, 2) Totals differ.");
		// 의도로 본 것은 고치기에 실리지 않는다
		const fix = auditFixPrompt(r);
		expect(fix).not.toContain("look-alike");
		expect(fix).toContain("Retitle");
		expect(fix).toContain("1 element runs past.");
	});

	it("JSON 이 없는 답은 오류로 알린다", () => {
		expect(() => mergeReview(report(), per, "검토할 수 없습니다")).toThrow();
	});
});
