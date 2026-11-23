// 스케치 — 무대 위에 손으로 배치를 그려 Claude 에게 보낸다.
// 펜 · 화살표 · 범위 표시는 「표시 하나 = 의견 하나」라 여러 획으로 된 배치(여기 제목, 이쪽에 카드 셋)를 전하기 어렵다.
// 스케치는 획 여럿이 그림 한 장이다 — 보낼 때 그림으로 구워 첨부하고, 무엇을 바라는지(이 쪽 다시 잡기 · 새 쪽 · 의견)를 함께 말한다.
//
// 목차
//   Stroke · board 상태    쪽마다 그리던 스케치를 도구를 바꿔도 남긴다 (앱을 끄면 사라진다)
//   SketchBoard            그리기 층 · 글자 칸 · 아래 띠(도구 · 바탕 · 바람 · 메모 · 보내기)
//   bake                   스케치를 PNG 로 굽는다 — 「쪽 위」면 지금 쪽 그림 위에, 「빈 종이」면 흰 바탕에
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { ask, offscreen } from "../lib/frames";
import { useT } from "../lib/i18n";
import { shapePath } from "../lib/markup";
import { useDeck } from "../lib/store";

type Pen = "pen" | "line" | "box" | "text" | "erase";
/** pts 는 슬라이드 1:1 픽셀. 펜은 지난 길, 선 · 상자는 두 점, 글자는 한 점 */
interface Stroke { kind: Exclude<Pen, "erase">; pts: number[]; text?: string }
type Intent = "relayout" | "newSlide" | "comment";
interface Board { bg: "slide" | "paper"; strokes: Stroke[]; note: string; intent: Intent }

/** 스케치 잉크 — 표시(빨강)와 섞이지 않게 파랑. 빈 종이 · 쪽 위 어디서나 잘 보인다 */
const INK = "#2563eb";
const TEXT_PX = 28;
const boards = new Map<string, Board>();
const fresh = (): Board => ({ bg: "slide", strokes: [], note: "", intent: "relayout" });

function strokePath(s: Stroke): string {
	const p = s.pts;
	if (s.kind === "pen") return shapePath({ kind: "pen", pts: p });
	if (s.kind === "line") return `M${p[0]} ${p[1]}L${p[2]} ${p[3]}`;
	if (s.kind === "box") return `M${p[0]} ${p[1]}H${p[2]}V${p[3]}H${p[0]}Z`;
	return "";
}
const tiny = (s: Stroke) => {
	if (s.kind === "text") return !s.text?.trim();
	const xs = s.pts.filter((_, i) => i % 2 === 0), ys = s.pts.filter((_, i) => i % 2 === 1);
	return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < 4;
};

