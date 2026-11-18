// 작업 화면 — 왼쪽 쪽 목록 · 가운데 무대(슬라이드 + 핀 + 판 줄기) · 오른쪽 대화.
//
// 목차
//   SlideFrame    슬라이드 iframe 하나. 크기를 맞춰 줄이고, 다시 그릴 표식(rev)이 바뀌면 새로 읽는다
//   Rail          쪽 목록 — 끌어서 순서 바꾸기 · Delete 로 빼기 · 끝의 + 로 빈 쪽
//   Stage         무대 — 핀 찍기 · 직접 편집 메시지 받기 · 지난 판 미리 보기 · 휠로 쪽 넘기기
//   Flow          이어 보기 — 모든 쪽을 세로로 늘어놓고 스크롤로 넘긴다. 가운데 온 쪽이 지금 쪽이 된다
//   Track         판 줄기 — 판마다 눈금, 릴리즈는 긴 눈금
//   우클릭 메뉴   slideItems(쪽 목록 · 이어 보기) · Stage 의 무대 메뉴 · 판 눈금 메뉴 — 메뉴 틀은 ContextMenu.tsx
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type Commit, deckUrl } from "../lib/api";
import { type Deck } from "../lib/deck";
import { ask, onFrame } from "../lib/frames";
import { openAny } from "../lib/flows";
import { useT } from "../lib/i18n";
import { useSettings } from "../lib/settings";
import { type Pin, useDeck } from "../lib/store";
import { type MenuItem, openMenu } from "./ContextMenu";
import { useFileDrop } from "./Home";
import { CompareBar, CompareLens } from "./CompareLens";
import Talk from "./Talk";

export function SlideFrame({ file, rev, width, height, w, h, onWin, revHash }: { file: string; rev: number; width: number; height?: number; w: number; h: number; onWin?: (win: Window | null) => void; revHash?: string }) {
	const id = useDeck((s) => s.id);
	const frames = useDeck((s) => s.frames);
	const mode = useDeck((s) => s.mode);
	const ref = useRef<HTMLIFrameElement>(null);
	const s = width / w;
	const src = deckUrl(id, file, revHash) + `?v=${rev}`;
	useEffect(() => {
		const f = ref.current;
		return () => { if (f?.contentWindow) frames.delete(f.contentWindow); onWin?.(null); };
	}, [src]);
	return (
		<iframe
			ref={ref}
			src={src}
			title={file}
			width={w}
			height={h}
			style={{ transform: `scale(${s})`, transformOrigin: "0 0", width: w, height: height ? height / s : h }}
			onLoad={() => {
				const win = ref.current?.contentWindow;
				if (!win) return;
				frames.add(win);
				win.postMessage({ __deck: 1, t: "mode", mode: onWin ? mode : "view" }, "*");
				onWin?.(win);
			}}
		/>
	);
}

/** 쪽 넘김 키 — 앱 화면에서 누른 것도, 슬라이드 창이 넘겨준 것(rt.js key)도 여기서 처리한다. 처리했으면 true.
 *  편집 모드의 좌우 방향키는 고르는 요소를 옮기는 데 쓰므로 넘기지 않는다 */
function navKey(key: string): boolean {
	const st = useDeck.getState();
	const n = st.deck?.slides.length || 1;
	if (key === "ArrowDown" || key === "PageDown" || (key === "ArrowRight" && st.mode !== "edit")) st.setCurrent(st.current + 1);
	else if (key === "ArrowUp" || key === "PageUp" || (key === "ArrowLeft" && st.mode !== "edit")) st.setCurrent(st.current - 1);
	else if (key === "Home") st.setCurrent(0);
	else if (key === "End") st.setCurrent(n - 1);
	else return false;
	return true;
}

/** 휠로 쪽 넘기기 — 한 칸 굴림(≈100)이나 터치패드로 조금씩 민 양이 모이면 한 쪽 넘기고, 잠깐 쉰다.
 *  쉬지 않으면 터치패드 관성 한 번에 열 쪽씩 날아간다 */
