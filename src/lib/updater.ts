// 앱 업데이트 — GitHub 릴리즈의 latest.json 을 보고 새 판이면 알린다 (docket 과 같은 틀).
// 켤 때 한 번, 켜 둔 동안 1시간마다. 개발 실행(tauri dev)에서는 자동 확인을 하지 않는다.
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useEffect } from "react";
import { create } from "zustand";
import { useSettings } from "./settings";

const CHECK_EVERY_MS = 60 * 60 * 1000;

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
			if (u) set({ phase: "available", version: u.version, notes: u.body || "", notified: true, checkedAt: Date.now() });
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
		return () => clearInterval(t);
	}, [ready, auto]);
}
