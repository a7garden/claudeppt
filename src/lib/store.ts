// 열린 프로젝트 하나의 상태 — 덱 · 쪽마다 다시 그릴 표식 · 핀 · 대화 · 판.
//
// 목차
//   열기 · 닫기          openProject · closeProject (폴더 감시와 deck:// 등록은 Rust)
//   핫 리로드            onFs — deck.json 이면 목차를, 쪽 HTML 이면 그 쪽만, CSS 면 CSS 만 다시 읽힌다
//   핀                   addPin · updatePin · removePin → .claudeppt/pins.json
//   대화                 send → claude 한 턴 → 그림 채우기 → 한 판으로 남김 → .claudeppt/talk.json
//   직접 편집            applyDirect → 원본 HTML 에 되쓰고 잠시 뒤 한 판으로 남김
//   판 · 릴리즈          refreshVersions · preview · restore · release
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api, type Commit } from "./api";
import { type Deck, readDeck, writeDeck } from "./deck";
import { applyOp, type Op } from "./edits";
import { buildPptx } from "./exportPptx";
import { tell } from "./frames";
import { tNow } from "./i18n";
import { fillGenerated } from "./imagegen";
import { type PinNote, systemPrompt, turnPrompt } from "./prompt";
import { useSettings } from "./settings";

export interface Pin { id: string; slide: string; x: number; y: number; text: string; target?: PinNote["target"]; at: number }
export interface ToolUse { name: string; file?: string }
export interface Turn {
	id: string;
	at: number;
	request: string;
	pins: PinNote[];
	reply: string;
	tools: ToolUse[];
	status: "running" | "done" | "failed" | "stopped";
	cost?: number;
	version?: { n: number; short: string; hash: string };
	error?: string;
	phase?: string;
}
export interface Release { name: string; tag: string; n: number; hash: string; file: string; notes: string; at: string }
export type Mode = "view" | "pin" | "edit";

interface S {
	dir: string;
	id: string;
	deck: Deck | null;
	rev: Record<string, number>;
	current: number;
	mode: Mode;
	pins: Pin[];
	turns: Turn[];
	sessionId: string | null;
	running: string | null;
	versions: Commit[];
	releases: Release[];
	preview: Commit | null;
	busy: string | null;
	toast: { text: string; kind: "ok" | "err" } | null;
	frames: Set<Window>;

	openProject: (dir: string) => Promise<void>;
	closeProject: () => Promise<void>;
	setCurrent: (i: number) => void;
	setMode: (m: Mode) => void;
	addPin: (p: Omit<Pin, "id" | "at">) => string;
	updatePin: (id: string, text: string) => void;
	removePin: (id: string) => void;
	send: (text: string, attachments?: string[]) => Promise<void>;
	stop: () => void;
	applyDirect: (slideId: string, path: number[] | null, op: Op) => Promise<void>;
	refreshVersions: () => Promise<void>;
	setPreview: (c: Commit | null) => void;
	restore: (c: Commit) => Promise<void>;
	exportTo: (path: string) => Promise<void>;
	release: (name: string, notes: string) => Promise<void>;
	notify: (text: string, kind?: "ok" | "err") => void;
	saveDeck: (deck: Deck) => Promise<void>;
}

let unlisten: (() => void)[] = [];
let directTimer: ReturnType<typeof setTimeout> | undefined;

const persistPins = (dir: string, pins: Pin[]) => api.writeText(dir, ".claudeppt/pins.json", JSON.stringify(pins, null, 1)).catch(() => {});
const persistTalk = (dir: string, turns: Turn[], sessionId: string | null) =>
	api.writeText(dir, ".claudeppt/talk.json", JSON.stringify({ sessionId, turns: turns.map((t) => (t.status === "running" ? { ...t, status: "stopped" } : t)) }, null, 1)).catch(() => {});
const readJson = async <T,>(dir: string, rel: string, d: T): Promise<T> => {
	try { return JSON.parse(await api.readText(dir, rel)); } catch { return d; }
};

