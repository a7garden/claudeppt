// 서식 띠: PowerPoint 위쪽 리본처럼 탭(홈 · 삽입 · 도형 서식 · 표)으로 나눠 무대 맨 위에 둔다.
// 슬라이드 창(rt.js)에 cmd 로 시키고, 고른 것의 서식은 sel 로 받는다. 고친 것은 rt.js 가 patch · append … 로 돌려보내
// 무대(Workspace.tsx Stage)가 원본 HTML 에 되쓴다 — 손 편집과 같은 길이라 Ctrl+Z · 판에 그대로 들어간다.
//
// 목차
//   SelInfo       rt.js 가 알려 주는 고른 것의 서식
//   Ribbon        탭 줄 · 고른 탭의 도구 줄. 도형 서식은 무언가 골랐을 때, 표는 표를 골랐을 때만 선다 (PowerPoint 의 상황 탭).
//                 탭을 두 번 누르면 도구 줄만 접는다 · ← → 로 탭을 옮긴다
//   Grp · Field   도구 묶음(좁아도 묶음째 접힌다) · 값 칸(Enter 입힘 · Esc 되돌림)
//     HomeTab     클립보드(붙여 넣기 · 잘라내기 · 복사 · 서식 복사) · 글꼴(이름 · 크기 · 서식 지우기 · 굵게 … 취소선 · 문자 간격 · 대/소문자 · 강조 색 · 글꼴 색)
//                 · 단락(글머리 기호 · 번호 · 목록 수준 · 가로 맞춤 · 줄 간격 · 텍스트 맞춤) · 그리기(정렬 · 맞춤 · 복제 · 삭제)
//                 글꼴 · 크기 · 간격 · 대소문자 · 색 · 강조 색은 글자를 골라 두었으면 그 글자에만 (rt.js textStyle)
//     FontList    찾기 칸이 붙은 글꼴 목록
//     InsertTab   새 슬라이드 · 표(칸 고르기) · 그림 · 글상자 · 도형 · 기호
//     ShapeTab    채우기 · 윤곽선(색 · 두께 · 대시) · 그림자 · 모서리 · 투명도 · 정렬 · 맞춤 · 크기(cm)
//     TableTab    행 · 열 넣기와 지우기 · 표 지우기 · 칸 채우기
//   Pop           단추 아래로 여는 작은 판: 색 · 표 칸 · 기호가 함께 쓴다
//   ColorPop      색 고르기 — 테마 색(덱 theme.css 변수) · 표준 색 · 없음 · 다른 색
//   insertImage   그림 파일을 assets/ 에 복사하고 쪽 가운데에 넣는다
//
// 글을 고치는 중에도 쓰는 단추(굵게 · 색 · 기호 …)는 누를 때 포커스를 뺏지 않는다(onMouseDown preventDefault).
// 뺏으면 고치던 글이 끝나 고른 글자가 풀리고, 고른 글자에만 입히는 굵게 · 색이 글 전체로 간다.
//
// 띠는 처음에 접혀 있다 (2026.11.25 사용자 결정) — 말로만 만드는 사람에게는 무대가 넓은 편이 낫고, 도구가 필요한 사람만
// 무대 도구 띠의 「서식」(F)으로 꺼낸다. 펼침 · 고른 탭은 이 PC 에만 기억한다. 접어도 슬라이드 안 편집(손잡이 · Ctrl+B · Ctrl+D …)은 그대로다.
// 2026.11.27 : 한 줄에 모은 도구를 탭으로 나눴다. PowerPoint 를 쓰던 사람이 찾는 자리(홈의 글꼴 · 단락, 삽입의 표, 도형 서식의 크기)에 둔다
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { api, deckUrl } from "../lib/api";
import { IMAGE_EXT } from "../lib/attach";
import { fontIndex } from "../lib/fonts";
import { tell } from "../lib/frames";
import { type Key, useT } from "../lib/i18n";
import { useDeck } from "../lib/store";
import { openMenu } from "./ContextMenu";

export interface SelInfo {
	tag: string;
	editing: boolean;
	/** 옮기기 · 크기 · 맞춤을 할 수 있다 (절대 위치 상자, 흐름 배치의 덩이 요소) */
	box: boolean;
	/** 절대 위치 상자 — 앞뒤 순서는 이것만. 흐름 요소의 순서를 바꾸면 겹침이 아니라 배치 차례가 바뀐다 */
	abs: boolean;
	/** flex 상자 — 글 세로 맞춤을 할 수 있다 */
	flex: boolean;
	image: boolean;
	/** 글자 크기 px (쪽 1px = 0.75pt) */
	size: number;
	/** 줄 간격 — 글자 크기의 배수 (normal 이면 null) */
	lh: number | null;
	bold: boolean;
	italic: boolean;
	underline: boolean;
	strike: boolean;
	/** 첫 글꼴 이름 */
	font: string;
	/** 문자 간격 pt */
	ls: number;
	/** text-transform */
	tt: string;
	/** 글머리 기호 · 번호 */
	list: "bu" | "num" | null;
	color: string | null;
	align: string;
	valign: string;
	fill: string | null;
	line: { hex: string | null; w: number } | null;
	dash: string | null;
	/** 상자의 그린 크기 px */
	w: number;
	h: number;
	radius: number;
	/** 모서리가 % 로 (알약 · 원) */
	round: boolean;
	shadow: boolean;
	/** 불투명도 % */
	opacity: number;
	/** 표 칸 안 */
	cell: boolean;
	/** 서식 복사 붓을 들고 있다 */
	painter: boolean;
	/** 글이 들어갈 자리가 있다 (기호 넣기) */
	text: boolean;
	/** 글자를 골랐다: 고치는 중 고른 글자, 또는 마치기 전에 골라 둔 글자 */
	ranged: boolean;
}

type Tab = "home" | "insert" | "shape" | "table";