function useWheelNav() {
	const acc = useRef(0);
	const until = useRef(0);
	return useCallback((dy: number) => {
		const now = performance.now();
		if (now < until.current) return;
		acc.current += dy;
		if (Math.abs(acc.current) < 60) return;
		const st = useDeck.getState();
		st.setCurrent(st.current + (acc.current > 0 ? 1 : -1));
		acc.current = 0;
		until.current = now + 260;
	}, []);
}

/** 쪽 하나의 우클릭 항목 — 쪽 목록 · 이어 보기가 같이 쓴다. 빼기는 Delete 키와 같다 */
function slideItems(i: number, n: number, t: ReturnType<typeof useT>): MenuItem[] {
	const st = useDeck.getState();
	return [
		{ label: t("mention"), kbd: `@${i + 1}`, run: () => st.mentionSlide(i + 1) },
		"-",
		{ label: t("insertAbove"), run: () => st.addSlide(i) },
		{ label: t("insertBelow"), run: () => st.addSlide(i + 1) },
		{ label: t("duplicate"), run: () => st.duplicateSlide(i) },
		"-",
		{ label: t("moveUp"), run: () => st.moveSlide(i, i - 1), disabled: i === 0 },
		{ label: t("moveDown"), run: () => st.moveSlide(i, i + 2), disabled: i >= n - 1 },
		"-",
		{ label: t("removeSlide"), kbd: "Delete", danger: true, run: () => st.removeSlide(i), disabled: n < 2 },
	];
}

/** 지난 판을 보는 동안의 우클릭 — 지난 판의 쪽은 고칠 수 없으니 돌아가거나 되돌리는 것만 둔다 */
function previewItems(t: ReturnType<typeof useT>): MenuItem[] {
	const st = useDeck.getState();
	const p = st.preview;
	return p ? [
		{ label: t("backToNow"), run: () => st.setPreview(null) },
		{ label: t("restore"), run: () => st.restore(p), disabled: !!st.running },
	] : [];
}

/** 옆 영역 너비 — 이 PC 에만 남긴다(설정 파일에 넣을 만한 값이 아니다). 저장소가 막혀도 기본값으로 그린다 */
function useWidth(key: string, init: number, min: number, max: number) {
	const k = "claudeppt.width." + key;
	const [w, setW] = useState(() => {
		try { const v = Number(localStorage.getItem(k)); return v ? Math.min(max, Math.max(min, v)) : init; } catch { return init; }
	});
	const set = useCallback((v: number | null) => {
		const n = v == null ? init : Math.round(Math.min(max, Math.max(min, v)));
		setW(n);
		try { localStorage.setItem(k, String(n)); } catch {}
	}, [k, init, min, max]);
	return [w, set] as const;
}

/** 영역 경계 손잡이 — 끌기 · 화살표 키(Shift 는 크게)로 너비를 바꾸고, 두 번 누르면 기본 너비로 돌린다.
 *  끄는 동안 iframe 이 포인터를 가로채면 손을 놓쳐서 포인터를 손잡이에 붙잡아 둔다. */
function Splitter({ side, at, set, label }: { side: "left" | "right"; at: number; set: (v: number | null) => void; label: string }) {
	const [drag, setDrag] = useState(false);
	const start = useRef({ x: 0, w: 0 });
	const dir = side === "left" ? 1 : -1;
	return (
		<div
			className={"split" + (drag ? " on" : "")}
			style={side === "left" ? { left: at - 3 } : { right: at - 3 }}
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			aria-valuenow={at}
			tabIndex={0}
			onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); start.current = { x: e.clientX, w: at }; setDrag(true); }}
			onPointerMove={(e) => { if (drag) set(start.current.w + (e.clientX - start.current.x) * dir); }}
			onPointerUp={() => setDrag(false)}
			onPointerCancel={() => setDrag(false)}
			onDoubleClick={() => set(null)}
			onKeyDown={(e) => {
				const step = e.shiftKey ? 48 : 12;
				if (e.key === "ArrowLeft") set(at - step * dir);
				else if (e.key === "ArrowRight") set(at + step * dir);
				else if (e.key === "Home" || e.key === "Enter") set(null);
				else return;
				e.preventDefault();
				e.stopPropagation();
			}}
		/>
	);
}

