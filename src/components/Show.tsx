// 무대 아래 상태 띠 · 발표자 메모 · 슬라이드 쇼 — PowerPoint 아래쪽 상태 표시줄과 「슬라이드 쇼」 자리 (2026.11.27)
//
// 목차
//   useView       확대 배율(null 이면 창에 맞춤) · 메모 칸 펼침 · 슬라이드 쇼 켬. 펼침은 이 PC 에만 기억한다
//   ZOOMS · zoomStep   배율 단계 (PowerPoint 확대/축소 단추와 같은 걸음) · Ctrl+휠 · 단추가 함께 쓴다
//   StageStatus   쪽 번호 · 메모 · 슬라이드 쇼 · 축소 · 배율 · 확대 · 창에 맞춤
//   NotesPane     지금 쪽의 발표자 메모. 칸을 떠날 때 deck.json 에 쓴다 (Ctrl+Z 로 되돌린다)
//   SlideShow     창을 가득 채워 한 쪽씩. → · Space · Enter · 누르기 다음, ← · Backspace 이전, Home · End, Esc 끝. 쪽 번호를 치고 Enter 로 그 쪽
//                 슬라이드 창은 보기 모드로 띄우고 위를 투명한 판으로 덮는다 — 포커스가 슬라이드 창으로 가면 키가 쇼에 오지 않는다
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useT } from "../lib/i18n";
import { useDeck } from "../lib/store";
import { SlideFrame } from "./Workspace";

const NOTES_KEY = "claudeppt.notes";
export const useView = create<{ zoom: number | null; notes: boolean; show: boolean; setZoom: (z: number | null) => void; toggleNotes: () => void; setShow: (on: boolean) => void }>()((set, get) => ({
	zoom: null,
	notes: (() => { try { return localStorage.getItem(NOTES_KEY) === "1"; } catch { return false; } })(),
	show: false,
	setZoom: (zoom) => set({ zoom: zoom == null ? null : Math.max(0.1, Math.min(4, zoom)) }),
	toggleNotes: () => {
		const notes = !get().notes;
		set({ notes });
		try { localStorage.setItem(NOTES_KEY, notes ? "1" : "0"); } catch {}
	},
	setShow: (show) => set({ show }),
}));

// 배율 걸음 (쪽 실제 크기 = 1)
const ZOOMS = [0.1, 0.25, 0.33, 0.5, 0.66, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4];
/** 지금 배율(fit 이 맞춤 배율)에서 한 걸음 크게(+1) · 작게(-1) */
export function zoomStep(dir: 1 | -1, fit: number) {
	const cur = useView.getState().zoom ?? fit;
	const next = dir > 0 ? ZOOMS.find((z) => z > cur + 0.005) : [...ZOOMS].reverse().find((z) => z < cur - 0.005);
	// 맞춤 배율을 지나가면 거기서 한 번 멈춘다 — 다시 「맞춤」으로 돌아오기 쉽게
	if (next != null && (cur - fit) * (next - fit) < 0) return useView.getState().setZoom(null);
	useView.getState().setZoom(next ?? cur);
}

/** 슬라이드 쇼를 연다 — from 이 없으면 지금 쪽부터 */
export function startShow(from?: number) {
	const st = useDeck.getState();
	if (!st.deck?.slides.length) return;
	// 처음부터면 숨기지 않은 첫 쪽부터
	if (from != null) { let i = from; while (i < st.deck.slides.length - 1 && st.deck.slides[i]?.skip) i++; st.setCurrent(i); }
	useView.getState().setShow(true);
	// 창 전체 화면 — 웹뷰가 받지 않으면 앱 창 안을 채우는 것으로 그친다
	document.documentElement.requestFullscreen?.().catch(() => {});
}

const Ico = ({ d }: { d: string }) => <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d={d} /></svg>;

export function StageStatus({ fit, scale }: { fit: number; scale: number }) {
	const t = useT();
	const n = useDeck((s) => s.deck?.slides.length || 0);
	const current = useDeck((s) => s.current);
	const { zoom, notes, setZoom, toggleNotes } = useView();
	return (
		<div className="stage-status" role="toolbar" aria-label={t("viewBar")}>
			<span className="dim mono">{t("slideOf").replace("{n}", String(Math.min(current + 1, n))).replace("{m}", String(n))}</span>
			<i className="grow" />
			<button aria-pressed={notes} onClick={toggleNotes} title={t("notesHint")}>
				<Ico d="M3 3.5h10v9H3zM5.5 6.5h5M5.5 9h3.5" /><span>{t("notes")}</span>
			</button>
			<button onClick={() => startShow()} title={`${t("showFromHere")} (Shift+F5)`}>
				<Ico d="M5 3.5l7 4.5-7 4.5z" /><span>{t("slideShow")}</span>
			</button>
			<i className="sep" />
			<button onClick={() => zoomStep(-1, fit)} title={`${t("zoomOut")} (Ctrl+${t("wheel")})`} aria-label={t("zoomOut")}><Ico d="M3.5 8h9" /></button>
			<button className="pct mono" onClick={() => setZoom(zoom == null ? 1 : null)} title={zoom == null ? t("zoom100") : t("zoomFit")}>{Math.round(scale * 100)}%</button>
			<button onClick={() => zoomStep(1, fit)} title={`${t("zoomIn")} (Ctrl+${t("wheel")})`} aria-label={t("zoomIn")}><Ico d="M3.5 8h9M8 3.5v9" /></button>
			<button aria-pressed={zoom == null} onClick={() => setZoom(null)} title={t("zoomFit")} aria-label={t("zoomFit")}><Ico d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></button>
		</div>
	);
}

