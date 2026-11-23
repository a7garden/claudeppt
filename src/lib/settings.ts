// 앱 설정 — %APPDATA%/com.seesun.claudeppt/settings.json 한 파일. 모양은 여기서 정하고 Rust 는 읽고 쓰기만 한다.
import { create } from "zustand";
import { api } from "./api";

export type ImageProvider = "svg" | "codex-cli" | "gemini-cli" | "openai" | "gemini";

export interface Settings {
	lang: "ko" | "en";
	theme: "system" | "dark" | "light";
	library: string;
	recent: string[];
	claude: { path: string; model: string; effort: string; prompt: string; extra: string };
	image: { provider: ImageProvider; openaiKey: string; geminiKey: string; openaiModel: string; geminiModel: string; style: string };
	shape: { font: string; radius: number; stroke: number; shadow: "none" | "soft"; accent: string; ink: string; paper: string; icon: "line" | "solid" };
	update: { auto: boolean };
	/** 앱 밖 Claude Code 가 CLI 로 이 앱을 부리는 것을 받을지 (control.rs · remote.ts) */
	remote: { enabled: boolean };
}

export const DEFAULTS: Settings = {
	lang: "ko",
	theme: "system",
	library: "",
	recent: [],
	// prompt 가 비어 있으면 앱 기본 프롬프트(prompt.ts BASE_PROMPT)를 쓴다
	claude: { path: "", model: "", effort: "", prompt: "", extra: "" },
	image: { provider: "svg", openaiKey: "", geminiKey: "", openaiModel: "gpt-image-1", geminiModel: "gemini-2.5-flash-image", style: "" },
	shape: { font: "Pretendard", radius: 10, stroke: 1.5, shadow: "none", accent: "#E5482D", ink: "#16181D", paper: "#FFFFFF", icon: "line" },
	update: { auto: true },
	remote: { enabled: true },
};

const merge = (v: any): Settings => ({
	...DEFAULTS,
	...(v || {}),
	claude: { ...DEFAULTS.claude, ...(v?.claude || {}) },
	image: { ...DEFAULTS.image, ...(v?.image || {}) },
	shape: { ...DEFAULTS.shape, ...(v?.shape || {}) },
	update: { ...DEFAULTS.update, ...(v?.update || {}) },
	remote: { ...DEFAULTS.remote, ...(v?.remote || {}) },
});

interface Store {
	s: Settings;
	loaded: boolean;
	load: () => Promise<void>;
	set: (fn: (s: Settings) => Settings) => void;
	remember: (dir: string) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export const useSettings = create<Store>()((set, get) => ({
	s: DEFAULTS,
	loaded: false,
	load: async () => {
		const raw = await api.settingsLoad().catch(() => null);
		const s = merge(raw);
		if (!s.library) s.library = (await api.paths()).library;
		set({ s, loaded: true });
	},
	set: (fn) => {
		const s = fn(get().s);
		set({ s });
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => api.settingsSave(s).catch(() => {}), 300);
	},
	remember: (dir) => get().set((s) => ({ ...s, recent: [dir, ...s.recent.filter((d) => d !== dir)].slice(0, 12) })),
}));
