// 작업 화면 — 왼쪽 쪽 목록 · 가운데 무대(슬라이드 + 핀 + 판 줄기) · 오른쪽 대화.
//
// 목차
//   SlideFrame    슬라이드 iframe 하나. 크기를 맞춰 줄이고, 다시 그릴 표식(rev)이 바뀌면 새로 읽는다
//   Rail          쪽 목록 — 끌어서 순서 바꾸기 · Delete 로 빼기 · 끝의 + 로 빈 쪽
//   Stage         무대 — 핀 찍기 · 직접 편집 메시지 받기 · 지난 판 미리 보기
//   Track         판 줄기 — 판마다 눈금, 릴리즈는 긴 눈금
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type Commit, deckUrl } from "../lib/api";
import { type Deck, newId, slideHtml } from "../lib/deck";
import { ask, onFrame } from "../lib/frames";
import { openAny } from "../lib/flows";
import { useT } from "../lib/i18n";
import { useSettings } from "../lib/settings";
import { type Pin, useDeck } from "../lib/store";
import { useFileDrop } from "./Home";
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
			else if (e.key === "ArrowDown" || e.key === "PageDown" || (e.key === "ArrowRight" && useDeck.getState().mode !== "edit")) setCurrent(useDeck.getState().current + 1);
			else if (e.key === "ArrowUp" || e.key === "PageUp" || (e.key === "ArrowLeft" && useDeck.getState().mode !== "edit")) setCurrent(useDeck.getState().current - 1);
			else if (e.key === "Escape") setMode("view");
			else return;
			e.preventDefault();
		};
		addEventListener("keydown", k);
		return () => removeEventListener("keydown", k);
	}, [setMode, setCurrent]);
	return (
		<main className="work">
			<Rail />
			<Stage />
			<Talk />
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
	const saveDeck = useDeck((s) => s.saveDeck);
	const dir = useDeck((s) => s.dir);
	const [drag, setDrag] = useState<number | null>(null);
	const [dropAt, setDropAt] = useState<number | null>(null);
	const lastFiles = useMemo(() => new Set(turns[turns.length - 1]?.tools.map((x) => x.file).filter(Boolean)), [turns]);
	const listRef = useRef<HTMLDivElement>(null);
	useEffect(() => { listRef.current?.querySelectorAll(".rail-item")[current]?.scrollIntoView({ block: "nearest" }); }, [current]);

	const move = (from: number, to: number) => {
		if (from === to || from + 1 === to) return;
		const s = [...live.slides];
		const [x] = s.splice(from, 1);
		s.splice(to > from ? to - 1 : to, 0, x);
		saveDeck({ ...live, slides: s });
		setCurrent(to > from ? to - 1 : to);
	};
	const add = async () => {
		const id = newId();
		await api.writeText(dir, `slides/${id}.html`, slideHtml(`<section class="slide"></section>`, useSettings.getState().s.lang));
		const s = [...live.slides];
		s.splice(current + 1, 0, { id, file: `slides/${id}.html` });
		await saveDeck({ ...live, slides: s });
		setCurrent(current + 1);
	};

	return (
		<nav className="rail" ref={listRef} aria-label={t("slides")}
			onKeyDown={(e) => {
				if (e.key === "Delete" && !preview && live.slides.length > 1) {
					saveDeck({ ...live, slides: live.slides.filter((_, i) => i !== current) });
					setCurrent(Math.min(current, live.slides.length - 2));
				}
			}}>
			{deck.slides.map((sl, i) => {
				const n = pins.filter((p) => p.slide === sl.id).length;
				return (
					<div key={sl.id} className={"rail-item" + (i === current ? " on" : "") + (dropAt === i ? " drop-before" : "")}
						onDragOver={(e) => { if (drag != null) { e.preventDefault(); setDropAt(i); } }}
						onDrop={() => { if (drag != null) move(drag, i); setDrag(null); setDropAt(null); }}>
						<div className="no">
							<span>{i + 1}</span>
							{n > 0 && <span className="pins" title={`${t("pins")} ${n}`} />}
							{lastFiles.has(sl.file) && !preview && <span className="fresh" title={t("changed")} />}
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

function ThumbFrame(p: { file: string; rev: number; w: number; h: number; revHash?: string }) {
	const ref = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const el = ref.current!;
		const ro = new ResizeObserver(() => setWidth(el.clientWidth));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	return <div ref={ref} style={{ position: "absolute", inset: 0 }}>{width > 0 && <SlideFrame {...p} width={width} />}</div>;
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
		if (src !== win.current || !slide || preview) return;
		if (m.t === "edit") applyDirect(slide.id, m.path, { t: "edit", html: m.html });
		else if (m.t === "patch") applyDirect(slide.id, m.path, { t: "patch", style: m.style });
		else if (m.t === "remove") applyDirect(slide.id, m.path, { t: "remove" });
	}), [slide?.id, preview]);

	const onPin = async (e: React.MouseEvent) => {
		if (mode !== "pin" || preview || !slide || (e.target as Element).closest(".pinmark")) return;
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const x = (e.clientX - r.left) / scale, y = (e.clientY - r.top) / scale;
		let target: Pin["target"];
		try {
			if (win.current) {
				const hit: any = await ask(win.current, { t: "hit", x, y }, 1500);
				target = { tag: hit.tag, text: hit.text, path: hit.path };
			}
		} catch {}
		setActive(addPin({ slide: slide.id, x, y, text: "", target }));
	};

	if (!slide) return <section className="stage" />;
	const mine = pins.filter((p) => p.slide === slide.id);
	const order = pins.map((p) => p.id);

	return (
		<section className="stage" data-mode={preview ? "view" : mode} aria-label={t("slides")}>
			<div className="stage-banner">
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
			<div className="canvas" ref={canvas}>
				{box.w > 0 && (
					<div className="sheet" style={{ left, top, width: deck.size.w * scale, height: deck.size.h * scale }}>
						<div style={{ width: deck.size.w * scale, height: deck.size.h * scale, overflow: "hidden", position: "relative" }}>
							<div style={{ position: "absolute", left: 0, top: 0 }}>
								<SlideFrame key={slide.id + (preview?.hash || "")} file={slide.file} rev={rev[slide.id] || 0} w={deck.size.w} h={deck.size.h} width={deck.size.w * scale} revHash={preview?.hash} onWin={(w) => { win.current = w; }} />
							</div>
						</div>
						{!preview && (
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
							onClick={() => setPreview(preview?.hash === c.hash ? null : c)}>
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
