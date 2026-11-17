// 비교 렌즈 — 무대 위에서 웹(아래)과 PowerPoint 가 그린 쪽(위)을 가름선으로 갈라 본다. 슬라이드를 끌면 가름선이 따라온다.
// 다른 픽셀은 빨갛게 덧칠한다. 같은 자리 · 같은 크기로 겹치므로 어긋난 곳이 바로 보인다.
import { useState } from "react";
import { deckUrl } from "../lib/api";
import type { SlideCheck } from "../lib/check";
import { useT } from "../lib/i18n";
import { useDeck } from "../lib/store";

export function CompareLens({ slide, w, h, scale }: { slide: SlideCheck; w: number; h: number; scale: number }) {
	const t = useT();
	const id = useDeck((s) => s.id);
	const at = useDeck((s) => s.report?.at);
	const [split, setSplit] = useState(0.5);
	const [drag, setDrag] = useState(false);
	const showMask = useDeck((s) => s.compareMask);
	const move = (e: React.PointerEvent) => {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		setSplit(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
	};
	const q = "?t=" + encodeURIComponent(at || "");
	return (
		<div className="lens" style={{ width: w * scale, height: h * scale }}
			onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setDrag(true); move(e); }}
			onPointerMove={(e) => { if (drag) move(e); }}
			onPointerUp={() => setDrag(false)}
			role="slider" aria-label={`${t("web")} · PPT`} aria-valuenow={Math.round(split * 100)} tabIndex={0}
			onKeyDown={(e) => {
				if (e.key === "ArrowLeft") setSplit((v) => Math.max(0, v - 0.05));
				if (e.key === "ArrowRight") setSplit((v) => Math.min(1, v + 0.05));
			}}>
			<img className="lens-ppt" src={deckUrl(id, slide.ppt) + q} alt="PPT" style={{ clipPath: `inset(0 0 0 ${split * 100}%)` }} draggable={false} />
			{showMask && <img className="lens-mask" src={deckUrl(id, slide.diff) + q} alt="" draggable={false} />}
			<div className="lens-line" style={{ left: `${split * 100}%` }} />
			<span className="lens-tag l">{t("web")}</span>
			<span className="lens-tag r">PPT</span>
		</div>
	);
}

/** 무대 위 띠 — 판 · 차이 비율 · 차이 표시 · 다시 비교 · 차이 고치기 */
export function CompareBar({ slide }: { slide: SlideCheck | undefined }) {
	const t = useT();
	const report = useDeck((s) => s.report)!;
	const head = useDeck((s) => s.versions[0]?.n ?? 0);
	const showMask = useDeck((s) => s.compareMask);
	const running = useDeck((s) => !!s.running || !!s.busy);
	const { check, fixDiff, setCompare } = useDeck.getState();
	const stale = report.version !== head;
	const total = report.slides.filter((x) => x.score > 0.05).length;
	return (
		<div className="past" role="status">
			<span className="mono">v{report.version}{stale ? " ≠ v" + head : ""}</span>
			<span>{t("diff")} <b className="mono">{slide ? slide.score.toFixed(2) : "—"}%</b></span>
			<button onClick={() => useDeck.setState({ compareMask: !showMask })} aria-pressed={showMask}>{showMask ? "◼" : "◻"} {t("diff")}</button>
			<button onClick={check} disabled={running}>{t("compare")}</button>
			{total > 0 && <button className="primary" onClick={fixDiff} disabled={running}>{t("fixDiff")} {total}</button>}
			<button onClick={() => setCompare(false)}>{t("close")}</button>
		</div>
	);
}
