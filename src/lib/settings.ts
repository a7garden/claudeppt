// 앱 설정 — %APPDATA%/com.seesun.claudeppt/settings.json 한 파일. 모양은 여기서 정하고 Rust 는 읽고 쓰기만 한다.
import { create } from "zustand";
import { api } from "./api";
import { remote } from "./transport";

/** 협업 브라우저의 설정 — 그 브라우저에만 남긴다 (이름 · 말 · 테마). 호스트 설정 파일은 원격에서 읽지도 쓰지도 않는다 */
const REMOTE_KEY = "claudeppt.remote.settings";

export type ImageProvider = "svg" | "codex-cli" | "gemini-cli" | "openai" | "gemini";

/** 글자 위계 다섯 단계 — theme.css 의 .t-display … .t-caption 과 --fs-* · --fw-* 변수가 된다 */
export const LEVELS = ["display", "title", "subtitle", "body", "caption"] as const;
export type Level = (typeof LEVELS)[number];
export interface TypeStep { size: number; weight: number }

/** 템플릿 — 덱 만드는 스타일 한 벌. 새 덱의 theme.css 와 매 턴 Claude 에게 실리는 스타일 규칙이 여기서 나온다.
 *  덱은 deck.json 의 template 에 어느 템플릿으로 만들었는지 남겨, 기본 템플릿을 바꿔도 지난 덱은 제 스타일을 따른다.
 *  파일로 주고받을 때는 templates.ts 의 claudeppt-template/1 (.ctpl) 꼴이다.
 *  2026.11.26 : 제목 글꼴 · 보조 색 · 글자 위계 · 여백을 더했다. 점검(audit.ts)이 이 값으로 쪽이 템플릿을 벗어났는지 잰다 */
export interface Template {
	id: string;
	name: string;
	/** 본문 글꼴 */
	font: string;
	/** 제목 글꼴 (display · title · subtitle). 비면 본문 글꼴 */
	headFont: string;
	ink: string;
	paper: string;
	accent: string;
	/** 보조 색 — 차트 계열 · 갈래 색. theme.css 의 --c1 … */
	palette: string[];
	/** 글자 위계 — px · 굵기 */
	scale: Record<Level, TypeStep>;
	/** 쪽 가장자리에서 글까지 띄울 거리 px */
	margin: number;
	radius: number;
	stroke: number;
	shadow: "none" | "soft";
	icon: "line" | "solid";
	/** 그림 생성 도구에 함께 넘기는 화풍 (SVG 만 쓸 때는 쓰지 않는다) */
	imageStyle: string;
	/** 글로 적는 스타일 규칙 — 표지 배치 · 머리글 · 글 양 같은 것. 시스템 프롬프트 끝에 붙는다 */
	guide: string;
	/** 어디서 왔는지 — PPTX · 템플릿 파일에서 들였으면 그 파일 이름 */
	from?: string;
}

export interface Settings {
	lang: "ko" | "en";
	theme: "system" | "dark" | "light";
	/** 덱 폴더들이 쌓이는 저장 폴더 */
	library: string;
	recent: string[];
	claude: { path: string; model: string; effort: string };
	image: { provider: ImageProvider; openaiKey: string; geminiKey: string; openaiModel: string; geminiModel: string };
	templates: Template[];
	/** 새 덱에 쓰는 템플릿 id */
	template: string;
	/** auto — 새 판을 저절로 확인 · install — 찾으면 내려받아 쉬는 틈에 저절로 설치 (2026.11.25~ 기본 켬) */
	update: { auto: boolean; install: boolean };
	/** 앱 밖 Claude Code 가 CLI 로 이 앱을 부리는 것을 받을지 (control.rs · remote.ts) */
	remote: { enabled: boolean };
	/** 「설정 › 협업」(기본 꺼짐). on 이면 팀원 세션 — 쪽마다 처음 고친 세션을 이어 쓰고, 요청 · 판에 보낸 사람이 남는다.
	 *  꺼져 있으면 전처럼 대화 세션 하나 · 이름 없이 돈다 */
	collab: { on: boolean };
	/** 이 기기를 쓰는 팀원 이름 — 협업을 켰을 때 대화의 요청과 판(git 작성자)에 남는다. 기기마다 한 번 정한다 */
	me: string;
	/** 앱으로 들어간 공유 덱 — 호스트 주소(origin)와 마지막으로 연 때. 기기 쿠키가 앱에 남아 주소만으로 다시 들어간다 (collab.rs collab_join) */
	shared: SharedDeck[];
}
/** mine — 이 덱 주인에게 내 PC 의 Claude 를 쓰게 한다 (runner.rs). 사람이 덱 주인마다 켠다 */
export interface SharedDeck { url: string; at: number; mine?: boolean; title?: string }

export const SCALE: Record<Level, TypeStep> = {
	display: { size: 64, weight: 700 },
	title: { size: 40, weight: 700 },
	subtitle: { size: 28, weight: 600 },
	body: { size: 24, weight: 400 },
	caption: { size: 16, weight: 400 },
};

export const BASIC: Template = {
	id: "basic", name: "기본", font: "Pretendard", headFont: "", ink: "#16181D", paper: "#FFFFFF", accent: "#E5482D",
	palette: ["#2B6CB0", "#2F855A", "#B7791F"], scale: SCALE, margin: 72,
	radius: 10, stroke: 1.5, shadow: "none", icon: "line", imageStyle: "", guide: "",
};

