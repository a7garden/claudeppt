// Claude 남은 사용량 — 대화 머리의 칩과 「설정 › Claude」가 같은 값을 본다 (usage.rs).
// 언제 묻나: 화면이 처음 볼 때 · 5분마다 · Claude 턴이 끝날 때(방금 쓴 양이 바로 보이게) · 「새로 고침」.
// 마지막으로 받은 값(ok)은 남겨 둔다 — 한 번 묻지 못했다고 칩이 사라지지 않게. 협업 브라우저에서는 묻지 않는다(호스트의 한도다).
import { useEffect } from "react";
import { create } from "zustand";
import { api, type ClaudeUsage } from "./api";
import { useDeck } from "./store";
import { remote } from "./transport";

const EVERY_MS = 5 * 60 * 1000;

interface S {
	/** 마지막 답 (ok 가 아닐 수도 있다) */
	last: ClaudeUsage | null;
	/** 마지막으로 받은 ok 답 */
	ok: ClaudeUsage | null;
	busy: boolean;
	load: (force?: boolean) => Promise<void>;
}

export const useUsage = create<S>((set, get) => ({
	last: null,
	ok: null,
	busy: false,
	load: async (force = false) => {
		if (remote || get().busy) return;
		set({ busy: true });
		try {
			const u = await api.claudeUsage(force);
			set({ last: u, ...(u.state === "ok" ? { ok: u } : u.state === "none" ? { ok: null } : {}) });
		} catch (e) {
			set({ last: { state: "error", plan: null, windows: [], error: String(e), at: Date.now() } });
		} finally {
			set({ busy: false });
		}
	},
}));

// 보는 곳(칩 · 설정) 수. 0 → 1 에 묻기를 켜고 1 → 0 에 끈다 — 설정을 닫아도 칩이 남아 있으면 계속 돈다
let viewers = 0;
let stop: (() => void) | null = null;

function start() {
	useUsage.getState().load();
	const timer = setInterval(() => useUsage.getState().load(), EVERY_MS);
	// 턴이 끝나면(running 이 비면) 바로 다시 묻는다. 서버 쪽 1분 기억을 넘겨야 새 값이라 force
	const un = useDeck.subscribe((s, p) => { if (p.running && !s.running) useUsage.getState().load(true); });
	return () => { clearInterval(timer); un(); };
}

/** 묻기를 켠다 — 여러 곳에서 불러도 하나만 돈다 */
export function useUsagePoll() {
	useEffect(() => {
		if (remote) return;
		if (viewers++ === 0) stop = start();
		return () => { if (--viewers === 0) { stop?.(); stop = null; } };
	}, []);
}

/** 초기화까지 — 하루 안이면 남은 시간(mins), 넘으면 그 시각(at) */
export function untilReset(iso: string | null): { mins: number } | { at: Date } | null {
	if (!iso) return null;
	const at = new Date(iso);
	const ms = at.getTime() - Date.now();
	if (isNaN(ms)) return null;
	const mins = Math.max(0, Math.ceil(ms / 60000));
	return mins < 24 * 60 ? { mins } : { at };
}