// PowerPoint 글꼴 크기 목록 (pt) — 크게 · 작게가 이 차례로 오르내린다
const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96];
const STD = ["#000000", "#FFFFFF", "#C00000", "#FF0000", "#FFC000", "#FFFF00", "#92D050", "#00B050", "#00B0F0", "#0070C0", "#002060", "#7030A0"];
// 텍스트 강조 색: PowerPoint 형광펜 목록에서 슬라이드에 흔히 쓰는 것
const MARKS = ["#FFFF00", "#00FF00", "#00FFFF", "#FF00FF", "#FFC000", "#FF8080", "#C0C0C0", "#B4C7E7", "#C5E0B4", "#F8CBAD", "#FFE699", "#D9D9D9"];
// 테마 색 — 덱 theme.css 의 변수. 원본에도 var(--…) 로 쓴다: 테마를 바꾸면 따라 바뀐다
const THEME: [string, Key][] = [["--ink", "rbInk"], ["--accent", "rbAccent"], ["--muted", "rbMuted"], ["--line", "rbLineC"], ["--soft", "rbSoft"], ["--paper", "rbPaper"]];
const WEIGHTS = [1, 2, 3, 4, 6, 8];
// 줄 간격 — PowerPoint 목록과 같은 수
const LINE_HEIGHTS = [1, 1.15, 1.5, 2, 2.5, 3];
// 문자 간격 (pt): PowerPoint 「문자 간격」 목록
const SPACINGS: [number, Key][] = [[-3, "rbSpVTight"], [-1.5, "rbSpTight"], [0, "rbSpNormal"], [3, "rbSpLoose"], [6, "rbSpVLoose"]];
const RADII: [string, Key][] = [["0", "rbRadius0"], ["6px", "rbRadiusS"], ["16px", "rbRadiusM"], ["32px", "rbRadiusL"], ["9999px", "rbRadiusFull"]];
// 슬라이드에 자주 넣는 기호: 한글 문서에서 쓰는 원 번호 · 낫표 · 단위를 함께 둔다
const SYMBOLS = "• · ※ → ← ↑ ↓ ↔ ⇒ ▶ ▷ ◀ ■ □ ● ○ ◆ ◇ ▲ △ ★ ☆ ✓ ✔ ✗ ① ② ③ ④ ⑤ ⑥ ㉠ ㉡ ㉢ ± × ÷ ≠ ≤ ≥ ° ℃ ㎡ ㎞ … 「 」 『 』".split(" ");
/** 쪽 1px → cm (96px = 1in = 2.54cm) */
const CM = 2.54 / 96;
const SHOWN_KEY = "claudeppt.ribbon";
const TAB_KEY = "claudeppt.ribbonTab";
const MINI_KEY = "claudeppt.ribbonMini";
export const useRibbon = create<{ shown: boolean; tab: Tab; mini: boolean; toggle: () => void; setTab: (t: Tab) => void; setMini: (v: boolean) => void }>()((set, get) => ({
	shown: (() => { try { return localStorage.getItem(SHOWN_KEY) === "1"; } catch { return false; } })(),
	tab: (() => { try { const v = localStorage.getItem(TAB_KEY); return v === "insert" || v === "shape" ? v : "home"; } catch { return "home"; } })(),
	// 탭을 두 번 누르면 도구 줄만 접는다 (PowerPoint 리본 최소화): 무대를 넓게 쓰면서 탭은 남긴다
	mini: (() => { try { return localStorage.getItem(MINI_KEY) === "1"; } catch { return false; } })(),
	setMini: (mini) => {
		set({ mini });
		try { localStorage.setItem(MINI_KEY, mini ? "1" : "0"); } catch {}
	},
	toggle: () => {
		const shown = !get().shown;
		set({ shown });
		try { localStorage.setItem(SHOWN_KEY, shown ? "1" : "0"); } catch {}
	},
	setTab: (tab) => {
		set({ tab });
		// 표 탭은 기억하지 않는다: 표를 고를 때만 서는 탭이라 다음에 켤 때는 없을 때가 많다
		try { if (tab !== "table") localStorage.setItem(TAB_KEY, tab); } catch {}
	},
}));

/** 누를 때 포커스를 뺏지 않는다 — 슬라이드 창에서 고치던 글을 살린다 */
const hold = (e: React.MouseEvent) => e.preventDefault();

const Icon = ({ d, children }: { d?: string; children?: React.ReactNode }) => (
	<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>{d ? <path d={d} /> : children}</svg>
);
const Caret = () => <svg className="caret" width="8" height="8" viewBox="0 0 8 8" aria-hidden><path d="M1.5 3l2.5 2.5L6.5 3" /></svg>;

/** 덱 theme.css 의 :root 변수 — 테마 색 칸을 덱 색으로 칠한다 */
function useThemeVars() {
	const id = useDeck((s) => s.id);
	const theme = useDeck((s) => s.deck?.theme || "theme.css");
	const [vars, setVars] = useState<Record<string, string>>({});
	useEffect(() => {
		if (!id) return;
		fetch(deckUrl(id, theme) + "?t=" + Date.now()).then((r) => r.text()).then((css) => {
			// :root 가 여럿일 수 있다 — 옛 덱은 처음 :root 뒤에 템플릿 구획이 붙는다 (deck.rethemeCss). 뒤의 값이 이긴다
			const v: Record<string, string> = {};
			for (const root of css.matchAll(/:root\s*\{([^}]*)\}/g)) for (const m of root[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) v[m[1]] = m[2].trim();
			setVars(v);
		}, () => setVars({}));
	}, [id, theme]);
	return vars;
}

/** 이 PC 에 깔린 글꼴 가족 이름: 웹뷰는 영어 가족 이름만 알아보므로 영어 이름이 있으면 그것을 쓴다 */
let familiesP: Promise<string[]> | null = null;
const families = () => (familiesP ||= fontIndex().then((faces) => {
	const s = new Set<string>();
	for (const f of faces) {
		const n = f.family.find((x) => /^[\x20-\x7e]+$/.test(x)) || f.family[0];
		if (n && !n.startsWith("@")) s.add(n);
	}
	return [...s].sort((a, b) => a.localeCompare(b));
}));

interface Ctx {
	t: ReturnType<typeof useT>;
	info: SelInfo | null;
	send: (cmd: string, v?: unknown) => void;
	vars: Record<string, string>;
	insert: (kind: string) => void;
	placing: string | null;
	win: React.MutableRefObject<Window | null>;
	/** 마지막에 쓴 강조 색: 단추 아래 띠에 칠한다 */
	mark: string;
	setMark: (c: string) => void;
}