export default function Workspace() {
	const setMode = useDeck((s) => s.setMode);
	const setCurrent = useDeck((s) => s.setCurrent);
	const over = useFileDrop(useCallback((paths: string[]) => { if (paths[0] && /\.(pptx|cppt)$/i.test(paths[0])) openAny(paths[0]); }, []));
	useEffect(() => {
		const k = (e: KeyboardEvent) => {
			const tgt = e.target as Element;
			if (tgt.closest("input, textarea, [contenteditable]") || e.ctrlKey || e.altKey || e.metaKey) return;
			const key = e.key.toLowerCase();
			if (key === "v") setMode("view");
			else if (key === "p") setMode("pin");
			else if (key === "e") setMode("edit");
			else if (key === "c") { const st = useDeck.getState(); if (st.report) st.setCompare(!st.compare); else st.check(); }
			else if (key === "s") { const st = useDeck.getState(); st.setFlow(!st.flow); }
			else if (!navKey(e.key)) {
				if (e.key === "Escape") { if (useDeck.getState().compare) useDeck.getState().setCompare(false); else setMode("view"); }
				else return;
			}
			e.preventDefault();
		};
		addEventListener("keydown", k);
		return () => removeEventListener("keydown", k);
	}, [setMode, setCurrent]);
	const t = useT();
	const [railW, setRailW] = useWidth("rail", 148, 96, 280);
	const [talkW, setTalkW] = useWidth("talk", 384, 300, 720);
	return (
		<main className="work" style={{ gridTemplateColumns: `${railW}px minmax(0, 1fr) ${talkW}px` }}>
			<Rail />
			<Stage />
			<Talk />
			{/* 무대는 360px 아래로 줄이지 않는다 — 옆 영역을 넓혀도 슬라이드가 보여야 한다 */}
			<Splitter side="left" at={railW} set={(v) => setRailW(v == null ? v : Math.min(v, innerWidth - talkW - 360))} label={t("slides")} />
			<Splitter side="right" at={talkW} set={(v) => setTalkW(v == null ? v : Math.min(v, innerWidth - railW - 360))} label={t("talk")} />
			{over && <div className="dropzone">{useSettings.getState().s.lang === "ko" ? "PPTX · CPPT 열기" : "Open PPTX · CPPT"}</div>}
		</main>
	);
}

// ── 쪽 목록 ──
function usePreviewDeck(): Deck | null {
	const preview = useDeck((s) => s.preview);
	const id = useDeck((s) => s.id);
	const [d, setD] = useState<Deck | null>(null);
	useEffect(() => {
		if (!preview) return setD(null);
		fetch(deckUrl(id, "deck.json", preview.hash)).then((r) => r.json()).then(setD, () => setD(null));
	}, [preview, id]);
	return d;
}

