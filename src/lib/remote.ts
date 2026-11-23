// 바깥 제어 — 앱 밖 Claude Code 가 CLI 로 보낸 명령을 받아 처리한다 (src-tauri/src/control.rs · cli.rs).
//
//   status · refresh         열린 덱 · 앱 안 Claude 가 일하는 중인지 / CLI 가 판을 남긴 뒤 판 목록 다시 읽기
//   open                     덱을 화면에 연다 · 그 쪽으로 간다
//   new · import             서재에 새 덱 — 앱의 처음 화면 · 가져오기와 같은 길(createDeck · flows.importDeck)
//   export · shot · inspect  웹뷰가 쪽을 그려야 하는 일 — 내보내기와 같은 런타임(rt.js)의 extract · snapshot 을 쓴다
//   check · release          비교 검사 · 릴리즈 — 앱의 단추와 같은 함수(runCheck · makeRelease)
//
// 열려 있지 않은 덱도 화면을 바꾸지 않고 처리한다 — deck:// 에 잠깐 올렸다가(api.open) 감시만 내린다.
// 오래 걸리는 일은 오른쪽 아래 진행 막대(jobs)에 「CLI · …」 로 보인다 — 사용자가 밖에서 무엇을 시켰는지 알게.
// 앱 안 Claude 가 일하는 중이면 화면의 덱을 바꾸지 않는다 — 덱을 닫으면 그 턴이 멈춘다 (store.closeProject).
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { api, bytesFromB64, join } from "./api";
import { createDeck, type Deck, readDeck } from "./deck";
import { buildPptx } from "./exportPptx";
import { freeDir, importDeck } from "./flows";
import { ask, offscreen } from "./frames";
import { runCheck } from "./check";
import { tNow } from "./i18n";
import { useSettings } from "./settings";
import { makeRelease, type Release, useDeck } from "./store";

type Args = Record<string, any>;

const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
const same = (a: string, b: string) => !!a && !!b && norm(a) === norm(b);

/** 덱을 deck:// 에 올려 둔 채 fn 을 돌린다. 화면에 열린 덱이면 그 id 를 그대로 쓴다 */
async function withDeck<T>(dir: string, fn: (id: string, deck: Deck) => Promise<T>): Promise<T> {
	const deck = await readDeck(dir);
	const st = useDeck.getState();
	if (same(st.dir, dir)) return fn(st.id, deck);
	const id = await api.open(dir);
	try {
		return await fn(id, deck);
	} finally {
		// 그새 사용자가 이 덱을 열었으면 감시를 내리지 않는다
		if (!same(useDeck.getState().dir, dir)) await api.close(id).catch(() => {});
	}
}

/** 진행 막대 하나를 띄우고 일을 돌린다 */
async function job<T>(label: string, fn: (step: (i: number, n: number) => void) => Promise<T>): Promise<T> {
	const id = "cli" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
	const step = (i: number, n: number) => useDeck.setState((s) => ({
		jobs: s.jobs.some((j) => j.id === id) ? s.jobs.map((j) => (j.id === id ? { ...j, i, n } : j)) : [...s.jobs, { id, label: `CLI · ${label}`, i, n }],
	}));
	step(0, 0);
	try { return await fn(step); } finally { useDeck.setState((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })); }
}

/** 쪽 번호(1부터) 목록 → 쪽. null 이면 모든 쪽 */
function pick(deck: Deck, nums: number[] | null) {
	const all = deck.slides.map((ref, i) => ({ no: i + 1, ref }));
	if (!nums) return all;
	const bad = nums.filter((n) => n < 1 || n > all.length);
	if (bad.length) throw new Error(`없는 쪽: ${bad.join(", ")} (이 덱은 ${all.length}쪽)`);
	return nums.map((n) => all[n - 1]);
}

const titleOf = (dir: string, d: Deck) => d.title || dir.split(/[\\/]/).pop();

