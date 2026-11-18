// 우클릭 메뉴 — 웹뷰 기본 메뉴(뒤로 · 새로 고침 · 인쇄) 대신 그 자리에서 할 일을 띄운다.
//
// 쓰는 법: 요소의 onContextMenu 에서 openMenu(e, 항목들). 가장 안쪽 요소가 먼저 연다 — 바깥 요소는 이미 열린 사건을 건너뛴다.
// 아무도 열지 않은 우클릭은 App 의 useDefaultMenu 가 받는다(입력칸 · 고른 글).
// 슬라이드 창(iframe) 안의 우클릭은 rt.js 가 넘겨 주고, frames.ts 가 그 iframe 에 같은 사건을 다시 쏜다 — 그래서 무대도 onContextMenu 하나로 받는다.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { api } from "../lib/api";
import { tNow } from "../lib/i18n";
import { useDeck } from "../lib/store";

export type MenuItem = { label: string; run: () => void; kbd?: string; disabled?: boolean; danger?: boolean; checked?: boolean } | "-";

const useMenu = create<{ at: { x: number; y: number } | null; items: MenuItem[] }>(() => ({ at: null, items: [] }));
const close = () => useMenu.setState({ at: null, items: [] });

/** 우클릭 자리에 메뉴를 연다. 글을 고른 채 눌렀으면 맨 위에 「복사」를 더한다 — 대화의 답 일부를 옮겨 적는 일이 잦다 */
export function openMenu(e: React.MouseEvent | MouseEvent, items: MenuItem[]) {
	if (e.defaultPrevented) return;
	e.preventDefault();
	const sel = pageSelection();
	const list = sel.trim() ? [{ label: tNow("copy"), kbd: "Ctrl+C", run: () => copyText(sel) }, "-" as const, ...items] : items;
	const shown = trim(list);
	if (!shown.length) return;
	// 슬라이드 창에서 연 메뉴면 포커스를 앱으로 되찾는다 — 안 그러면 방향키 · Enter 가 메뉴 대신 슬라이드 창으로 가서 쪽이 넘어간다
	if (document.activeElement instanceof HTMLIFrameElement) document.activeElement.blur();
	useMenu.setState({ at: { x: e.clientX, y: e.clientY }, items: shown });
}

/** 본문에서 고른 글. 입력칸 안에서 고른 글은 뺀다 — 포커스가 다른 데로 가도 getSelection 이 입력칸의 고른 글을 돌려줘
 *  (범위가 입력칸을 감싼 자리로 잡힌다) 쪽 목록 메뉴에까지 「복사」가 붙는다 */
function pageSelection() {
	const s = getSelection();
	if (!s?.rangeCount) return "";
	const r = s.getRangeAt(0);
	const n = r.startContainer.nodeType === 1 ? r.startContainer.childNodes[r.startOffset] : null;
	if (n instanceof HTMLInputElement || n instanceof HTMLTextAreaElement || document.activeElement?.closest("input, textarea")) return "";
	return s.toString();
}

export const copyText = (s: string) => navigator.clipboard.writeText(s).catch(() => useDeck.getState().notify(tNow("clipFail"), "err"));

/** 맨 앞 · 맨 뒤 · 겹친 구분선을 걷어 낸다 — 조건으로 항목을 빼다 보면 생긴다 */
function trim(items: MenuItem[]) {
	const out: MenuItem[] = [];
	for (const it of items) if (it !== "-" || (out.length && out[out.length - 1] !== "-")) out.push(it);
	while (out[out.length - 1] === "-") out.pop();
	return out;
}

/** 아무 요소도 열지 않은 우클릭 — 입력칸이면 편집 메뉴, 고른 글이 있으면 복사. 그 밖에는 메뉴 없이 기본 메뉴만 막는다.
 *  개발 판은 기본 메뉴(검사)를 남긴다 */
export function useDefaultMenu() {
	useEffect(() => {
		const k = (e: MouseEvent) => {
			if (e.defaultPrevented) return;
			const el = e.target as HTMLElement;
			const field = el.closest?.("input, textarea, [contenteditable]") as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null;
			if (field) return openMenu(e, fieldItems(field));
			if (pageSelection().trim()) return openMenu(e, []);
			if (!import.meta.env.DEV) e.preventDefault();
		};
		addEventListener("contextmenu", k);
		return () => removeEventListener("contextmenu", k);
	}, []);
}