export function Ribbon({ win, info, placing, off }: { win: React.MutableRefObject<Window | null>; info: SelInfo | null; placing: string | null; off: boolean }) {
	const t = useT();
	const tool = useDeck((s) => s.tool);
	const setTool = useDeck((s) => s.setTool);
	const saved = useRibbon((s) => s.tab);
	const setTab = useRibbon((s) => s.setTab);
	const mini = useRibbon((s) => s.mini);
	const setMini = useRibbon((s) => s.setMini);
	const vars = useThemeVars();
	const [mark, setMark] = useState("#FFFF00");
	const send = (cmd: string, v?: unknown) => tell(win.current, { t: "cmd", cmd, v });
	/** 넣기 — 긋는 도구였으면 고르기로 돌린다 (모드가 먼저 가야 슬라이드 창이 명령을 받는다) */
	const insert = (kind: string) => {
		if (tool !== "select") setTool("select");
		send("place", placing === kind ? null : kind);
	};
	// 그리기 대기 중 Esc — 단추를 누른 뒤라 포커스가 앱에 있으면 슬라이드 창이 Esc 를 못 받는다
	useEffect(() => {
		if (!placing) return;
		const k = (e: KeyboardEvent) => { if (e.key === "Escape") { send("place", null); e.stopImmediatePropagation(); } };
		addEventListener("keydown", k, true);
		return () => removeEventListener("keydown", k, true);
	}, [placing]);
	// 도형 서식 · 표는 상황 탭이다: 고른 것이 없으면 도형 서식을, 표가 아니면 표를 숨기고 홈을 보인다.
	// 기억한 탭은 그대로 둔다: 다시 고르면 그 탭으로 돌아온다
	const inTable = !!info?.cell || info?.tag === "table";
	const tabs: [Tab, Key][] = [["home", "rbHome"], ["insert", "rbInsert"], ...(info ? [["shape", "rbShapeFmt"] as [Tab, Key]] : []), ...(inTable ? [["table", "rbTable"] as [Tab, Key]] : [])];
	const tab: Tab = tabs.some(([k]) => k === saved) ? saved : "home";
	const c: Ctx = { t, info, send, vars, insert, placing, win, mark, setMark };
	// 접힌 띠에서 두 번 누르면 첫 누름이 펴고 두 번 누르기가 다시 접었다: 방금 편 것이면 두 번 누르기는 편 채로 둔다
	const opened = useRef(0);
	const go = (k: Tab) => { setTab(k); if (mini) { setMini(false); opened.current = Date.now(); } };
	const dbl = () => { if (Date.now() - opened.current > 600) setMini(!mini); };
	// 탭 줄은 ← → 로 옮겨 다닌다 (탭 목록의 키보드 규칙)
	const arrow = (e: React.KeyboardEvent, i: number) => {
		if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
		const k = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length][0];
		go(k);
		document.getElementById(`rb-tab-${k}`)?.focus();
		e.preventDefault();
	};
	const hint = placing ? t("rbPlaceHint") : info?.painter ? t("rbPaintHint") : mini ? "" : !info && tab !== "insert" ? t("rbPickHint") : tab === "table" && !info?.cell ? t("rbCellHint") : "";

	return (
		<div className={"ribbon" + (off ? " off" : "") + (mini ? " mini" : "")} role="toolbar" aria-label={t("rbRibbon")} title={off ? t("rbOff") : undefined}>
			<div className="rb-tabs" role="tablist">
				{tabs.map(([k, label], i) => (
					<button key={k} id={`rb-tab-${k}`} role="tab" className={k === "shape" || k === "table" ? "ctx" : undefined} aria-selected={!mini && tab === k} aria-controls="rb-panel" tabIndex={tab === k ? 0 : -1}
						title={t("rbTabHint")} onMouseDown={hold} onClick={() => go(k)} onDoubleClick={dbl} onKeyDown={(e) => arrow(e, i)}>{t(label)}</button>
				))}
				{hint && <span className="rb-hint" role="status">{hint}</span>}
				<button className="rb-close" onClick={() => useRibbon.getState().toggle()} title={`${t("rbHide")} (F)`} aria-label={t("rbHide")}>
					<Icon d="M4 10l4-4 4 4" />
				</button>
			</div>
			{!mini && (
				<div className="rb-tools" id="rb-panel" role="tabpanel" aria-labelledby={`rb-tab-${tab}`}>
					{tab === "home" && <HomeTab {...c} />}
					{tab === "insert" && <InsertTab {...c} />}
					{tab === "shape" && <ShapeTab {...c} />}
					{tab === "table" && <TableTab {...c} />}
				</div>
			)}
		</div>
	);
}

/** 도구 묶음: 좁은 무대에서 줄이 접혀도 묶음 안 단추(굵게 · 기울임꼴 …)는 한 줄에 남는다 */
const Grp = ({ label, children }: { label: string; children: React.ReactNode }) => <span className="rb-grp" role="group" aria-label={label}>{children}</span>;

/** 값 칸: Enter · 칸을 떠나면 입히고, Esc 는 되돌리고 칸을 떠난다 (떠날 때 입히지 않는다) */
function Field({ value, commit, className, label, disabled, placeholder, mono }: {
	value: string; commit: (text: string) => void; className?: string; label: string; disabled?: boolean; placeholder?: string; mono?: boolean;
}) {
	const [text, setText] = useState(value);
	useEffect(() => setText(value), [value]);
	const cancel = useRef(false);
	return (
		<input className={className} value={text} disabled={disabled} placeholder={placeholder} aria-label={label} title={label} spellCheck={false} inputMode={mono ? "decimal" : undefined}
			onChange={(e) => setText(e.target.value)}
			onBlur={() => { if (cancel.current) { cancel.current = false; setText(value); return; } if (text !== value) commit(text); }}
			onKeyDown={(e) => {
				if (e.key === "Enter") (e.target as HTMLInputElement).blur();
				if (e.key === "Escape") { cancel.current = true; setText(value); (e.target as HTMLInputElement).blur(); e.stopPropagation(); }
			}} />
	);
}