function status() {
	const st = useDeck.getState();
	return {
		app: true,
		dir: st.dir || null,
		title: st.deck?.title ?? null,
		slides: st.deck?.slides.length ?? null,
		slide: st.deck ? st.current + 1 : null,
		version: st.versions[0]?.n ?? null,
		running: !!st.running,
		busy: st.busy,
		jobs: st.jobs.map((j) => j.label),
	};
}

/** 화면의 덱을 바꾼다. 앱 안 Claude 가 다른 덱을 고치는 중이면 바꾸지 않는다 */
async function show(dir: string, slide?: number | null) {
	const st = useDeck.getState();
	if (!same(st.dir, dir)) {
		if (st.running) throw new Error("앱 안 Claude 가 다른 덱을 고치는 중이라 화면을 바꾸지 않았다");
		await st.openProject(dir);
	}
	if (slide) useDeck.getState().setCurrent(slide - 1);
}

const handlers: Record<string, (a: Args) => Promise<unknown>> = {
	status: async () => status(),

	refresh: async ({ dir }) => {
		const st = useDeck.getState();
		if (!same(st.dir, dir)) return { refreshed: false };
		await st.refreshVersions();
		try { useDeck.setState({ releases: JSON.parse(await api.readText(st.dir, "releases/releases.json")) }); } catch {}
		return { refreshed: true };
	},

	open: async ({ dir, slide }) => {
		await show(dir, slide);
		return status();
	},

	new: async ({ title, open }) => {
		const s = useSettings.getState().s;
		const t = String(title || "").trim() || tNow("untitled");
		const dir = await freeDir(t);
		await createDeck(dir, t, s);
		let opened = false;
		if (open && !useDeck.getState().running) {
			await useDeck.getState().openProject(dir);
			opened = true;
		} else {
			await api.commit(dir, "새로 만든다");
		}
		return { dir, title: t, opened };
	},

	import: async ({ path, open }) => {
		const name = String(path).split(/[\\/]/).pop()!;
		const r = await job(name, (step) => importDeck(path, step));
		const opened = !!open && !useDeck.getState().running;
		if (opened) await useDeck.getState().openProject(r.dir);
		return { dir: r.dir, title: r.deck.title, slides: r.deck.slides.length, warnings: r.warnings, opened };
	},

	export: async ({ dir, out, exact }) =>
		withDeck(dir, (id, deck) =>
			job(`${titleOf(dir, deck)} → PPTX`, async (step) => {
				const b = await buildPptx(deck, id, step, !!exact);
				await api.absWriteBytes(out, b.data);
				return { out, slides: deck.slides.length, exact: !!exact, missingFonts: b.missingFonts };
			}),
		),

	shot: async ({ dir, slides, out, scale }) =>
		withDeck(dir, async (id, deck) => {
			const list = pick(deck, slides);
			const files: { no: number; id: string; file: string }[] = [];
			for (const { no, ref } of list) {
				const { win, dispose } = await offscreen(id, ref.file, deck.size.w, deck.size.h);
				let snap: any;
				try { snap = await ask(win, { t: "snapshot", scale: scale || 1 }, 60000); } finally { dispose(); }
				if (snap.error) throw new Error(`${no}쪽: ${snap.error}`);
				const file = join(out, `${no}.png`);
				await api.absWriteBytes(file, bytesFromB64(snap.data.split(",")[1]));
				files.push({ no, id: ref.id, file });
			}
			return { size: deck.size, scale: scale || 1, files };
		}),

	inspect: async ({ dir, slides }) =>
		withDeck(dir, async (id, deck) => {
			const { w: W, h: H } = deck.size;
			const out = [];
			for (const { no, ref } of pick(deck, slides)) {
				const { win, dispose } = await offscreen(id, ref.file, W, H);
				let res: any;
				try { res = await ask(win, { t: "extract" }, 30000); } finally { dispose(); }
				if (res.error) throw new Error(`${no}쪽: ${res.error}`);
				const items: any[] = res.data.items;
				const count: Record<string, number> = {};
				for (const it of items) count[it.type] = (count[it.type] || 0) + 1;
				const r = (v: number) => Math.round(v);
				const boxOf = (it: any) => it.type === "line"
					? { x: r(Math.min(it.x1, it.x2)), y: r(Math.min(it.y1, it.y2)), w: r(Math.abs(it.x2 - it.x1)), h: r(Math.abs(it.y2 - it.y1)) }
					: { x: r(it.x), y: r(it.y), w: r(it.w), h: r(it.h) };
				// 쪽 밖으로 1px 넘게 나간 것 — PPTX 에서는 잘리지 않고 쪽 밖에 그대로 보인다
				const overflow = items
					.map((it) => ({ it, b: boxOf(it) }))
					.filter(({ b }) => b.x < -1 || b.y < -1 || b.x + b.w > W + 1 || b.y + b.h > H + 1)
					.map(({ it, b }) => ({ type: it.type, ...b, text: it.runs ? it.runs.map((x: any) => x.text || "").join("").slice(0, 40) : undefined }));
				out.push({
					no,
					id: ref.id,
					file: ref.file,
					count,
					// 그림으로 굳는 것 — whole: 그 요소와 자식 전부(<img> · <svg> 는 원래 그림이라 괜찮다) · background: 바탕만 그림, 글자는 편집 가능
					baked: items.filter((it) => it.type === "image").map((it) => ({ baked: it.baked, tag: it.tag, ...boxOf(it) })),
					overflow,
					fails: res.data.fails,
				});
			}
			return { size: deck.size, slides: out };
		}),

	check: async ({ dir }) =>
		withDeck(dir, (id, deck) =>
			job(`${titleOf(dir, deck)} · 비교`, async (step) => {
				const log = await api.log(dir, 1);
				let k = 0;
				const report = await runCheck(dir, id, deck, log[0]?.n ?? 0, () => step(++k, 0));
				if (same(useDeck.getState().dir, dir)) useDeck.setState({ report, compare: true });
				return { ...report, slides: report.slides.map((x) => ({ ...x, web: join(dir, x.web), ppt: join(dir, x.ppt), diff: join(dir, x.diff) })) };
			}),
		),

	release: async ({ dir, name, notes }) =>
		withDeck(dir, (id, deck) =>
			job(`${titleOf(dir, deck)} · 릴리즈`, async (step) => {
				let prev: Release[] = [];
				try { prev = JSON.parse(await api.readText(dir, "releases/releases.json")); } catch {}
				const rel = await makeRelease(dir, id, deck, prev, name || "", notes || "", step);
				const st = useDeck.getState();
				if (same(st.dir, dir)) {
					useDeck.setState({ releases: [...prev, rel] });
					await st.refreshVersions();
				}
				return { ...rel, path: join(dir, rel.file) };
			}),
		),
};

let started = false;

/** 설정을 읽은 뒤 한 번 부른다 — 서재 경로 · 도형 설정이 있어야 새 덱을 만든다 */
export async function startRemote() {
	if (started) return;
	started = true;
	await listen<{ id: string; cmd: string; args: Args }>("remote", async (e) => {
		const { id, cmd, args } = e.payload;
		const h = handlers[cmd];
		let reply: unknown;
		try {
			if (!h) throw new Error(`모르는 명령: ${cmd}`);
			reply = { ok: true, data: (await h(args || {})) ?? null };
		} catch (err) {
			reply = { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		await invoke("remote_reply", { id, reply });
	});
	// 설정 「바깥 연결 › 바깥 제어」를 통로에 알린다 — control.json 을 쓰기 전에, 그리고 바뀔 때마다
	const sync = (on: boolean) => invoke("remote_set_enabled", { on }).catch(() => {});
	await sync(useSettings.getState().s.remote.enabled);
	useSettings.subscribe((x, y) => { if (x.s.remote.enabled !== y.s.remote.enabled) sync(x.s.remote.enabled); });
	await invoke("remote_ready");
}