/** room — 쪽 아래 남은 높이(px). 띠가 들어가면 쪽 밖 아래에 두어 그림을 가리지 않는다 */
export function SketchBoard({ slideId, w, h, scale, room = 0 }: { slideId: string; w: number; h: number; scale: number; room?: number }) {
	const t = useT();
	const [b, setB] = useState<Board>(() => boards.get(slideId) || fresh());
	const [pen, setPen] = useState<Pen>("pen");
	const [draft, setDraft] = useState<Stroke | null>(null);
	const [typing, setTyping] = useState<{ x: number; y: number } | null>(null);
	const [busy, setBusy] = useState(false);
	const running = useDeck((s) => !!s.running);
	const put = (p: Partial<Board>) => setB((x) => { const n = { ...x, ...p }; boards.set(slideId, n); return n; });
	useEffect(() => { setB(boards.get(slideId) || fresh()); setTyping(null); }, [slideId]);

	// Ctrl+Z 는 마지막 획 지우기 — 글자 칸 안에서는 그 칸의 되돌리기
	useEffect(() => {
		const k = (e: KeyboardEvent) => {
			if ((e.target as Element).closest?.("input, textarea, [contenteditable]")) return;
			if (e.ctrlKey && e.key.toLowerCase() === "z") { e.preventDefault(); e.stopImmediatePropagation(); setB((x) => { const n = { ...x, strokes: x.strokes.slice(0, -1) }; boards.set(slideId, n); return n; }); }
		};
		addEventListener("keydown", k, true);
		return () => removeEventListener("keydown", k, true);
	}, [slideId]);

	const at = (e: React.PointerEvent) => {
		const r = (e.currentTarget as Element).getBoundingClientRect();
		return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale];
	};
	const commitText = (text: string) => {
		if (typing && text.trim()) put({ strokes: [...b.strokes, { kind: "text", pts: [typing.x, typing.y], text: text.trim() }] });
		setTyping(null);
	};

	const send = async () => {
		const st = useDeck.getState();
		if (!b.strokes.length || st.running || busy) return;
		setBusy(true);
		try {
			const rel = await bake(st.dir, st.id, slideId, b, w, h);
			const no = (st.deck?.slides.findIndex((s) => s.id === slideId) ?? 0) + 1;
			const ask = { relayout: t("sketchAskRelayout"), newSlide: t("sketchAskNew"), comment: t("sketchAskComment") }[b.intent].replace("{n}", String(no));
			const text = `@${no} ${ask}${b.note.trim() ? "\n" + b.note.trim() : ""}`;
			boards.delete(slideId);
			setB(fresh());
			st.setTool("select");
			await st.send(text, [rel]);
		} catch (e) {
			useDeck.getState().notify(String(e), "err");
		} finally {
			setBusy(false);
		}
	};

	const pens: { k: Pen; label: string; icon: React.ReactNode }[] = [
		{ k: "pen", label: t("sketchPen"), icon: <path d="M2.5 11.5c2-4 3.5-6 5-6s.5 4 2 4 2-3 4-6" /> },
		{ k: "line", label: t("sketchLine"), icon: <path d="M3 13L13 3" /> },
		{ k: "box", label: t("sketchBox"), icon: <rect x="2.5" y="4" width="11" height="8" rx="1" /> },
		{ k: "text", label: t("sketchText"), icon: <path d="M3.5 4h9M8 4v9" /> },
		{ k: "erase", label: t("sketchErase"), icon: <path d="M6 13h7M3 10l5-6 5 4-4 5H6z" /> },
	];

	return (
		<div className={"sketch" + (b.bg === "paper" ? " paper" : "")}>
			<svg className="sketch-ink" data-pen={pen} width={w * scale} height={h * scale} viewBox={`0 0 ${w} ${h}`}
				onPointerDown={(e) => {
					if (e.button !== 0 || pen === "erase") return;
					if (typing) return;
					const [x, y] = at(e);
					if (pen === "text") { e.preventDefault(); setTyping({ x, y }); return; }
					e.currentTarget.setPointerCapture(e.pointerId);
					setDraft({ kind: pen, pts: pen === "pen" ? [x, y] : [x, y, x, y] });
				}}
				onPointerMove={draft ? (e) => {
					const [x, y] = at(e);
					const p = draft.pts;
					if (draft.kind === "pen") { if (Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) > 2 / scale) setDraft({ ...draft, pts: [...p, x, y] }); }
					else setDraft({ ...draft, pts: [p[0], p[1], x, y] });
				} : undefined}
				onPointerUp={draft ? () => { if (!tiny(draft)) put({ strokes: [...b.strokes, draft] }); setDraft(null); } : undefined}
				onPointerCancel={() => setDraft(null)}>
				{b.strokes.map((s, i) => (
					<g key={i} className="stroke" onPointerDown={pen === "erase" ? (e) => { e.stopPropagation(); put({ strokes: b.strokes.filter((_, j) => j !== i) }); } : undefined}>
						{s.kind === "text"
							? <text x={s.pts[0]} y={s.pts[1]} fill={INK} fontSize={TEXT_PX} dominantBaseline="middle">{s.text}</text>
							: <><path className="hit" d={strokePath(s)} /><path d={strokePath(s)} stroke={INK} /></>}
					</g>
				))}
				{draft && !tiny(draft) && <path d={strokePath(draft)} stroke={INK} className="live" />}
			</svg>
			{typing && (
				<input className="sketch-type" autoFocus placeholder={t("sketchTypeHint")}
					style={{ left: typing.x * scale, top: typing.y * scale, fontSize: TEXT_PX * scale }}
					onKeyDown={(e) => { if (e.key === "Enter") commitText(e.currentTarget.value); if (e.key === "Escape") { e.stopPropagation(); setTyping(null); } }}
					onBlur={(e) => commitText(e.currentTarget.value)} />
			)}
			<div className={"sketch-bar" + (room >= 104 ? " below" : "")} role="toolbar" aria-label={t("sketch")}>
				<div className="row">
					{pens.map((x) => (
						<button key={x.k} aria-pressed={pen === x.k} onClick={() => setPen(x.k)} title={x.label} aria-label={x.label}>
							<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>{x.icon}</svg>
						</button>
					))}
					<i />
					<button onClick={() => put({ strokes: b.strokes.slice(0, -1) })} disabled={!b.strokes.length} title={`${t("sketchUndo")} (Ctrl+Z)`} aria-label={t("sketchUndo")}>
						<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M5 3L2 6l3 3M2.5 6H10a3.5 3.5 0 010 7H6" /></svg>
					</button>
					<button className="txt" onClick={() => put({ strokes: [] })} disabled={!b.strokes.length}>{t("sketchClear")}</button>
					<i />
					<div className="seg">
						<button aria-pressed={b.bg === "slide"} onClick={() => put({ bg: "slide" })}>{t("sketchOnSlide")}</button>
						<button aria-pressed={b.bg === "paper"} onClick={() => put({ bg: "paper" })}>{t("sketchPaper")}</button>
					</div>
				</div>
				<div className="row">
					<div className="seg">
						{(["relayout", "newSlide", "comment"] as Intent[]).map((k) => (
							<button key={k} aria-pressed={b.intent === k} onClick={() => put({ intent: k })}>{t(k === "relayout" ? "sketchRelayout" : k === "newSlide" ? "sketchNew" : "sketchComment")}</button>
						))}
					</div>
					<input className="field" placeholder={t("sketchNote")} value={b.note} onChange={(e) => put({ note: e.target.value })}
						onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) send(); }} />
					<button className="send" disabled={!b.strokes.length || running || busy} onClick={send} title={running ? t("working") : undefined}>{t("sketchSend")}</button>
				</div>
			</div>
		</div>
	);
}