function HomeTab({ t, info, send, vars, mark, setMark }: Ctx) {
	const pt = info ? Math.round(info.size * 0.75 * 10) / 10 : null;
	const step = (d: 1 | -1) => {
		if (pt == null) return;
		const next = d > 0 ? SIZES.find((s) => s > pt + 0.05) ?? pt + 8 : [...SIZES].reverse().find((s) => s < pt - 0.05) ?? Math.max(1, pt - 1);
		send("size", next);
	};
	const sizeCommit = (text: string) => {
		const v = parseFloat(text.replace(",", "."));
		if (v > 0 && v <= 400 && v !== pt) send("size", v);
	};
	// 글꼴 이름: 비우면 직접 준 글꼴을 걷어 덱(테마) 글꼴로 돌아간다
	const fontCommit = (text: string) => {
		const v = text.trim().replace(/["';{}]/g, "");
		send("font", v ? `'${v}', sans-serif` : "");
	};
	const none = !info;
	// 그림을 골랐으면 글꼴 · 단락은 닿을 글이 없다
	const noText = none || !!info?.image;
	// 글을 고치는 중이면 잘라내기 · 복사는 고른 글자에 닿는다: 고른 글자가 없으면 할 것이 없다
	const noClip = none || (!!info?.editing && !info.ranged);
	const align = info?.align === "start" ? "left" : info?.align === "end" ? "right" : info?.align;
	const sp = info?.ls ?? 0;
	return (
		<>
			<Grp label={t("rbClipboard")}>
				<button onMouseDown={hold} onClick={() => send("pasteReq")} title={`${t("rbPaste")} (Ctrl+V)`} aria-label={t("rbPaste")}>
					<Icon><rect x="3" y="3" width="10" height="11" rx="1" /><path d="M6 3V2h4v1M5.5 7h5M5.5 10h3" /></Icon>
				</button>
				<button disabled={noClip} onMouseDown={hold} onClick={() => send("cut")} title={`${t("rbCut")} (Ctrl+X)`} aria-label={t("rbCut")}>
					<Icon><circle cx="4.5" cy="12" r="2" /><circle cx="11.5" cy="12" r="2" /><path d="M5.8 10.5L11 2.5M10.2 10.5L5 2.5" /></Icon>
				</button>
				<button disabled={noClip} onMouseDown={hold} onClick={() => send("copy")} title={`${t("rbCopy")} (Ctrl+C)`} aria-label={t("rbCopy")}>
					<Icon><rect x="5" y="5" width="8.5" height="8.5" rx="1" /><path d="M11 3V2.5H2.5V11H3" /></Icon>
				</button>
				<button disabled={none} aria-pressed={!!info?.painter} onMouseDown={hold} onClick={() => send("painter")} title={t("rbPainter")} aria-label={t("rbPainter")}>
					<Icon d="M3 2.5h8v3.5H3zM11 4.2h2v3.3H7.5V10M6.5 10h2v4h-2z" />
				</button>
			</Grp>

			<Grp label={t("rbFont")}>
				<Field className="font" value={info?.font ?? ""} commit={fontCommit} label={t("rbFont")} disabled={noText} placeholder={t("rbFontTheme")} />
				<FontList t={t} disabled={noText} current={info?.font ?? ""} pick={(f) => send("font", f ? `'${f}', sans-serif` : "")} />
				<Field className="size" value={pt == null ? "" : String(pt)} commit={sizeCommit} label={t("rbFontSize")} disabled={noText} mono />
				<button className="rb-sizes" disabled={noText} title={t("rbFontSize")} aria-label={t("rbFontSize")}
					onClick={(e) => openMenu(e, SIZES.map((s) => ({ label: String(s), checked: s === pt, run: () => send("size", s) })))}><Caret /></button>
				<button disabled={noText} onMouseDown={hold} onClick={() => step(1)} title={t("rbGrow")} aria-label={t("rbGrow")}><span className="glyph">가<sup>+</sup></span></button>
				<button disabled={noText} onMouseDown={hold} onClick={() => step(-1)} title={t("rbShrink")} aria-label={t("rbShrink")}><span className="glyph">가<sup>−</sup></span></button>
				<button disabled={noText} onMouseDown={hold} onClick={() => send("clear")} title={t("rbClear")} aria-label={t("rbClear")}>
					<Icon d="M3 3.5h8M7 3.5L5 12.5M9.5 9.5l4 4M13.5 9.5l-4 4" />
				</button>
				<i className="sep thin" />
				<button disabled={noText} aria-pressed={!!info?.bold} onMouseDown={hold} onClick={() => send("toggle", "bold")} title={`${t("rbBold")} (Ctrl+B)`} aria-label={t("rbBold")}><b className="glyph">가</b></button>
				<button disabled={noText} aria-pressed={!!info?.italic} onMouseDown={hold} onClick={() => send("toggle", "italic")} title={`${t("rbItalic")} (Ctrl+I)`} aria-label={t("rbItalic")}><i className="glyph">가</i></button>
				<button disabled={noText} aria-pressed={!!info?.underline} onMouseDown={hold} onClick={() => send("toggle", "underline")} title={`${t("rbUnderline")} (Ctrl+U)`} aria-label={t("rbUnderline")}><u className="glyph">가</u></button>
				<button disabled={noText} aria-pressed={!!info?.strike} onMouseDown={hold} onClick={() => send("toggle", "strike")} title={t("rbStrike")} aria-label={t("rbStrike")}><s className="glyph">가</s></button>
				<button disabled={noText} title={t("rbSpacing")} aria-label={t("rbSpacing")}
					onClick={(e) => openMenu(e, SPACINGS.map(([v, k]) => ({ label: `${t(k)}${v ? ` (${v > 0 ? "+" : ""}${v}pt)` : ""}`, checked: Math.abs(sp - v) < 0.2, run: () => send("spacing", v) })))}>
					<Icon d="M2 13.5L5 4l3 9.5M3 10.5h4M10 6.5h4M10 6.5l1.5-1.5M10 6.5L11.5 8M14 6.5L12.5 5M14 6.5L12.5 8" /><Caret />
				</button>
				<button disabled={noText} title={t("rbCase")} aria-label={t("rbCase")}
					onClick={(e) => openMenu(e, ([["uppercase", "rbUpper"], ["lowercase", "rbLower"], ["capitalize", "rbCap"], ["none", "rbCaseNone"]] as const).map(([v, k]) => ({ label: t(k), checked: (info?.tt || "none") === v, run: () => send("case", v) })))}>
					<span className="glyph">Aa</span><Caret />
				</button>
				<ColorPop label={t("rbHighlight")} current={mark.slice(1)} disabled={noText} vars={vars} std={MARKS} noTheme
					onPick={(v) => { setMark(v); send("highlight", v); }} onNone={() => send("highlight", "transparent")}>
					<Icon d="M4 10.5l5.5-5.5 2 2L6 12.5H4zM9.5 5l1.5-1.5 2 2L11.5 7M2.5 14.5h11" />
				</ColorPop>
				<ColorPop label={t("rbFontColor")} current={info?.color} disabled={noText} vars={vars} onPick={(v) => send("color", v)}>
					<span className="glyph">가</span>
				</ColorPop>
			</Grp>

			<Grp label={t("rbParagraph")}>
				<button disabled={noText} aria-pressed={info?.list === "bu"} onClick={() => send("list", "bu")} title={t("rbBullets")} aria-label={t("rbBullets")}>
					<Icon><circle cx="3.5" cy="4.5" r="1" /><circle cx="3.5" cy="8" r="1" /><circle cx="3.5" cy="11.5" r="1" /><path d="M6.5 4.5h7M6.5 8h7M6.5 11.5h7" /></Icon>
				</button>
				<button disabled={noText} aria-pressed={info?.list === "num"} onClick={() => send("list", "num")} title={t("rbNumbers")} aria-label={t("rbNumbers")}>
					<Icon d="M3 3.5h1v3M2.5 6.5h2M2.5 9.5c.3-.6 2-.8 2 .2 0 .8-2 1.4-2 2.3h2M6.5 4.5h7M6.5 8h7M6.5 11.5h7" />
				</button>
				<button disabled={noText} onClick={() => send("indent", -1)} title={t("rbOutdent")} aria-label={t("rbOutdent")}>
					<Icon d="M2.5 3h11M7 6.5h6.5M7 9.5h6.5M2.5 13h11M5 6L3 8l2 2" />
				</button>
				<button disabled={noText} onClick={() => send("indent", 1)} title={t("rbIndent")} aria-label={t("rbIndent")}>
					<Icon d="M2.5 3h11M7 6.5h6.5M7 9.5h6.5M2.5 13h11M3 6l2 2-2 2" />
				</button>
				<i className="sep thin" />
				{([["left", "rbLeft", "M2.5 4h11M2.5 7h7M2.5 10h11M2.5 13h7"], ["center", "rbCenter", "M2.5 4h11M4.5 7h7M2.5 10h11M4.5 13h7"], ["right", "rbRight", "M2.5 4h11M6.5 7h7M2.5 10h11M6.5 13h7"], ["justify", "rbJustify", "M2.5 4h11M2.5 7h11M2.5 10h11M2.5 13h7"]] as const).map(([v, k, d]) => (
					<button key={v} disabled={noText} aria-pressed={align === v} onMouseDown={hold} onClick={() => send("align", v)} title={t(k)} aria-label={t(k)}><Icon d={d} /></button>
				))}
				<button disabled={noText} title={t("rbLineHeight")} aria-label={t("rbLineHeight")}
					onClick={(e) => openMenu(e, LINE_HEIGHTS.map((v) => ({ label: Number.isInteger(v) ? v.toFixed(1) : String(v), checked: info?.lh != null && Math.abs(info.lh - v) < 0.03, run: () => send("lineHeight", v) })))}>
					<Icon d="M7 4h7M7 8h7M7 12h7M3.5 3v10M2 4.5L3.5 3 5 4.5M2 11.5L3.5 13 5 11.5" /><Caret />
				</button>
				<button disabled={noText || !info?.flex} title={t("rbVAlign")} aria-label={t("rbVAlign")}
					onClick={(e) => openMenu(e, ([["flex-start", "rbTop"], ["center", "rbMiddle"], ["flex-end", "rbBottom"]] as const).map(([v, k]) => ({ label: t(k), checked: info?.valign === v, run: () => send("valign", v) })))}>
					<Icon d="M2.5 2.5h11M2.5 13.5h11M6 5.5h4v5H6z" /><Caret />
				</button>
			</Grp>

			<Grp label={t("rbDrawing")}>
				<Arrange t={t} info={info} send={send} />
				<button disabled={none} onClick={() => send("dup")} title={`${t("rbDup")} (Ctrl+D)`} aria-label={t("rbDup")}>
					<Icon><rect x="5" y="5" width="8.5" height="8.5" rx="1" /><path d="M11 3V2.5H2.5V11H3" /><path d="M9.25 7.5v4M7.25 9.5h4" /></Icon>
				</button>
				<button disabled={none} onClick={() => send("remove")} title={`${t("rbDelete")} (Delete)`} aria-label={t("rbDelete")}>
					<Icon d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9" />
				</button>
			</Grp>
		</>
	);
}

/** 글꼴 목록: 찾기 칸이 붙은 판. 이름을 그 글꼴로 그리고, 맨 위에 「테마 글꼴」(직접 준 글꼴 걷기)을 둔다 */
function FontList({ t, disabled, current, pick }: { t: Ctx["t"]; disabled: boolean; current: string; pick: (f: string) => void }) {
	const [fams, setFams] = useState<string[]>([]);
	const [q, setQ] = useState("");
	useEffect(() => { families().then(setFams, () => {}); }, []);
	const shown = fams.filter((f) => !q || f.toLowerCase().includes(q.toLowerCase())).slice(0, 300);
	return (
		<Pop label={t("rbFontList")} icon={null} disabled={disabled} className="rb-fonts" chip="rb-sizes">
			{(close) => (
				<>
					<input className="rb-find" autoFocus value={q} placeholder={t("rbFontFind")} aria-label={t("rbFontFind")} spellCheck={false}
						onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && shown[0]) { pick(shown[0]); close(); } }} />
					<div className="rb-flist" role="listbox" aria-label={t("rbFontList")}>
						{!q && <button role="option" aria-selected={false} onClick={() => { pick(""); close(); }}>{t("rbFontTheme")}</button>}
						{shown.map((f) => (
							<button key={f} role="option" aria-selected={f === current} style={{ fontFamily: `'${f}'` }} onClick={() => { pick(f); close(); }}>{f}</button>
						))}
						{!shown.length && <span className="rb-empty">{t("rbFontNone")}</span>}
					</div>
				</>
			)}
		</Pop>
	);
}