function Rail() {
	const t = useT();
	const live = useDeck((s) => s.deck)!;
	const preview = useDeck((s) => s.preview);
	const past = usePreviewDeck();
	const deck = preview && past ? past : live;
	const rev = useDeck((s) => s.rev);
	const current = useDeck((s) => s.current);
	const setCurrent = useDeck((s) => s.setCurrent);
	const pins = useDeck((s) => s.pins);
	const turns = useDeck((s) => s.turns);
	const report = useDeck((s) => s.report);
	const mentionSlide = useDeck((s) => s.mentionSlide);
	const move = useDeck((s) => s.moveSlide);
	const addSlide = useDeck((s) => s.addSlide);
	const removeSlide = useDeck((s) => s.removeSlide);
	const [drag, setDrag] = useState<number | null>(null);
	const [dropAt, setDropAt] = useState<number | null>(null);
	const lastFiles = useMemo(() => new Set(turns[turns.length - 1]?.tools.map((x) => x.file).filter(Boolean)), [turns]);
	const listRef = useRef<HTMLDivElement>(null);
	useEffect(() => { listRef.current?.querySelectorAll(".rail-item")[current]?.scrollIntoView({ block: "nearest" }); }, [current]);

	const add = () => addSlide(current + 1);

	return (
		<nav className="rail" ref={listRef} aria-label={t("slides")}
			onKeyDown={(e) => {
				if (e.key === "Delete" && !preview) removeSlide(current);
			}}>
			{deck.slides.map((sl, i) => {
				const n = pins.filter((p) => p.slide === sl.id).length;
				return (
					<div key={sl.id} className={"rail-item" + (i === current ? " on" : "") + (dropAt === i ? " drop-before" : "")}
						onDragOver={(e) => { if (drag != null) { e.preventDefault(); setDropAt(i); } }}
						onDrop={() => { if (drag != null) move(drag, i); setDrag(null); setDropAt(null); }}
						// 누른 쪽을 지금 쪽으로 — PowerPoint 처럼 메뉴가 가리키는 쪽이 무대에 보인다
						onContextMenu={(e) => { setCurrent(i); openMenu(e, preview ? previewItems(t) : slideItems(i, live.slides.length, t)); }}>
						<div className="no">
							<span>{i + 1}</span>
							{n > 0 && <span className="pins" title={`${t("pins")} ${n}`} />}
							{lastFiles.has(sl.file) && !preview && <span className="fresh" title={t("changed")} />}
							{(() => {
								const c = report?.slides.find((x) => x.id === sl.id);
								if (!c) return null;
								return c.score > 0.05 ? <span className="drift" title={`${t("diff")} ${c.score}%`}>≠{c.score < 10 ? c.score.toFixed(1) : Math.round(c.score)}</span> : <span className="same" title={`${t("diff")} 0%`}>=</span>;
							})()}
							{!preview && <button className="at" onClick={() => mentionSlide(i + 1)} title={`${t("mention")} (@${i + 1})`} aria-label={`${t("mention")} @${i + 1}`}>@</button>}
						</div>
						<button className="thumb" draggable={!preview} onDragStart={() => setDrag(i)} onDragEnd={() => { setDrag(null); setDropAt(null); }}
							onClick={() => setCurrent(i)} title={sl.title || `${i + 1}`} aria-current={i === current}>
							<ThumbFrame file={sl.file} rev={rev[sl.id] || 0} w={deck.size.w} h={deck.size.h} revHash={preview?.hash} />
						</button>
					</div>
				);
			})}
			{!preview && (
				<div className="rail-item" onDragOver={(e) => { if (drag != null) { e.preventDefault(); setDropAt(deck.slides.length); } }} onDrop={() => { if (drag != null) move(drag, deck.slides.length); setDrag(null); setDropAt(null); }}>
					<span />
					<button className="rail-add" onClick={add} title={t("addSlide")} aria-label={t("addSlide")}>+</button>
				</div>
			)}
		</nav>
	);
}

/** 쪽 목록 미리보기는 목록에서 보이는 언저리(위아래 한 화면쯤)에 있을 때만 iframe 을 띄운다.
 *  쪽마다 늘 띄우면 큰 덱(수백 쪽 · 큰 그림)을 여는 순간 iframe 이 쪽 수만큼 원본 크기로 그림을 읽어 웹뷰가 버벅이거나 멈춘다.
 *  멀어지면 내린다 — 다시 오면 그때 새로 읽는다. 내보내기 · 비교 검사는 화면 밖 틀(offscreen)을 따로 쓰므로 이것과 무관하다. */
function ThumbFrame(p: { file: string; rev: number; w: number; h: number; revHash?: string }) {
	const ref = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	const [near, setNear] = useState(false);
	useLayoutEffect(() => {
		const el = ref.current!;
		const ro = new ResizeObserver(() => setWidth(el.clientWidth));
		ro.observe(el);
		const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root: el.closest(".rail"), rootMargin: "100% 0px" });
		io.observe(el);
		return () => { ro.disconnect(); io.disconnect(); };
	}, []);
	return <div ref={ref} style={{ position: "absolute", inset: 0 }}>{near && width > 0 && <SlideFrame {...p} width={width} />}</div>;
}