/** 입력칸 편집 메뉴. execCommand 로 고쳐야 입력칸의 실행 취소 기록 · React onChange 가 그대로 돈다 */
function fieldItems(f: HTMLElement): MenuItem[] {
	const ro = (f as HTMLInputElement).readOnly || (f as HTMLInputElement).disabled;
	const has = "selectionStart" in f ? (f as HTMLInputElement).selectionStart !== (f as HTMLInputElement).selectionEnd : !!getSelection()?.toString();
	const cmd = (c: string) => () => { f.focus(); document.execCommand(c); };
	return [
		{ label: tNow("undo"), kbd: "Ctrl+Z", run: cmd("undo"), disabled: ro },
		"-",
		{ label: tNow("cut"), kbd: "Ctrl+X", run: cmd("cut"), disabled: ro || !has },
		{ label: tNow("copy"), kbd: "Ctrl+C", run: cmd("copy"), disabled: !has },
		{
			label: tNow("paste"), kbd: "Ctrl+V", disabled: ro,
			// navigator.clipboard.readText 는 웹뷰가 권한을 묻다 멈춰서 Rust 로 읽는다
			run: () => api.clipText().then((s) => { f.focus(); document.execCommand("insertText", false, s); }, () => useDeck.getState().notify(tNow("clipFail"), "err")),
		},
		"-",
		{ label: tNow("selectAll"), kbd: "Ctrl+A", run: cmd("selectAll") },
	];
}

/** 열린 메뉴. 항목을 눌러도 입력칸이 포커스를 잃지 않게 mousedown 을 막고, 키보드는 창 전체에서 받는다 */
export function ContextMenu() {
	const { at, items } = useMenu();
	const ref = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ x: 0, y: 0 });
	const [sel, setSel] = useState(-1);
	const live = items.map((it, i) => (it !== "-" && !it.disabled ? i : -1)).filter((i) => i >= 0);

	// 화면 끝에서 열면 안쪽으로 접어 넣는다
	useLayoutEffect(() => {
		if (!at || !ref.current) return;
		const r = ref.current.getBoundingClientRect();
		setPos({ x: at.x + r.width > innerWidth - 4 ? Math.max(4, at.x - r.width) : at.x, y: at.y + r.height > innerHeight - 4 ? Math.max(4, innerHeight - 4 - r.height) : at.y });
		setSel(-1);
	}, [at, items]);

	useEffect(() => {
		if (!at) return;
		const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
		const key = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
			else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				if (!live.length) return;
				const k = live.indexOf(sel);
				setSel(live[(k < 0 ? (e.key === "ArrowDown" ? 0 : live.length - 1) : k + (e.key === "ArrowDown" ? 1 : live.length - 1)) % live.length]);
			} else if (e.key === "Enter" && sel >= 0) { const it = items[sel]; close(); if (it !== "-") it.run(); }
			else return;
			// 메뉴가 떠 있는 동안의 방향키 · Enter 가 쪽 넘김 · 보내기로 새지 않게
			e.preventDefault();
			e.stopPropagation();
		};
		// 슬라이드 창을 누르면 창 포커스가 iframe 으로 가서 blur 가 온다 — 그때도 닫는다
		addEventListener("pointerdown", down, true);
		addEventListener("keydown", key, true);
		addEventListener("blur", close);
		addEventListener("resize", close);
		addEventListener("wheel", close, true);
		return () => {
			removeEventListener("pointerdown", down, true);
			removeEventListener("keydown", key, true);
			removeEventListener("blur", close);
			removeEventListener("resize", close);
			removeEventListener("wheel", close, true);
		};
	}, [at, items, sel]);

	if (!at) return null;
	return (
		<div className="ctxmenu" role="menu" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
			{items.map((it, i) =>
				it === "-" ? <div key={i} className="sep" role="separator" /> : (
					<button key={i} role={it.checked != null ? "menuitemcheckbox" : "menuitem"} aria-checked={it.checked} disabled={it.disabled}
						className={(i === sel ? "on" : "") + (it.danger ? " danger" : "")}
						onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setSel(i)}
						onClick={() => { close(); it.run(); }}>
						<span className="chk">{it.checked ? "✓" : ""}</span>
						<span className="label">{it.label}</span>
						{it.kbd && <kbd>{it.kbd}</kbd>}
					</button>
				),
			)}
		</div>
	);
}