/** 정렬(앞뒤 순서) · 맞춤(쪽에 맞춤): 홈의 그리기와 도형 서식이 함께 쓴다 */
function Arrange({ t, info, send }: Pick<Ctx, "t" | "info" | "send">) {
	return (
		<>
			<button disabled={!info?.abs} title={t("rbArrange")} aria-label={t("rbArrange")}
				onClick={(e) => openMenu(e, [
					{ label: t("rbFront"), run: () => send("arrange", "front") },
					{ label: t("rbForward"), run: () => send("arrange", "forward") },
					{ label: t("rbBackward"), run: () => send("arrange", "backward") },
					{ label: t("rbBack"), run: () => send("arrange", "back") },
				])}>
				<Icon><rect x="2" y="2" width="8" height="8" rx="1" /><path d="M12 6h2v8H6v-2" /></Icon><Caret />
			</button>
			<button disabled={!info?.box} title={t("rbAlign")} aria-label={t("rbAlign")}
				onClick={(e) => openMenu(e, [
					{ label: t("rbToLeft"), run: () => send("alignTo", "left") },
					{ label: t("rbToCenter"), run: () => send("alignTo", "center") },
					{ label: t("rbToRight"), run: () => send("alignTo", "right") },
					"-",
					{ label: t("rbToTop"), run: () => send("alignTo", "top") },
					{ label: t("rbToMiddle"), run: () => send("alignTo", "middle") },
					{ label: t("rbToBottom"), run: () => send("alignTo", "bottom") },
				])}>
				<Icon d="M2.5 2v12M5 4.5h8v3H5zM5 9.5h5v3H5z" /><Caret />
			</button>
		</>
	);
}

