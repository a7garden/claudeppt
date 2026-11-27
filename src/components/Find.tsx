// 찾기 · 바꾸기 — PowerPoint 「찾기」(Ctrl+F) · 「바꾸기」(Ctrl+H) (2026.11.27)
// 모든 쪽의 글자만 본다(태그 · 속성 · 메모는 보지 않는다). 찾은 글자는 지금 쪽 안에 칠해 보인다 (rt.js find, CSS 강조 표시라 원본은 건드리지 않는다).
// 바꾸기는 쪽 파일을 바로 고쳐 쓰고 쪽마다 되돌리기 한 걸음을 남긴다 (store replaceText)
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { tell } from "../lib/frames";
import { useT } from "../lib/i18n";
import { useDeck } from "../lib/store";

type Mode = "find" | "replace" | "link";
export const useFind = create<{ open: Mode | null; show: (m: Mode) => void; close: () => void }>()((set) => ({
	open: null,
	show: (open) => set({ open }),
	close: () => set({ open: null }),
}));

export function FindBar({ win }: { win: React.MutableRefObject<Window | null> }) {
	const t = useT();
	const open = useFind((s) => s.open);
	const close = useFind((s) => s.close);
	const deck = useDeck((s) => s.deck);
	const current = useDeck((s) => s.current);
	const rev = useDeck((s) => s.rev);
	const findText = useDeck((s) => s.findText);
	const replaceText = useDeck((s) => s.replaceText);
	const [q, setQ] = useState("");
	const [to, setTo] = useState("");
	const [cs, setCs] = useState(false);
	const [counts, setCounts] = useState<number[]>([]);
	const [done, setDone] = useState<string | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const slide = deck?.slides[current];
	const revKey = deck?.slides.map((s) => rev[s.id] || 0).join(",");

	useEffect(() => { if (open) requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); }); }, [open]);
	// 쪽마다 찾은 수 — 칠 때마다 다시 세되 잠깐 기다렸다가 (쪽 파일을 모두 읽는다)
	useEffect(() => {
		if (!open) return;
		const h = setTimeout(() => { void findText(q, cs).then(setCounts); }, 180);
		return () => clearTimeout(h);
	}, [open, q, cs, revKey, deck?.slides.length]);
	// 지금 쪽 안 칠하기 — 쪽을 넘기거나 다시 그리면 창이 새로 떠서 다시 보낸다
	useEffect(() => {
		const send = () => tell(win.current, { t: "find", q: open === "find" || open === "replace" ? q : "", cs });
		send();
		const a = setTimeout(send, 300), b = setTimeout(send, 900);
		return () => { clearTimeout(a); clearTimeout(b); };
	}, [open, q, cs, slide?.id, slide ? rev[slide.id] : 0]);
	if (open === "link") return <LinkBar win={win} />;
	if (!open || !deck) return null;
	const total = counts.reduce((a, b) => a + b, 0);
	const pages = counts.filter(Boolean).length;
	/** 다음(앞) 찾은 쪽으로 — 끝에 닿으면 처음으로 돌아간다 */
	const next = (d: 1 | -1) => {
		const n = counts.length;
		for (let k = 1; k <= n; k++) {
			const i = (current + d * k + n * 2) % n;
			if (counts[i]) return useDeck.getState().setCurrent(i);
		}
	};
	const replace = async (all: boolean) => {
		if (!q) return;
		const n = await replaceText(q, to, cs, all || !slide ? undefined : [slide.id]);
		setDone(t("replaced").replace("{n}", String(n)));
		setCounts(await findText(q, cs));
		if (!all && n === 0) next(1);
	};
	return (
		<div className="findbar" role="search" aria-label={t("find")} onKeyDown={(e) => {
			if (e.key === "Escape") { close(); e.stopPropagation(); }
			// 찾기 칸에 커서가 있어도 넘김 키 · 도구 키가 무대로 가지 않게
			e.stopPropagation();
		}}>
			<div className="row">
				<input ref={input} value={q} placeholder={t("findWhat")} aria-label={t("findWhat")} spellCheck={false}
					onChange={(e) => { setQ(e.target.value); setDone(null); }}
					onKeyDown={(e) => { if (e.key === "Enter") { next(e.shiftKey ? -1 : 1); e.preventDefault(); } }} />
				<button onClick={() => next(-1)} disabled={!total} title={`${t("findPrev")} (Shift+Enter)`} aria-label={t("findPrev")}>↑</button>
				<button onClick={() => next(1)} disabled={!total} title={`${t("findNext")} (Enter)`} aria-label={t("findNext")}>↓</button>
				<button onClick={close} title={`${t("close")} (Esc)`} aria-label={t("close")}>×</button>
			</div>
			{open === "replace" && (
				<div className="row">
					<input value={to} placeholder={t("replaceWith")} aria-label={t("replaceWith")} spellCheck={false} onChange={(e) => setTo(e.target.value)}
						onKeyDown={(e) => { if (e.key === "Enter") { void replace(e.ctrlKey); e.preventDefault(); } }} />
					<button className="wide" onClick={() => void replace(false)} disabled={!counts[current]} title={t("replaceHereHint")}>{t("replaceHere")}</button>
					<button className="wide" onClick={() => void replace(true)} disabled={!total} title="Ctrl+Enter">{t("replaceAll")}</button>
				</div>
			)}
			<div className="row meta">
				<label><input type="checkbox" checked={cs} onChange={(e) => setCs(e.target.checked)} />{t("matchCase")}</label>
				<span className="grow" />
				{open === "find" && <button className="link" onClick={() => useFind.getState().show("replace")}>{t("replace")}</button>}
				<span className="dim" role="status">{done ?? (q ? (total ? t("foundN").replace("{n}", String(total)).replace("{p}", String(pages)) : t("foundNone")) : "")}</span>
			</div>
		</div>
	);
}

/** 하이퍼링크 (Ctrl+K) — 고른 글자(고치다 골라 둔 글자)에, 없으면 고른 글 전체에 건다. 비우고 Enter 면 걷는다.
 *  내보내면 PowerPoint 글 하이퍼링크가 된다 (rt.js runsOf link) */
function LinkBar({ win }: { win: React.MutableRefObject<Window | null> }) {
	const t = useT();
	const close = useFind((s) => s.close);
	const [url, setUrl] = useState("");
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => { requestAnimationFrame(() => input.current?.focus()); }, []);
	const apply = () => {
		const v = url.trim();
		// 주소 꼴이 아니면 웹 주소로 본다 (example.com → https://example.com). 메일 · 쪽 안 이동은 그대로
		const href = !v ? "" : /^(https?:|mailto:|#)/i.test(v) ? v : "https://" + v;
		tell(win.current, { t: "cmd", cmd: "link", v: href });
		close();
	};
	return (
		<div className="findbar" role="dialog" aria-label={t("linkInsert")} onKeyDown={(e) => { if (e.key === "Escape") close(); e.stopPropagation(); }}>
			<div className="row">
				<input ref={input} value={url} placeholder={t("linkUrl")} aria-label={t("linkInsert")} spellCheck={false} onChange={(e) => setUrl(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Enter") { apply(); e.preventDefault(); } }} />
				<button className="wide" onClick={apply}>{t("linkInsert")}</button>
				<button onClick={close} title={`${t("close")} (Esc)`} aria-label={t("close")}>×</button>
			</div>
			<div className="row meta"><span className="dim">{t("linkHint")}</span></div>
		</div>
	);
}