/** 스케치를 1:1 크기 PNG 로 구워 .claudeppt/attach 에 두고 상대 경로를 돌려준다 */
async function bake(dir: string, id: string, slideId: string, b: Board, w: number, h: number): Promise<string> {
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	const g = c.getContext("2d")!;
	g.fillStyle = "#ffffff";
	g.fillRect(0, 0, w, h);
	if (b.bg === "slide") {
		const ref = useDeck.getState().deck?.slides.find((s) => s.id === slideId);
		if (ref) {
			const { win, dispose } = await offscreen(id, ref.file, w, h);
			let snap: any;
			try { snap = await ask(win, { t: "snapshot", scale: 1 }, 60000); } finally { dispose(); }
			if (!snap.error) {
				const img = new Image();
				img.src = snap.data;
				await img.decode();
				g.drawImage(img, 0, 0, w, h);
				// 쪽을 옅게 덮어 잉크가 먼저 읽히게 한다 — 무엇이 지금 있고 무엇을 그렸는지 Claude 가 가른다
				g.fillStyle = "rgba(255,255,255,0.45)";
				g.fillRect(0, 0, w, h);
			}
		}
	}
	g.strokeStyle = g.fillStyle = INK;
	g.lineWidth = 4;
	g.lineCap = g.lineJoin = "round";
	g.font = `600 ${TEXT_PX}px "Pretendard Variable", Pretendard, "Malgun Gothic", sans-serif`;
	g.textBaseline = "middle";
	for (const s of b.strokes) {
		if (s.kind === "text") g.fillText(s.text || "", s.pts[0], s.pts[1]);
		else g.stroke(new Path2D(strokePath(s)));
	}
	const rel = `.claudeppt/attach/sketch-${slideId}-${Date.now().toString(36)}.png`;
	await api.writeB64(dir, rel, c.toDataURL("image/png").split(",")[1]);
	return rel;
}