const HEX = /^#[0-9A-F]{6}$/i;
/** 어디서 왔든(옛 설정 · 템플릿 파일 · PPTX) 빠진 칸을 기본값으로 채우고 틀린 값을 걸러 낸다 */
export function normalizeTemplate(x: any): Template {
	const t: Template = { ...BASIC, ...(x || {}) };
	const step = (v: any, d: TypeStep): TypeStep => ({
		size: Number.isFinite(+v?.size) && +v.size > 4 ? Math.round(+v.size * 10) / 10 : d.size,
		weight: Number.isFinite(+v?.weight) ? Math.min(900, Math.max(100, Math.round(+v.weight / 100) * 100)) : d.weight,
	});
	t.scale = Object.fromEntries(LEVELS.map((l) => [l, step(x?.scale?.[l], SCALE[l])])) as Record<Level, TypeStep>;
	t.palette = Array.isArray(x?.palette) ? x.palette.filter((c: any) => typeof c === "string" && HEX.test(c)).map((c: string) => c.toUpperCase()).slice(0, 6) : BASIC.palette;
	for (const k of ["ink", "paper", "accent"] as const) if (!HEX.test(t[k])) t[k] = BASIC[k];
	t.headFont = typeof t.headFont === "string" ? t.headFont : "";
	t.margin = Number.isFinite(+t.margin) ? Math.min(200, Math.max(0, Math.round(+t.margin))) : BASIC.margin;
	return t;
}

export const DEFAULTS: Settings = {
	lang: "ko",
	theme: "system",
	library: "",
	recent: [],
	claude: { path: "", model: "", effort: "" },
	image: { provider: "svg", openaiKey: "", geminiKey: "", openaiModel: "gpt-image-1", geminiModel: "gemini-2.5-flash-image" },
	templates: [BASIC],
	template: BASIC.id,
	update: { auto: true, install: true },
	remote: { enabled: true },
	collab: { on: false },
	me: "",
	shared: [],
};

export const templateId = () => "t" + Math.random().toString(36).slice(2, 8);

/** id 의 템플릿 — 없으면(지운 템플릿 · 옛 덱) 기본 템플릿 */
export function templateOf(s: Settings, id?: string): Template {
	return s.templates.find((x) => x.id === id) || s.templates.find((x) => x.id === s.template) || s.templates[0] || BASIC;
}

const merge = (v: any): Settings => {
	// 2026.11.24 : 「도형」 탭 · 「추가 지침」 · 이미지 화풍을 템플릿 하나로 모았다. 옛 설정은 「기본」 템플릿 하나로 옮긴다.
	// 「프롬프트」(앱 기본 프롬프트 갈아 끼우기)는 없앴다 — 바꾸면 내보내기 규칙이 빠져 PPTX 가 깨지고, 스타일은 템플릿 지침으로 충분하다
	const templates: Template[] = Array.isArray(v?.templates) && v.templates.length
		? v.templates.map(normalizeTemplate)
		: [normalizeTemplate({ ...(v?.shape || {}), imageStyle: v?.image?.style || "", guide: v?.claude?.extra || "" })];
	const { shape: _s, ...rest } = v || {};
	const { prompt: _p, extra: _e, ...claude } = v?.claude || {};
	const { style: _st, ...image } = v?.image || {};
	return {
		...DEFAULTS,
		...rest,
		claude: { ...DEFAULTS.claude, ...claude },
		image: { ...DEFAULTS.image, ...image },
		templates,
		template: templates.some((x) => x.id === v?.template) ? v.template : templates[0].id,
		update: { ...DEFAULTS.update, ...(v?.update || {}) },
		remote: { ...DEFAULTS.remote, ...(v?.remote || {}) },
		collab: { ...DEFAULTS.collab, ...(v?.collab || {}) },
		me: typeof v?.me === "string" ? v.me : "",
		shared: Array.isArray(v?.shared) ? v.shared.filter((x: any) => typeof x?.url === "string" && /^https?:\/\//.test(x.url)).map((x: any) => ({ url: x.url, at: +x.at || 0, mine: !!x.mine, title: typeof x.title === "string" ? x.title.slice(0, 120) : undefined })).slice(0, 12) : [],
	};
};

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
		if (remote) {
			let raw: any = null;
			try { raw = JSON.parse(localStorage.getItem(REMOTE_KEY) || "null"); } catch {}
			const s = merge(raw);
			s.collab = { on: true };
			if (!raw?.lang && !navigator.language.startsWith("ko")) s.lang = "en";
			return set({ s, loaded: true });
		}
		const raw = await api.settingsLoad().catch(() => null);
		const s = merge(raw);
		if (!s.library) s.library = (await api.paths()).library;
		set({ s, loaded: true });
	},
	set: (fn) => {
		const s = fn(get().s);
		set({ s });
		clearTimeout(saveTimer);
		if (remote) {
			try { localStorage.setItem(REMOTE_KEY, JSON.stringify({ me: s.me, lang: s.lang, theme: s.theme })); } catch {}
			return;
		}
		saveTimer = setTimeout(() => api.settingsSave(s).catch(() => {}), 300);
	},
	remember: (dir) => get().set((s) => ({ ...s, recent: [dir, ...s.recent.filter((d) => d !== dir)].slice(0, 12) })),
}));
