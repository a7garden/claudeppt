// 앱 업데이트 — GitHub 릴리즈의 latest.json 을 보고 새 판이면 알린다 (docket 과 같은 틀).
// 켤 때 한 번, 켜 둔 동안 1시간마다, 창으로 돌아왔을 때 30분 넘게 안 봤으면 한 번 더. 개발 실행(tauri dev)에서는 자동 확인을 하지 않는다.
// 2026.11.24 : 새 판은 제목 줄 「새 판」 칩으로 알린다 — 처음 찾은 판이면 칩 아래 설명을 저절로 펴고, 닫아도 칩은 설치할 때까지 남는다.
//              전에는 아래 알림 한 줄이라 다른 알림 · 진행 줄과 같은 자리에서 겹치거나 가려져 못 보고 지나갔다.
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useEffect } from "react";
import { create } from "zustand";
import { useSettings } from "./settings";

const CHECK_EVERY_MS = 60 * 60 * 1000;
const STALE_MS = 30 * 60 * 1000;

interface U {
	phase: "idle" | "checking" | "latest" | "available" | "downloading" | "error";
	version: string;
	notes: string;
	error: string;
	progress: number;
	notified: boolean;
	checkedAt: number | null;
	run: (silent?: boolean) => Promise<void>;
	install: () => Promise<void>;
	dismiss: () => void;
}

let pending: Update | null = null;

export const useUpdate = create<U>()((set, get) => ({
	phase: "idle",
	version: "",
	notes: "",
	error: "",
	progress: 0,
	notified: false,
	checkedAt: null,
	run: async (silent) => {
		if (get().phase === "checking" || get().phase === "downloading") return;
		if (!silent) set({ phase: "checking", error: "" });
		try {
			const u = await check();
			pending = u;
			// 같은 판을 다시 찾았으면 닫아 둔 설명을 또 펴지 않는다
			if (u) set({ phase: "available", version: u.version, notes: u.body || "", notified: get().version !== u.version || get().notified, checkedAt: Date.now() });
			else set({ phase: "latest", checkedAt: Date.now() });
		} catch (e) {
			set({ phase: silent ? get().phase : "error", error: String(e), checkedAt: Date.now() });
		}
	},
	install: async () => {
		if (!pending) return;
		set({ phase: "downloading", progress: 0 });
		let total = 0, done = 0;
		try {
			await pending.downloadAndInstall((ev) => {
				if (ev.event === "Started") total = ev.data.contentLength || 0;
				if (ev.event === "Progress") { done += ev.data.chunkLength; set({ progress: total ? done / total : 0 }); }
			});
			await relaunch();
		} catch (e) {
			set({ phase: "error", error: String(e) });
		}
	},
	dismiss: () => set({ notified: false }),
}));

export function useAutoUpdate(ready: boolean) {
	const auto = useSettings((s) => s.s.update.auto);
	useEffect(() => {
		if (!ready || !auto || import.meta.env.DEV) return;
		useUpdate.getState().run(true);
		const t = setInterval(() => useUpdate.getState().run(true), CHECK_EVERY_MS);
		// 잠자기 · 오래 다른 창에 있다 오면 타이머가 밀린다 — 돌아온 때 한 번 본다
		const back = () => { const at = useUpdate.getState().checkedAt; if (!at || Date.now() - at > STALE_MS) useUpdate.getState().run(true); };
		addEventListener("focus", back);
		return () => { clearInterval(t); removeEventListener("focus", back); };
	}, [ready, auto]);
}
