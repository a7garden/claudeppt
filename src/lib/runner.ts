// 내 PC 의 Claude 를 공유 덱에 붙이기 — 화면 쪽 (본체: src-tauri/src/runner.rs).
// 처음 화면 「공유 덱」에서 덱 주인마다 「내 Claude 쓰기」를 켠다. 켠 것은 설정(shared[].mine)에 남아 앱을 다시 켜도 다시 붙는다.
// 처음 한 번은 그 덱 주인의 공유 덱 창에서 들어가 있어야 한다(그 창의 기기 쿠키로 붙어 「내 Claude」 열쇠를 받는다). 그 뒤로는 앱을 켜자마자 열쇠로 붙는다
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { useSettings } from "./settings";
import { call } from "./transport";

export type RunnerState = "waiting" | "connected" | "running" | "error" | "off";
/** title — 덱 주인이 연 덱의 제목. 받으면 설정에 남겨 「공유 덱」 목록에 주소 대신 보인다 */
interface Status { origin: string; state: RunnerState; detail: string; title?: string }

/** origin → 상태 */
export const useRunners = create<{ st: Record<string, Status> }>()(() => ({ st: {} }));

const originOf = (url: string) => { try { return new URL(url).origin; } catch { return url; } };
export const runnerOf = (url: string) => useRunners.getState().st[originOf(url)];

let wired = false;
/** 앱을 켤 때 한 번 — 상태 사건을 받고, 켜 둔 덱 주인들에 다시 붙는다 */
export async function initRunners() {
	if (wired) return;
	wired = true;
	await listen<Status>("runner-status", (e) => {
		const st = e.payload;
		useRunners.setState((s) => ({ st: { ...s.st, [st.origin]: st } }));
		const title = st.title?.trim();
		if (title && useSettings.getState().s.shared.some((x) => originOf(x.url) === st.origin && x.title !== title)) {
			useSettings.getState().set((s) => ({ ...s, shared: s.shared.map((x) => (originOf(x.url) === st.origin ? { ...x, title } : x)) }));
		}
	});
	for (const x of useSettings.getState().s.shared.filter((x) => x.mine)) await call("runner_start", { origin: x.url }).catch(() => {});
	const list = await call<Status[]>("runner_list").catch(() => []);
	useRunners.setState({ st: Object.fromEntries(list.map((x) => [x.origin, x])) });
}

/** 「내 Claude 쓰기」 켜기 · 끄기 */
export async function setMine(url: string, on: boolean) {
	useSettings.getState().set((s) => ({ ...s, shared: s.shared.map((x) => (x.url === url ? { ...x, mine: on } : x)) }));
	await call(on ? "runner_start" : "runner_stop", { origin: url });
	if (!on) useRunners.setState((s) => { const st = { ...s.st }; delete st[originOf(url)]; return { st }; });
}