export function NotesPane({ slideId }: { slideId: string }) {
	const t = useT();
	const saved = useDeck((s) => s.deck?.slides.find((x) => x.id === slideId)?.notes || "");
	const setNotes = useDeck((s) => s.setNotes);
	const [text, setText] = useState(saved);
	const dirty = useRef(false);
	const textRef = useRef(text);
	textRef.current = text;
	// 쪽을 넘기거나 밖에서(Claude · 되돌리기) 바뀌면 칸을 새 값으로. 쓰는 중이면 덮지 않는다
	useEffect(() => { if (!dirty.current) setText(saved); }, [saved, slideId]);
	const commit = () => { if (dirty.current) { dirty.current = false; void setNotes(slideId, text); } };
	// 쓰다가 쪽을 넘기면 그 쪽에 남긴다
	useEffect(() => () => { if (dirty.current) { dirty.current = false; void useDeck.getState().setNotes(slideId, textRef.current); } }, [slideId]);
	return (
		<div className="notes-pane">
			<textarea value={text} placeholder={t("notesPlaceholder")} aria-label={t("notes")} spellCheck={false}
				onChange={(e) => { dirty.current = true; setText(e.target.value); }}
				onBlur={commit}
				onKeyDown={(e) => { if (e.key === "Escape") { (e.target as HTMLTextAreaElement).blur(); e.stopPropagation(); } }} />
		</div>
	);
}

export function SlideShow() {
	const t = useT();
	const deck = useDeck((s) => s.deck);
	const current = useDeck((s) => s.current);
	const rev = useDeck((s) => s.rev);
	const setShow = useView((s) => s.setShow);
	const [box, setBox] = useState({ w: innerWidth, h: innerHeight });
	const [ended, setEnded] = useState(false);
	const typed = useRef("");
	useEffect(() => {
		const r = () => setBox({ w: innerWidth, h: innerHeight });
		addEventListener("resize", r);
		return () => removeEventListener("resize", r);
	}, []);
	const n = deck?.slides.length || 0;
	const close = () => {
		setShow(false);
		if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
	};
	// PowerPoint 처럼 마지막 쪽 다음은 검은 「끝」 화면, 그다음에 닫는다. 숨긴 슬라이드는 건너뛴다
	const go = (d: number) => {
		const st = useDeck.getState();
		if (ended) { if (d > 0) close(); else setEnded(false); return; }
		const slides = st.deck?.slides || [];
		let i = st.current + d;
		while (i >= 0 && i < n && slides[i]?.skip) i += d;
		if (i >= n) return setEnded(true);
		if (i >= 0) st.setCurrent(i);
	};
	useEffect(() => {
		const k = (e: KeyboardEvent) => {
			const st = useDeck.getState();
			if (/^\d$/.test(e.key)) { typed.current += e.key; }
			else if (e.key === "Enter" && typed.current) { setEnded(false); st.setCurrent(+typed.current - 1); typed.current = ""; }
			else if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n", "N"].includes(e.key)) go(1);
			else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p", "P"].includes(e.key)) go(-1);
			else if (e.key === "Home") { setEnded(false); st.setCurrent(0); }
			else if (e.key === "End") { setEnded(false); st.setCurrent(n - 1); }
			else if (e.key === "Escape") close();
			else return;
			if (!/^\d$/.test(e.key)) typed.current = "";
			e.preventDefault();
			e.stopImmediatePropagation();
		};
		addEventListener("keydown", k, true);
		return () => removeEventListener("keydown", k, true);
	});
	// 전체 화면을 Esc 로 웹뷰가 먼저 풀면 쇼도 닫는다
	useEffect(() => {
		const f = () => { if (!document.fullscreenElement) setShow(false); };
		document.addEventListener("fullscreenchange", f);
		return () => document.removeEventListener("fullscreenchange", f);
	}, []);
	if (!deck || !n) return null;
	const slide = deck.slides[Math.min(current, n - 1)];
	const s = Math.min(box.w / deck.size.w, box.h / deck.size.h);
	const w = deck.size.w * s, h = deck.size.h * s;
	return (
		<div className="show" role="dialog" aria-label={t("slideShow")}
			onClick={() => go(1)} onContextMenu={(e) => { e.preventDefault(); go(-1); }}
			onWheel={(e) => go(e.deltaY > 0 ? 1 : -1)}>
			{ended
				? <div className="show-end">{t("showEnd")}</div>
				: <div className="show-sheet" style={{ width: w, height: h, left: (box.w - w) / 2, top: (box.h - h) / 2 }}>
					<SlideFrame key={slide.id} file={slide.file} rev={rev[slide.id] || 0} w={deck.size.w} h={deck.size.h} width={w} />
					{/* 슬라이드 창이 누름 · 키를 가져가지 않게 덮는다 */}
					<div className="show-cover" />
				</div>}
			<span className="show-no mono" aria-live="polite">{ended ? "" : `${current + 1} / ${n}`}</span>
		</div>
	);
}
