// 판 비교 렌즈 — 무대 위에서 고른 판(가름선 왼쪽)과 지금(오른쪽)을 같은 자리 · 같은 크기로 겹쳐 본다. 슬라이드를 끌면 가름선이 따라온다.
// 두 쪽 모두 웹이 그린 슬라이드다 — 지난 판은 deck://<id>@<커밋>/ 에서 읽는다. 바뀐 픽셀은 빨갛게 덧칠한다 (versions.ts slideMask).
// 2026.11.24 : PowerPoint 대조 렌즈(CompareLens)를 걷고 이것으로 바꿨다. 어느 쪽이 무엇인지 헷갈리지 않게 이름표를 띠와 슬라이드 위에 크게 단다.
import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import { useDeck } from "../lib/store";
import { slideMask } from "../lib/versions";
import { SlideFrame } from "./Workspace";

export function VersionLens({ slideId, w, h, scale }: { slideId: string; w: number; h: number; scale: number }) {
	const t = useT();
	const id = useDeck((s) => s.id);
	const vdiff = useDeck((s) => s.vdiff)!;
	const showMask = useDeck((s) => s.vdiffMask);
	const rev = useDeck((s) => s.rev[slideId] || 0);
	const [split, setSplit] = useState(0.5);
	const [drag, setDrag] = useState(false);
	const [mask, setMask] = useState<{ k: string; src: string } | null>(null);
	const state = vdiff.slides[slideId];
	const past = vdiff.past.slides.find((s) => s.id === slideId);
	const key = `${vdiff.base.hash}|${slideId}|${rev}`;
	// 바뀐 곳은 이 쪽을 볼 때만 굽는다 — 두 판을 1:1 로 구워 견주므로 쪽마다 1초쯤 든다
	useEffect(() => {
		if (!showMask || state !== "changed" || !past || mask?.k === key) return;
		let live = true;
		slideMask(id, past.file, vdiff.base.hash, w, h).then((r) => { if (live) setMask({ k: key, src: r.mask }); }, () => {});
		return () => { live = false; };
	}, [key, showMask, state]);
	const move = (e: React.PointerEvent) => {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		setSplit(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
	};
	const name = `v${vdiff.base.n}`;
	if (!past) {
		// 고른 판 뒤에 생긴 쪽 — 견줄 것이 없다
		return (
			<div className="lens" style={{ width: w * scale, height: h * scale, cursor: "default" }}>
				<span className="lens-tag l">{t("vsNotInBase").replace("{v}", name)}</span>
				<span className="lens-tag r now">{t("vsNow")}</span>
			</div>
		);
	}
	return (
		<div className="lens" style={{ width: w * scale, height: h * scale }}
			onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setDrag(true); move(e); }}
			onPointerMove={(e) => { if (drag) move(e); }}
			onPointerUp={() => setDrag(false)}
			role="slider" aria-label={`${name} · ${t("vsNow")}`} aria-valuenow={Math.round(split * 100)} tabIndex={0}
			onKeyDown={(e) => {
				if (e.key === "ArrowLeft") setSplit((v) => Math.max(0, v - 0.05));
				if (e.key === "ArrowRight") setSplit((v) => Math.min(1, v + 0.05));
			}}>
			{/* 지금은 무대가 이미 그리고 있다 — 그 위 가름선 왼쪽에만 지난 판을 덮는다 */}
			<div className="lens-past" style={{ clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` }}>
				<SlideFrame file={past.file} rev={0} revHash={vdiff.base.hash} w={w} h={h} width={w * scale} />
			</div>
			{showMask && mask?.k === key && <img className="lens-mask" src={mask.src} alt="" draggable={false} />}
			<div className="lens-line" style={{ left: `${split * 100}%` }} />
			<span className="lens-tag l">{name} · {vdiff.base.date.slice(5, 16)}</span>
			<span className="lens-tag r now">{t("vsNow")}</span>
		</div>
	);
}

/** 무대 위 띠 — 고른 판 · 바뀐 쪽 넘기기 · 바뀐 곳 표시 · 이 쪽만 되돌리기 · 판 언급 · 닫기. 빠진 쪽이 있으면 아래 줄에 되살리기 */
export function VersionBar({ slideId }: { slideId: string }) {
	const t = useT();
	const vdiff = useDeck((s) => s.vdiff)!;
	const versions = useDeck((s) => s.versions);
	const deck = useDeck((s) => s.deck)!;
	const current = useDeck((s) => s.current);
	const showMask = useDeck((s) => s.vdiffMask);
	const running = useDeck((s) => !!s.running || !!s.busy);
	const { startCompare, closeCompare, restoreSlide, mentionVersion, setCurrent } = useDeck.getState();
	const name = `v${vdiff.base.n}`;
	const state = vdiff.slides[slideId];
	const changed = deck.slides.map((s, i) => (vdiff.slides[s.id] ? i : -1)).filter((i) => i >= 0);
	const prev = [...changed].reverse().find((i) => i < current);
	const next = changed.find((i) => i > current);
	return (
		<>
			<div className="past vbar" role="status">
				<select value={vdiff.base.hash} onChange={(e) => { const c = versions.find((v) => v.hash === e.target.value); if (c) startCompare(c); }} aria-label={t("vsBase")} title={vdiff.base.subject}>
					{versions.slice(1).map((c) => <option key={c.hash} value={c.hash}>v{c.n} · {c.subject.slice(0, 40)}</option>)}
				</select>
				<span className="dim">↔ <b>{t("vsNow")}</b></span>
				<span>{t("vsChanged")} <b className="mono">{changed.length}</b>{vdiff.theme ? ` · ${t("vsTheme")}` : ""}</span>
				<span className="nav">
					<button onClick={() => prev != null && setCurrent(prev)} disabled={prev == null} aria-label={t("vsPrev")} title={t("vsPrev")}>◀</button>
					<button onClick={() => next != null && setCurrent(next)} disabled={next == null} aria-label={t("vsNext")} title={t("vsNext")}>▶</button>
				</span>
				{state === "changed" && <button onClick={() => useDeck.setState({ vdiffMask: !showMask })} aria-pressed={showMask}>{showMask ? "◼" : "◻"} {t("vsMarks")}</button>}
				<button className="primary" onClick={() => restoreSlide(slideId)} disabled={running || state !== "changed"}
					title={state === "added" ? t("vsNotInBase").replace("{v}", name) : !state ? t("vsSame") : ""}>
					{t("vsRestoreSlide").replace("{v}", name)}
				</button>
				<button onClick={() => mentionVersion(vdiff.base.n)} title={t("mentionVersionHint")}>@{name}</button>
				<button onClick={closeCompare} title="Esc">{t("close")}</button>
			</div>
			{vdiff.removed.length > 0 && (
				<div className="past vbar sub" role="status">
					<span className="dim">{t("vsRemoved").replace("{v}", name)}</span>
					{vdiff.removed.map((r) => (
						<button key={r.id} onClick={() => restoreSlide(r.id)} disabled={running} title={r.file}>↺ {r.title || `${r.at + 1}${t("slideN") === "쪽" ? "쪽" : ""}`}</button>
					))}
				</div>
			)}
		</>
	);
}