function InsertTab({ t, info, send, insert, placing, win }: Ctx) {
	const tool = useDeck((s) => s.tool);
	const setTool = useDeck((s) => s.setTool);
	const toSelect = () => { if (tool !== "select") setTool("select"); };
	const [grid, setGrid] = useState({ r: 0, c: 0 });
	const size = (r: number, c: number) => t("rbTableN").replace("{c}", String(c)).replace("{r}", String(r));
	return (
		<>
			<Grp label={t("rbSlides")}>
				<button className="wide" onClick={() => { const st = useDeck.getState(); void st.addSlide(st.current + 1); }} title={t("rbNewSlide")}>
					<Icon><rect x="1.5" y="3" width="11" height="8" rx="1" /><path d="M12.5 11.5v3M11 13h3" /></Icon>{t("rbNewSlide")}
				</button>
			</Grp>
			<Grp label={t("rbTable")}>
				<Pop label={t("rbTableInsert")} wide={<>{t("rbTable")}</>} icon={<Icon><rect x="2" y="2.5" width="12" height="11" rx="1" /><path d="M2 6h12M2 9.5h12M6 2.5v11M10 2.5v11" /></Icon>}>
					{(close) => (
						<>
							<h4>{grid.r ? size(grid.r, grid.c) : t("rbTableInsert")}</h4>
							<div className="rb-grid" onMouseLeave={() => setGrid({ r: 0, c: 0 })}>
								{Array.from({ length: 6 * 8 }, (_, i) => {
									const r = Math.floor(i / 8) + 1, c = (i % 8) + 1;
									return (
										<button key={i} aria-pressed={r <= grid.r && c <= grid.c} onMouseEnter={() => setGrid({ r, c })} onFocus={() => setGrid({ r, c })}
											onClick={() => { toSelect(); send("table", { r, c }); close(); }} aria-label={size(r, c)} />
									);
								})}
							</div>
						</>
					)}
				</Pop>
			</Grp>
			<Grp label={t("rbImages")}>
				<button className="wide" onClick={() => insertImage(win, t("rbImage"), toSelect)} title={t("rbImage")}>
					<Icon><rect x="2" y="3" width="12" height="10" rx="1" /><path d="M2.5 11.5l3.5-3.5 3 3 2-2 2.5 2.5" /><circle cx="10.5" cy="6" r="1" /></Icon>{t("rbImage")}
				</button>
			</Grp>
			<Grp label={t("rbDrawing")}>
				<button className="wide" aria-pressed={placing === "text"} onClick={() => insert("text")} title={t("rbTextbox")}>
					<Icon><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M5.5 6h5M8 6v5" /></Icon>{t("rbTextbox")}
				</button>
				<button className="wide" aria-pressed={!!placing && placing !== "text"} title={t("rbShape")}
					onClick={(e) => openMenu(e, [
						{ label: t("rbRect"), checked: placing === "rect", run: () => insert("rect") },
						{ label: t("rbRound"), checked: placing === "round", run: () => insert("round") },
						{ label: t("rbEllipse"), checked: placing === "ellipse", run: () => insert("ellipse") },
						{ label: t("rbLine"), checked: placing === "line", run: () => insert("line") },
					])}>
					<Icon><rect x="2" y="2.5" width="7" height="7" rx="1" /><circle cx="10.5" cy="10.5" r="3.5" /></Icon>{t("rbShape")}<Caret />
				</button>
			</Grp>
			<Grp label={t("rbSymbol")}>
				{/* 기호는 글이 들어갈 자리가 있을 때만: 고르지 않았거나 글 덩이가 여럿인 상자면 넣을 곳이 없다 */}
				<Pop label={info?.text ? t("rbSymbol") : `${t("rbSymbol")} · ${t("rbSymbolHint")}`} disabled={!info?.text} wide={<>{t("rbSymbol")}</>} icon={<span className="glyph">※</span>}>
					{(close) => (
						<>
							<h4>{t("rbSymbol")}</h4>
							<div className="rb-sym">
								{SYMBOLS.map((s) => <button key={s} onMouseDown={hold} onClick={() => { send("symbol", s); close(); }} title={s}>{s}</button>)}
							</div>
						</>
					)}
				</Pop>
			</Grp>
		</>
	);
}