// ── 무대 ──
function Stage() {
	const t = useT();
	const live = useDeck((s) => s.deck)!;
	const preview = useDeck((s) => s.preview);
	const past = usePreviewDeck();
	const deck = preview && past ? past : live;
	const current = useDeck((s) => s.current);
	const mode = useDeck((s) => s.mode);
	const rev = useDeck((s) => s.rev);
	const pins = useDeck((s) => s.pins);
	const addPin = useDeck((s) => s.addPin);
	const applyDirect = useDeck((s) => s.applyDirect);
	const restore = useDeck((s) => s.restore);
	const setPreview = useDeck((s) => s.setPreview);
	const compare = useDeck((s) => s.compare && !!s.report && !s.preview);
	const report = useDeck((s) => s.report);
	const flowOn = useDeck((s) => s.flow);
	const setFlow = useDeck((s) => s.setFlow);
	const setMode = useDeck((s) => s.setMode);
	// 비교 렌즈는 한 쪽 무대에만 있다 — 비교 중에는 이어 보기를 잠시 접는다
	const flow = flowOn && !compare;
	const wheel = useWheelNav();
	const canvas = useRef<HTMLDivElement>(null);
	const [box, setBox] = useState({ w: 0, h: 0 });
	const [active, setActive] = useState<string | null>(null);
	const win = useRef<Window | null>(null);
	const slide = deck.slides[Math.min(current, deck.slides.length - 1)];

	useLayoutEffect(() => {
		const el = canvas.current!;
		const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const pad = 36;
	const scale = Math.max(0.05, Math.min((box.w - pad * 2) / deck.size.w, (box.h - pad * 2) / deck.size.h));
	const left = (box.w - deck.size.w * scale) / 2, top = (box.h - deck.size.h * scale) / 2;

	// 직접 편집 — 무대 iframe 이 보낸 것만 받는다
	useEffect(() => onFrame((m, src) => {
		if (src !== win.current || !slide) return;
		// 슬라이드 창 위에서 굴린 휠 · 누른 넘김 키 (rt.js 가 넘겨준다)
		if (m.t === "wheel") return wheel(m.dy);
		if (m.t === "key") return void navKey(m.key);
		if (preview) return;
		if (m.t === "edit") applyDirect(slide.id, m.path, { t: "edit", html: m.html });
		else if (m.t === "patch") applyDirect(slide.id, m.path, { t: "patch", style: m.style });
		else if (m.t === "remove") applyDirect(slide.id, m.path, { t: "remove" });
	}), [slide?.id, preview]);

	const onPin = (e: React.MouseEvent) => {
		if (mode !== "pin" || preview || !slide || (e.target as Element).closest(".pinmark")) return;
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		pinAt((e.clientX - r.left) / scale, (e.clientY - r.top) / scale);
	};
	/** 슬라이드 (x, y) 에 핀을 꽂고 의견 칸을 연다. 그 자리 요소는 슬라이드 창에 물어 핀에 붙인다 */
	const pinAt = async (x: number, y: number) => {
		if (!slide) return;
		let target: Pin["target"];
		try {
			if (win.current) {
				const hit: any = await ask(win.current, { t: "hit", x, y }, 1500);
				target = { tag: hit.tag, text: hit.text, path: hit.path };
			}
		} catch {}
		setActive(addPin({ slide: slide.id, x, y, text: "", target }));
	};

	// 무대 우클릭 — 슬라이드 창 안에서 누른 것은 frames.ts 가 다시 쏴 준다(__deck 에 창이 잰 자리 · 요소)
	const stageMenu = (e: React.MouseEvent) => {
		if (!slide) return;
		if (preview) return openMenu(e, previewItems(t));
		const st = useDeck.getState();
		const hit = (e.nativeEvent as MouseEvent & { __deck?: { x: number; y: number; path: number[] | null; tag: string; text: string } }).__deck;
		let at = hit ? { x: hit.x, y: hit.y } : null;
		const sheet = !flow && canvas.current?.querySelector(".sheet");
		if (!at && sheet) {
			const r = sheet.getBoundingClientRect();
			const x = (e.clientX - r.left) / scale, y = (e.clientY - r.top) / scale;
			if (x >= 0 && y >= 0 && x <= deck.size.w && y <= deck.size.h) at = { x, y };
		}
		const i = current, n = deck.slides.length;
		openMenu(e, [
			{ label: t("mention"), kbd: `@${i + 1}`, run: () => st.mentionSlide(i + 1) },
			...(at && !flow && !compare ? [{ label: t("pinHere"), run: () => pinAt(at.x, at.y) }] : []),
			...(mode === "edit" && hit?.path?.length ? [{ label: `${t("removeEl")} <${hit.tag}>`, kbd: "Delete", danger: true, run: () => applyDirect(slide.id, hit.path, { t: "remove" }) }] : []),
			"-",
			{ label: t("view"), kbd: "V", checked: mode === "view", run: () => setMode("view") },
			{ label: t("pin"), kbd: "P", checked: mode === "pin", run: () => setMode("pin") },
			{ label: t("edit"), kbd: "E", checked: mode === "edit", run: () => setMode("edit") },
			{ label: t("flow"), kbd: "S", checked: flowOn, run: () => setFlow(!flowOn) },
			report ? { label: t("compare"), kbd: "C", checked: st.compare, run: () => st.setCompare(!st.compare) } : { label: t("runCheck"), kbd: "C", run: () => st.check(), disabled: !!st.busy },
			"-",
			{ label: t("duplicate"), run: () => st.duplicateSlide(i) },
			{ label: t("removeSlide"), danger: true, run: () => st.removeSlide(i), disabled: n < 2 },
		]);
	};

	if (!slide) return <section className="stage" />;
	const mine = pins.filter((p) => p.slide === slide.id);
	const order = pins.map((p) => p.id);

	return (
		<section className="stage" data-mode={preview ? "view" : mode} aria-label={t("slides")}>
			<div className="stage-banner">
				{compare && <CompareBar slide={report?.slides.find((x) => x.id === slide.id)} />}
				{preview && (
					<div className="past" role="status">
						<span className="mono">v{preview.n}</span>
						<span style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }}>{preview.subject}</span>
						<span className="dim mono">{preview.date}</span>
						<button className="primary" onClick={() => restore(preview)}>{t("restore")}</button>
						<button onClick={() => setPreview(null)}>{t("backToNow")}</button>
					</div>
				)}
			</div>
			<div className="layout" role="group" aria-label={t("flow")}>
				<button aria-pressed={!flowOn} onClick={() => setFlow(false)} title={`${t("single")} (S)`}>{t("single")}</button>
				<button aria-pressed={flowOn} onClick={() => setFlow(true)} title={`${t("flow")} (S)`}>{t("flow")}</button>
			</div>
			<div className="canvas" ref={canvas} onWheel={flow ? undefined : (e) => wheel(e.deltaY)} onContextMenu={stageMenu}>
				{flow ? <Flow deck={deck} revHash={preview?.hash} /> : box.w > 0 && (
					<div className="sheet" style={{ left, top, width: deck.size.w * scale, height: deck.size.h * scale }}>
						<div style={{ width: deck.size.w * scale, height: deck.size.h * scale, overflow: "hidden", position: "relative" }}>
							<div style={{ position: "absolute", left: 0, top: 0 }}>
								<SlideFrame key={slide.id + (preview?.hash || "")} file={slide.file} rev={rev[slide.id] || 0} w={deck.size.w} h={deck.size.h} width={deck.size.w * scale} revHash={preview?.hash} onWin={(w) => { win.current = w; }} />
							</div>
						</div>
						{compare && report?.slides.find((x) => x.id === slide.id) && (
							<CompareLens slide={report.slides.find((x) => x.id === slide.id)!} w={deck.size.w} h={deck.size.h} scale={scale} />
						)}
						{!preview && !compare && (
							<div className="overlay" onClick={onPin}>
								{mine.map((p) => (
									<PinMark key={p.id} pin={p} n={order.indexOf(p.id) + 1} scale={scale} flip={p.x * scale > deck.size.w * scale - 290} open={active === p.id} onOpen={() => setActive(active === p.id ? null : p.id)} onClose={() => setActive(null)} />
								))}
							</div>
						)}
					</div>
				)}
			</div>
			<Track />
		</section>
	);
}

