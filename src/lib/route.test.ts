// 세션 묶음 (2026.11.27) — 세션 공유가 꺼져 있으면 사람마다 자기 세션 묶음 안에서만 고르고 확정한다 (npm test)
import { beforeAll, describe, expect, it, vi } from "vitest";

// store 가 부르는 슬라이드 창 도구는 브라우저 창이 있어야 한다 — 여기서 쓰지 않으므로 비워 둔다
vi.mock("./frames", () => ({ ask: vi.fn(), offscreen: vi.fn(), onFrame: vi.fn() }));
import { DEFAULTS, useSettings } from "./settings";
import { bindKey, inPool, nextSession, routeOf, type Session } from "./store";
import type { Deck } from "./deck";

const deck: Deck = { format: "1", title: "t", size: { w: 1280, h: 720 }, slides: [{ id: "a", file: "slides/a.html" }, { id: "b", file: "slides/b.html" }] as Deck["slides"], theme: "theme.css", created: "", updated: "" };
const sessions: Session[] = [
	{ key: "s1", claude: null, at: 0 },
	{ key: "s2", claude: null, at: 0, owner: "dev1" },
	{ key: "s3", claude: null, at: 0, owner: "dev2" },
];
const base = { deck, current: 0, pins: [], sessions, talkKey: "s1" };

beforeAll(() => useSettings.setState({ s: { ...DEFAULTS, collab: { ...DEFAULTS.collab, on: true } } }));

describe("세션 묶음", () => {
	it("묶음 안의 세션만 — 남의 세션을 보던 중에 보내도 내 세션으로", () => {
		expect(routeOf({ ...base, bind: {}, talkKey: "s1" }, "x", "dev1").key).toBe("s2");
		expect(routeOf({ ...base, bind: {}, talkKey: "s2" }, "x", "").key).toBe("s1");
		expect(routeOf({ ...base, bind: {}, talkKey: "s1" }, "x", "dev9").key).toBeNull();
	});

	it("쪽 확정은 묶음마다 — 덱 주인이 확정한 쪽도 팀원은 자기 세션으로", () => {
		const bind = { a: "s1", [bindKey("dev1", "a")]: "s2" };
		expect(routeOf({ ...base, bind, talkKey: "s1" }, "x", "").key).toBe("s1");
		expect(routeOf({ ...base, bind, talkKey: null }, "x", "dev1")).toMatchObject({ key: "s2", via: 1 });
		expect(routeOf({ ...base, bind, talkKey: null }, "x", "dev2").via).toBeUndefined();
	});

	it("세션 공유(묶음 없음)는 전처럼 모든 세션 · 쪽 id 그대로", () => {
		expect(routeOf({ ...base, bind: { a: "s3" }, talkKey: "s1" }, "x", undefined).key).toBe("s3");
		expect(bindKey(undefined, "a")).toBe("a");
		expect(sessions.filter((x) => inPool(x, undefined))).toHaveLength(3);
	});

	it("새 세션은 그 사람 것으로, 번호는 덱 하나에서 이어 간다", () => {
		expect(nextSession(sessions, "dev1")).toMatchObject({ key: "s4", owner: "dev1" });
		expect(nextSession(sessions, "").owner).toBeUndefined();
	});
});