function ShapeTab({ t, info, send, vars }: Ctx) {
	const none = !info;
	const cm = (px?: number) => (px == null ? "" : (Math.round(px * CM * 100) / 100).toFixed(2));
	const dim = (k: "width" | "height", text: string) => {
		const v = parseFloat(text.replace(",", "."));
		const cur = k === "width" ? info?.w : info?.h;
		if (v > 0 && v <= 200 && cur != null && Math.abs(v / CM - cur) >= 0.5) send("dim", { [k]: v / CM });
	};
	const dimField = (k: "width" | "height", label: Key) => (
		<label className="rb-dim" title={t(label)}>
			<span aria-hidden>{k === "height" ? "↕" : "↔"}</span>
			<Field value={cm(k === "width" ? info?.w : info?.h)} commit={(v) => dim(k, v)} label={t(label)} disabled={none || !info?.box} mono />
			<span className="unit">cm</span>
		</label>
	);
	const transparency = info ? 100 - info.opacity : 0;
	return (
		<>
			<Grp label={t("rbShapeStyle")}>
				<ColorPop label={t("rbFill")} current={info?.fill} disabled={none} vars={vars} onPick={(v) => send("fill", v)} onNone={() => send("fill", "transparent")}>
					<Icon d="M3 9l5-5 5 5-5 5zM12.5 11.5c0 1 .7 1.5 1 1.5" />
				</ColorPop>
				<ColorPop label={t("rbOutline")} current={info?.line?.hex} disabled={none} vars={vars} onPick={(v) => send("line", { color: v })} onNone={() => send("line", { none: true })}
					extra={
						<>
							<h4>{t("rbWeight")}</h4>
							<div className="rb-row">
								{WEIGHTS.map((w) => (
									<button key={w} className="rb-w" aria-pressed={info?.line?.w === w} onMouseDown={hold} onClick={() => send("line", { width: w })} title={`${w}px`}>
										<span style={{ height: w }} />
									</button>
								))}
							</div>
							<h4>{t("rbDash")}</h4>
							<div className="rb-row">
								{([["solid", "rbSolid"], ["dashed", "rbDashed"], ["dotted", "rbDotted"]] as const).map(([v, k]) => (
									<button key={v} className="rb-dash" aria-pressed={!!info?.line && info.dash === v} onMouseDown={hold} onClick={() => send("line", { dash: v })} title={t(k)} aria-label={t(k)}>
										<span style={{ borderTopStyle: v }} />
									</button>
								))}
							</div>
						</>
					}>
					<Icon><rect x="3" y="3" width="10" height="10" rx="1" strokeDasharray="2 1.6" /></Icon>
				</ColorPop>
				<button disabled={none || !!info?.image} aria-pressed={!!info?.shadow} onClick={() => send("shadow", !info?.shadow)} title={t("rbShadow")} aria-label={t("rbShadow")}>
					<Icon><rect x="2.5" y="2.5" width="8.5" height="8.5" rx="1" /><path d="M13.5 5.5v8h-8" /></Icon>
				</button>
				<button disabled={none} title={t("rbRadius")} aria-label={t("rbRadius")}
					onClick={(e) => openMenu(e, RADII.map(([v, k]) => ({ label: t(k), checked: info ? (v === "9999px" ? info.round || info.radius >= 999 : !info.round && Math.abs(info.radius - parseFloat(v)) < 1) : false, run: () => send("radius", v) })))}>
					<Icon d="M2.5 13.5V8a5.5 5.5 0 0 1 5.5-5.5h5.5" /><Caret />
				</button>
				<button disabled={none} title={t("rbOpacity")} aria-label={t("rbOpacity")}
					onClick={(e) => openMenu(e, [0, 25, 50, 75].map((v) => ({ label: `${v}%`, checked: Math.abs(transparency - v) < 3, run: () => send("opacity", 100 - v) })))}>
					<Icon><circle cx="8" cy="8" r="5.5" /><path d="M8 2.5v11" /><path d="M8 4.5h3.5M8 7h5M8 9.5h5M8 12h3" strokeWidth="1" /></Icon><Caret />
				</button>
			</Grp>
			<Grp label={t("rbArrange")}>
				<Arrange t={t} info={info} send={send} />
			</Grp>
			<Grp label={t("rbSizeGrp")}>
				{dimField("height", "rbHeight")}
				{dimField("width", "rbWidth")}
			</Grp>
		</>
	);
}

function TableTab({ t, info, send, vars }: Ctx) {
	// 칸은 글을 고치는 중이거나 방금 고친 칸이 든 표를 골랐을 때 닿는다 (rt.js lastCell).
	// 단추는 모두 hold: 포커스를 뺏으면 고치기가 끝나 표 전체가 골라진다
	const cell = !!info?.cell;
	const b = (how: string, k: Key, d: string) => (
		<button className="wide" disabled={!cell} onMouseDown={hold} onClick={() => send("tbl", how)} title={t(k)}><Icon d={d} />{t(k)}</button>
	);
	return (
		<>
			<Grp label={t("rbRowsCols")}>
				{b("rowAbove", "rbRowAbove", "M2.5 8.5h11v5h-11zM8 2v4.5M6 4.5h4")}
				{b("rowBelow", "rbRowBelow", "M2.5 2.5h11v5h-11zM8 9.5V14M6 11.5h4")}
				{b("colLeft", "rbColLeft", "M8.5 2.5h5v11h-5zM2 8h4.5M4.25 6v4")}
				{b("colRight", "rbColRight", "M2.5 2.5h5v11h-5zM9.5 8H14M11.75 6v4")}
			</Grp>
			<Grp label={t("rbDelete")}>
				{b("rowDel", "rbRowDel", "M2.5 5.5h11v5h-11zM6 6.5l4 3M10 6.5l-4 3")}
				{b("colDel", "rbColDel", "M5.5 2.5h5v11h-5zM6.5 6l3 4M9.5 6l-3 4")}
				<button className="wide" onMouseDown={hold} onClick={() => send("tbl", "del")} title={t("rbTableDel")}>
					<Icon d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9" />{t("rbTableDel")}
				</button>
			</Grp>
			<Grp label={t("rbCellFill")}>
				<ColorPop label={t("rbCellFill")} current={info?.fill} disabled={!cell} vars={vars} onPick={(v) => send("fill", v)} onNone={() => send("fill", "transparent")}>
					<Icon d="M3 9l5-5 5 5-5 5zM12.5 11.5c0 1 .7 1.5 1 1.5" />
				</ColorPop>
			</Grp>
		</>
	);
}