// ── 이어 보기 ──
// 위 여백은 오른쪽 위 「한 쪽 · 이어 보기」 단추에 첫 쪽이 가리지 않을 만큼
const FLOW_PAD = 56, FLOW_SIDE = 40, FLOW_GAP = 28;

/** 모든 쪽을 세로로 늘어놓는다. 스크롤해서 화면 가운데에 온 쪽이 지금 쪽이 되고, 쪽 목록 · 방향키로 지금 쪽을 바꾸면 그 쪽으로 스크롤한다.
 *  쪽은 화면 언저리에 올 때만 띄운다(ThumbFrame 과 같은 까닭 — 큰 덱에서 iframe 수십 개를 한꺼번에 띄우면 웹뷰가 멈춘다).
 *  누르면 그 쪽이 지금 쪽, 두 번 누르면 한 쪽 보기로 그 쪽을 크게 연다. 핀 · 편집은 한 쪽 보기에서 한다 */
function Flow({ deck, revHash }: { deck: Deck; revHash?: string }) {
	const t = useT();
	const current = useDeck((s) => s.current);
	const setCurrent = useDeck((s) => s.setCurrent);
	const setFlow = useDeck((s) => s.setFlow);
	const rev = useDeck((s) => s.rev);
	const pins = useDeck((s) => s.pins);
	const ref = useRef<HTMLDivElement>(null);
	const [box, setBox] = useState({ w: 0, h: 0 });
	// 스크롤이 바꾼 지금 쪽이면 다시 스크롤하지 않는다 — 안 그러면 스크롤과 맞춤이 서로를 끌어당긴다
	const fromScroll = useRef(false);
	const first = useRef(true);
	// 앱이 지금 쪽으로 스크롤해 가는 중이면 그 목적지(px). 가는 길에 지나는 쪽을 지금 쪽으로 잡지 않는다 — 안 그러면 중간 쪽에서 멈춘다.
	// 사용자가 도중에 휠을 굴리면 목적지에 닿지 않으므로 잠시 뒤 놓아준다
	const aim = useRef<{ y: number; until: number } | null>(null);
	useLayoutEffect(() => {
		const el = ref.current!;
		const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const width = Math.max(160, Math.min(box.w - FLOW_SIDE * 2, deck.size.w));
	const height = (width * deck.size.h) / deck.size.w;
	const step = height + FLOW_GAP;
	const topOf = (i: number) => FLOW_PAD + i * step;

	useEffect(() => {
		const el = ref.current;
		if (!el || !box.w) return;
		if (fromScroll.current) { fromScroll.current = false; return; }
		const y = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, topOf(current) - Math.max(FLOW_PAD, (el.clientHeight - height) / 2)));
		if (Math.abs(el.scrollTop - y) < 2) return;
		aim.current = { y, until: performance.now() + 1500 };
		el.scrollTo({ top: y, behavior: first.current ? "auto" : "smooth" });
		first.current = false;
	}, [current, box.w, height]);

	const onScroll = () => {
		const el = ref.current!;
		if (aim.current) {
			if (Math.abs(el.scrollTop - aim.current.y) >= 2 && performance.now() < aim.current.until) return;
			aim.current = null;
		}
		const mid = el.scrollTop + el.clientHeight / 2;
		const i = Math.max(0, Math.min(deck.slides.length - 1, Math.floor((mid - FLOW_PAD + FLOW_GAP / 2) / step)));
		if (i !== useDeck.getState().current) { fromScroll.current = true; setCurrent(i); }
	};

	return (
		<div className="flow" ref={ref} onScroll={onScroll}>
			{box.w > 0 && (
				<div style={{ position: "relative", height: topOf(deck.slides.length) - FLOW_GAP + FLOW_PAD }}>
					{deck.slides.map((sl, i) => {
						const n = pins.filter((p) => p.slide === sl.id).length;
						return (
							<div key={sl.id} className={"flow-item" + (i === current ? " on" : "")} style={{ top: topOf(i), left: (box.w - width) / 2, width, height }}
								onClick={() => setCurrent(i)} onDoubleClick={() => { setCurrent(i); setFlow(false); }}
								onContextMenu={(e) => {
									setCurrent(i);
									if (revHash) return openMenu(e, previewItems(t));
									openMenu(e, [{ label: t("openSingle"), run: () => setFlow(false) }, "-", ...slideItems(i, deck.slides.length, t)]);
								}}>
								<span className="flow-no mono">{i + 1}{n > 0 && <i title={`${t("pins")} ${n}`} />}</span>
								<FlowFrame file={sl.file} rev={rev[sl.id] || 0} w={deck.size.w} h={deck.size.h} width={width} revHash={revHash} />
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

function FlowFrame(p: { file: string; rev: number; w: number; h: number; width: number; revHash?: string }) {
	const ref = useRef<HTMLDivElement>(null);
	const [near, setNear] = useState(false);
	useLayoutEffect(() => {
		const el = ref.current!;
		const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root: el.closest(".flow"), rootMargin: "100% 0px" });
		io.observe(el);
		return () => io.disconnect();
	}, []);
	// 쪽 위의 덮개 — 누름 · 두 번 누름을 iframe 이 삼키지 않게 한다. 휠은 덮개를 지나 스크롤 상자로 간다
	return <div ref={ref} className="flow-sheet">{near && <SlideFrame {...p} />}<div className="flow-cover" /></div>;
}

function PinMark({ pin, n, scale, flip, open, onOpen, onClose }: { pin: Pin; n: number; scale: number; flip: boolean; open: boolean; onOpen: () => void; onClose: () => void }) {
	const t = useT();
	const update = useDeck((s) => s.updatePin);
	const remove = useDeck((s) => s.removePin);
	const [text, setText] = useState(pin.text);
	useEffect(() => setText(pin.text), [pin.text]);
	const commit = () => { if (text !== pin.text) update(pin.id, text); };
	return (
		<div className={"pinmark" + (pin.text ? "" : " draft")} style={{ left: pin.x * scale, top: pin.y * scale }} onClick={(e) => e.stopPropagation()}>
			<button className="dot" onClick={onOpen} aria-label={`${t("pin")} ${n}`}><span>{n}</span></button>
			{open && (
				<div className="pin-note" style={flip ? { left: "auto", right: 16 } : undefined}>
					<textarea autoFocus value={text} placeholder={t("pinPlaceholder")} onChange={(e) => setText(e.target.value)} onBlur={commit}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); onClose(); }
							if (e.key === "Escape") { e.stopPropagation(); commit(); onClose(); }
						}} />
					<div className="row">
						<span className="mono">{pin.target ? `<${pin.target.tag}>` : ""} {Math.round(pin.x)},{Math.round(pin.y)}</span>
						<button onClick={() => { remove(pin.id); onClose(); }}>{t("delete")}</button>
					</div>
				</div>
			)}
		</div>
	);
}

// ── 판 줄기 ──
function Track() {
	const t = useT();
	const versions = useDeck((s) => s.versions);
	const preview = useDeck((s) => s.preview);
	const setPreview = useDeck((s) => s.setPreview);
	const restore = useDeck((s) => s.restore);
	const running = useDeck((s) => s.running);
	const [hover, setHover] = useState<{ c: Commit; x: number } | null>(null);
	const list = useMemo(() => [...versions].reverse(), [versions]);
	const head = versions[0];
	const rels = versions.filter((c) => c.tags.some((x) => /^r\d+$/.test(x))).length;
	const ref = useRef<HTMLDivElement>(null);
	return (
		<div className="track" ref={ref} aria-label={t("versions")}>
			<div className="axis" />
			<div className="label">{head ? <><b>v{head.n}</b>{rels ? ` · ${t("releases")} ${rels}` : ""}</> : t("versions")}</div>
			<div className="ticks" role="list">
				{list.map((c) => {
					const rel = c.tags.find((x) => /^r\d+$/.test(x));
					return (
						<button key={c.hash} role="listitem" className={"tick" + (rel ? " rel" : "") + (c === head ? " head" : "") + (preview?.hash === c.hash ? " sel" : "")}
							aria-label={`v${c.n} ${c.subject}`}
							onMouseEnter={(e) => { const r = ref.current!.getBoundingClientRect(), b = e.currentTarget.getBoundingClientRect(); setHover({ c, x: b.left + b.width / 2 - r.left }); }}
							onMouseLeave={() => setHover(null)}
							onClick={() => setPreview(preview?.hash === c.hash ? null : c)}
							onContextMenu={(e) => openMenu(e, [
								{ label: `v${c.n} ${t("viewVersion")}`, run: () => setPreview(c), disabled: c === head },
								{ label: t("restore"), run: () => restore(c), disabled: c === head || !!running },
							])}>
							{rel && <span>{rel}</span>}
						</button>
					);
				})}
			</div>
			{hover && (
				<div className="hover" style={{ left: Math.max(120, hover.x) }}>
					<span className="mono" style={{ color: "var(--accent)" }}>v{hover.c.n}</span> {hover.c.subject} <span className="dim mono">{hover.c.date.slice(5)}</span>
				</div>
			)}
		</div>
	);
}