/** Claude 가 고친 파일 경로를 프로젝트 기준 상대 경로로 */
const relOf = (dir: string, p?: string) => {
	if (!p) return undefined;
	const a = p.replace(/\\/g, "/"), d = dir.replace(/\\/g, "/").replace(/\/$/, "") + "/";
	return a.toLowerCase().startsWith(d.toLowerCase()) ? a.slice(d.length) : a;
};

export const useDeck = create<S>()((set, get) => ({
	dir: "",
	id: "",
	deck: null,
	rev: {},
	current: 0,
	mode: "view",
	pins: [],
	turns: [],
	sessionId: null,
	running: null,
	versions: [],
	releases: [],
	preview: null,
	busy: null,
	toast: null,
	frames: new Set(),

	openProject: async (dir) => {
		await get().closeProject();
		const deck = await readDeck(dir);
		const id = await api.open(dir);
		await api.vcsInit(dir);
		const pins = await readJson<Pin[]>(dir, ".claudeppt/pins.json", []);
		const talk = await readJson<{ sessionId: string | null; turns: Turn[] }>(dir, ".claudeppt/talk.json", { sessionId: null, turns: [] });
		const releases = await readJson<Release[]>(dir, "releases/releases.json", []);
		set({ dir, id, deck, rev: {}, current: 0, mode: "view", pins, turns: talk.turns, sessionId: talk.sessionId, versions: [], releases, preview: null });
		useSettings.getState().remember(dir);
		// 처음 여는 프로젝트(가져오기 직후)면 첫 판을 남긴다
		const log = await api.log(dir, 1);
		if (!log.length) await api.commit(dir, deck.source?.kind === "pptx" ? "PPTX 를 가져온다" : "새로 만든다");
		await get().refreshVersions();

		unlisten.push(
			await listen<{ id: string; paths: string[] }>("deck-fs", async (e) => {
				if (e.payload.id !== get().id) return;
				const paths = e.payload.paths;
				if (paths.includes("deck.json")) {
					try { set({ deck: await readDeck(get().dir) }); } catch { /* 쓰는 도중 — 다음 사건에서 다시 읽는다 */ }
				}
				const deck = get().deck;
				if (!deck) return;
				const rev = { ...get().rev };
				const now = Date.now();
				let all = false;
				for (const p of paths) {
					const s = deck.slides.find((s) => s.file === p);
					if (s) rev[s.id] = now;
					else if (p.startsWith("assets/") && !p.startsWith("assets/fonts/")) all = true;
				}
				if (all) for (const s of deck.slides) rev[s.id] = now;
				if (paths.some((p) => p.endsWith(".css"))) for (const w of get().frames) tell(w, { t: "css" });
				set({ rev });
			}),
		);
		unlisten.push(
			await listen<{ turn: string; line: string }>("claude", (e) => {
				const { turn, line } = e.payload;
				let m: any;
				try { m = JSON.parse(line); } catch { return; }
				const patch = (fn: (t: Turn) => Turn) => set({ turns: get().turns.map((t) => (t.id === turn ? fn(t) : t)) });
				if (m.type === "system" && m.subtype === "init" && m.session_id) set({ sessionId: m.session_id });
				else if (m.type === "stream_event" && m.event?.type === "content_block_delta" && m.event.delta?.type === "text_delta") {
					patch((t) => ({ ...t, reply: t.reply + m.event.delta.text }));
				} else if (m.type === "stream_event" && m.event?.type === "message_start") {
					// 도구를 쓴 뒤 새 말 덩이 — 앞 덩이와 띄운다
					patch((t) => ({ ...t, reply: t.reply && !t.reply.endsWith("\n\n") ? t.reply + "\n\n" : t.reply }));
				} else if (m.type === "assistant") {
					const uses = (m.message?.content || []).filter((c: any) => c.type === "tool_use");
					if (uses.length) patch((t) => ({ ...t, tools: [...t.tools, ...uses.map((u: any) => ({ name: u.name, file: relOf(get().dir, u.input?.file_path || u.input?.path || u.input?.pattern) }))] }));
				} else if (m.type === "result") {
					if (m.session_id) set({ sessionId: m.session_id });
					patch((t) => ({ ...t, cost: m.total_cost_usd, reply: (m.result || t.reply || "").trim(), error: m.is_error ? m.result || "error" : t.error }));
				}
			}),
		);
	},

	closeProject: async () => {
		unlisten.forEach((f) => f());
		unlisten = [];
		const { id } = get();
		if (id) await api.close(id).catch(() => {});
		set({ dir: "", id: "", deck: null, turns: [], pins: [], versions: [], preview: null, running: null });
	},

	setCurrent: (i) => set({ current: Math.max(0, Math.min(i, (get().deck?.slides.length || 1) - 1)) }),
	setMode: (mode) => {
		set({ mode });
		for (const w of get().frames) tell(w, { t: "mode", mode });
	},

	addPin: (p) => {
		const pin: Pin = { ...p, id: Math.random().toString(36).slice(2, 9), at: Date.now() };
		const pins = [...get().pins, pin];
		set({ pins });
		persistPins(get().dir, pins);
		return pin.id;
	},
	updatePin: (id, text) => {
		const pins = get().pins.map((p) => (p.id === id ? { ...p, text } : p));
		set({ pins });
		persistPins(get().dir, pins);
	},
	removePin: (id) => {
		const pins = get().pins.filter((p) => p.id !== id);
		set({ pins });
		persistPins(get().dir, pins);
	},

	send: async (text, attachments = []) => {
		const { dir, deck, pins, running, current } = get();
		if (!deck || running) return;
		if (!text.trim() && !pins.length) return;
		const s = useSettings.getState().s;
		// 직접 편집이 남아 있으면 먼저 판으로 — Claude 의 판과 섞이지 않게
		clearTimeout(directTimer);
		await api.commit(dir, tNow("direct")).catch(() => {});
		const order = (id: string) => deck.slides.findIndex((x) => x.id === id) + 1;
		const notes: PinNote[] = pins.map((p, i) => ({ n: i + 1, slide: p.slide, slideNo: order(p.slide), x: p.x, y: p.y, text: p.text, target: p.target }));
		const cur = deck.slides[current];
		const turn: Turn = { id: "t" + Date.now().toString(36), at: Date.now(), request: text.trim(), pins: notes, reply: "", tools: [], status: "running" };
		set({ turns: [...get().turns, turn], running: turn.id, pins: [] });
		persistPins(dir, []);
		const patch = (fn: (t: Turn) => Turn) => set({ turns: get().turns.map((t) => (t.id === turn.id ? fn(t) : t)) });

		try {
			const r = await api.claudeRun({
				turn: turn.id,
				dir,
				prompt: turnPrompt(text, notes, cur ? { id: cur.id, no: current + 1 } : null, attachments),
				system: systemPrompt(s, deck),
				claudePath: s.claude.path,
				model: s.claude.model,
				effort: s.claude.effort,
				resume: get().sessionId,
			});
			const t0 = get().turns.find((t) => t.id === turn.id)!;
			let status: Turn["status"] = t0.status === "stopped" ? "stopped" : r.code === 0 && !t0.error ? "done" : "failed";
			if (status === "failed" && !t0.error) patch((t) => ({ ...t, error: r.stderr.trim().split("\n").slice(-3).join("\n") || `exit ${r.code}` }));
			// 그림 자리 채우기
			const fresh = await readDeck(dir).catch(() => get().deck!);
			set({ deck: fresh });
			if (status !== "stopped" && s.image.provider !== "svg") {
				const errs = await fillGenerated(dir, fresh, s, (p) => patch((t) => ({ ...t, phase: `${tNow("generating")} · ${p}` })));
				if (errs.length) patch((t) => ({ ...t, error: [t.error, ...errs].filter(Boolean).join("\n") }));
			}
			const summary = (text.trim() || notes.map((n) => n.text).join(" · ") || "핀").replace(/\s+/g, " ").slice(0, 72);
			const c = await api.commit(dir, summary).catch(() => null);
			patch((t) => ({ ...t, status, phase: undefined, version: c ? { n: c.n, short: c.short, hash: c.hash } : undefined }));
		} catch (e) {
			patch((t) => ({ ...t, status: "failed", error: String(e) }));
		} finally {
			set({ running: null });
			persistTalk(dir, get().turns, get().sessionId);
			get().refreshVersions();
		}
	},

	stop: () => {
		const r = get().running;
		if (!r) return;
		set({ turns: get().turns.map((t) => (t.id === r ? { ...t, status: "stopped" } : t)) });
		api.claudeStop(r);
	},

	applyDirect: async (slideId, path, op) => {
		const { dir, deck } = get();
		const ref = deck?.slides.find((s) => s.id === slideId);
		if (!ref) return;
		await applyOp(dir, ref.file, path, op);
		clearTimeout(directTimer);
		// 손으로 고친 것은 몇 번이고 이어서 하므로 잠잠해지면 한 판으로 묶는다
		directTimer = setTimeout(async () => {
			await api.commit(dir, tNow("direct")).catch(() => null);
			get().refreshVersions();
		}, 4000);
	},

	refreshVersions: async () => {
		const { dir } = get();
		if (!dir) return;
		set({ versions: await api.log(dir).catch(() => []) });
	},

	setPreview: (c) => set({ preview: c && c.hash === get().versions[0]?.hash ? null : c }),

	restore: async (c) => {
		const { dir } = get();
		set({ busy: tNow("restore") });
		try {
			await api.restore(dir, c.hash, `v${c.n} 으로 되돌린다`);
			set({ preview: null, deck: await readDeck(dir) });
			await get().refreshVersions();
		} catch (e) {
			get().notify(String(e), "err");
		} finally {
			set({ busy: null });
		}
	},

	exportTo: async (path) => {
		const { deck, id } = get();
		if (!deck) return;
		set({ busy: tNow("exporting") });
		try {
			const b64 = await buildPptx(deck, id, (i, n) => set({ busy: `${tNow("exporting")} ${i}/${n}` }));
			await api.absWrite(path, b64);
			get().notify(path.split(/[\\/]/).pop()!, "ok");
		} catch (e) {
			get().notify(String(e), "err");
		} finally {
			set({ busy: null });
		}
	},

	release: async (name, notes) => {
		const { dir, deck, id } = get();
		if (!deck) return;
		set({ busy: tNow("release") });
		try {
			await api.commit(dir, tNow("direct")).catch(() => null);
			const head = (await api.log(dir, 1))[0];
			const k = get().releases.length + 1;
			const tag = `r${k}`;
			const file = `releases/${tag}-v${head.n + 1}.pptx`;
			const b64 = await buildPptx(deck, id, (i, n) => set({ busy: `${tNow("release")} ${i}/${n}` }));
			await api.writeB64(dir, file, b64);
			const rel: Release = { name: name.trim() || tag, tag, n: head.n + 1, hash: "", file, notes: notes.trim(), at: new Date().toISOString() };
			const releases = [...get().releases, rel];
			await api.writeText(dir, "releases/releases.json", JSON.stringify(releases, null, 2) + "\n");
			const c = await api.commit(dir, `릴리즈 ${tag} — ${rel.name}`);
			if (c) {
				await api.tag(dir, tag);
				rel.hash = c.hash;
				rel.n = c.n;
			}
			set({ releases });
			await get().refreshVersions();
			get().notify(`${tag} · ${rel.name}`, "ok");
		} catch (e) {
			get().notify(String(e), "err");
		} finally {
			set({ busy: null });
		}
	},

	notify: (text, kind = "ok") => {
		set({ toast: { text, kind } });
		setTimeout(() => { if (get().toast?.text === text) set({ toast: null }); }, kind === "err" ? 7000 : 3500);
	},

	saveDeck: async (deck) => {
		await writeDeck(get().dir, deck);
		set({ deck });
	},
}));