/** 단추 아래로 여는 작은 판. 밖을 누르거나 Esc 면 닫는다. wide 를 주면 단추에 글자도 쓴다 */
function Pop({ label, icon, wide, disabled, current, className, chip, children }: {
	label: string; icon: React.ReactNode; wide?: React.ReactNode; disabled?: boolean; current?: string | null; className?: string; chip?: string;
	children: (close: () => void) => React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const k = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
		const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
		addEventListener("mousedown", k);
		addEventListener("keydown", esc);
		return () => { removeEventListener("mousedown", k); removeEventListener("keydown", esc); };
	}, [open]);
	useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
	return (
		<div className="rb-pop" ref={ref}>
			<button className={"rb-chip" + (wide ? " wide" : "") + (chip ? " " + chip : "")} disabled={disabled} aria-expanded={open} onMouseDown={hold} onClick={() => setOpen(!open)} title={label} aria-label={label}>
				{icon}
				{wide}
				<Caret />
				{current !== undefined && <span className="rb-bar" style={{ background: current ? (current.startsWith("#") ? current : "#" + current) : "transparent" }} />}
			</button>
			{open && <div className={"rb-menu" + (className ? " " + className : "")} role="dialog" aria-label={label}>{children(() => setOpen(false))}</div>}
		</div>
	);
}

/** 색 고르기: 단추 아래 띠가 지금 색이다. 칸을 누르면 바로 입히고 닫는다 */
function ColorPop({ label, current, disabled, vars, std = STD, noTheme, onPick, onNone, extra, children }: {
	label: string; current?: string | null; disabled: boolean; vars: Record<string, string>; std?: string[]; noTheme?: boolean;
	onPick: (c: string) => void; onNone?: () => void; extra?: React.ReactNode; children: React.ReactNode;
}) {
	const t = useT();
	// 템플릿 보조 색(--c1 …)도 테마 색 끝에 붙인다
	const theme: [string, string][] = noTheme ? [] : [...THEME.filter(([v]) => vars[v]).map(([v, k]): [string, string] => [v, t(k)]),
		...Object.keys(vars).filter((v) => /^--c\d$/.test(v)).sort().map((v): [string, string] => [v, `${t("paletteMore")} ${v.slice(3)}`])];
	return (
		<Pop label={label} icon={children} disabled={disabled} current={current ?? null}>
			{(close) => <ColorPanel {...{ current, vars, std, theme, onPick, onNone, extra, close }} />}
		</Pop>
	);
}

function ColorPanel({ current, vars, std, theme, onPick, onNone, extra, close }: {
	current?: string | null; vars: Record<string, string>; std: string[]; theme: [string, string][];
	onPick: (c: string) => void; onNone?: () => void; extra?: React.ReactNode; close: () => void;
}) {
	const t = useT();
	const more = useRef<HTMLInputElement>(null);
	// 「다른 색」은 고르기 창을 닫을 때(change) 한 번만 입힌다 — input 사건마다 입히면 끄는 동안 수십 판이 쌓인다
	useEffect(() => {
		const el = more.current;
		if (!el) return;
		const k = () => { onPick(el.value); close(); };
		el.addEventListener("change", k);
		return () => el.removeEventListener("change", k);
	});
	const pick = (c: string) => { onPick(c); close(); };
	return (
		<>
			{theme.length > 0 && (
				<>
					<h4>{t("rbTheme")}</h4>
					{/* 덱의 변수를 이 칸들에만 건다: 앱 화면도 --accent 같은 이름을 쓴다 */}
					<div className="rb-sw" style={vars as React.CSSProperties}>
						{theme.map(([v, name]) => (
							<button key={v} style={{ background: `var(${v})` }} onMouseDown={hold} onClick={() => pick(`var(${v})`)} title={name} aria-label={name} />
						))}
					</div>
				</>
			)}
			<h4>{t("rbStd")}</h4>
			<div className="rb-sw">
				{std.map((c) => (
					<button key={c} style={{ background: c }} aria-pressed={current === c.slice(1)} onMouseDown={hold} onClick={() => pick(c)} title={c} aria-label={c} />
				))}
			</div>
			{extra}
			<div className="rb-row rb-foot">
				{onNone && <button onMouseDown={hold} onClick={() => { onNone(); close(); }}>{t("rbNone")}</button>}
				<label className="rb-more">{t("rbMore")}<input ref={more} type="color" defaultValue={current ? "#" + current : "#000000"} /></label>
			</div>
		</>
	);
}

/** 그림 넣기 — 고른 파일을 assets/ 에 복사하고 슬라이드 창이 쪽 가운데에 놓는다 */
async function insertImage(win: React.MutableRefObject<Window | null>, title: string, before: () => void) {
	const st = useDeck.getState();
	const picked = await open({ multiple: false, title, filters: [{ name: title, extensions: [...IMAGE_EXT, "svg"] }] });
	if (!picked || Array.isArray(picked)) return;
	const name = (picked.split(/[\\/]/).pop() || "image").replace(/[\\/:*?"<>|#%\s]+/g, "_");
	const rel = `assets/${Date.now().toString(36)}-${name}`;
	try {
		await api.absCopyIn(picked, st.dir, rel);
	} catch (e) {
		return st.notify(String(e), "err");
	}
	before();
	tell(win.current, { t: "cmd", cmd: "image", v: "../" + rel.split("/").map(encodeURIComponent).join("/") });
}
