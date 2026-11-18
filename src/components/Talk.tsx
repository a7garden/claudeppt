// 대화 — 턴마다 왼쪽 여백에 그 턴이 남긴 판(v<n>)을 찍는다. 대화 기록이 곧 판 이력이다.
// 아래 요청칸 위에 아직 보내지 않은 핀이 쌓이고, 보내기 한 번에 글과 핀이 함께 간다.
// 요청칸에서 @ 를 치면 쪽 고르기 창이 뜬다 — 「@3」 · 「@3-5」 로 고칠 쪽을 가리킨다 (mention.ts).
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api, b64FromBytes } from "../lib/api";
import { useT } from "../lib/i18n";
import { mentionCandidates, mentionTokens, mentionsIn, typingMention } from "../lib/mention";
import { SlideFrame } from "./Workspace";
import { type Turn, useDeck } from "../lib/store";

export default function Talk() {
	const t = useT();
	const turns = useDeck((s) => s.turns);
	const versions = useDeck((s) => s.versions);
	const setPreview = useDeck((s) => s.setPreview);
	const logRef = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	useEffect(() => {
		const el = logRef.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	}, [turns]);
	return (
		<aside className="talk" aria-label={t("talk")}>
			<div className="log" ref={logRef} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
				{turns.length === 0 ? (
					<div className="log-empty"><span>{t("talk")}</span><span className="mono" style={{ fontSize: 11 }}>{t("composerHint")}</span></div>
				) : (
					turns.map((x) => <TurnView key={x.id} turn={x} onVersion={() => { const c = versions.find((v) => v.hash === x.version?.hash); if (c) setPreview(c); }} />)
				)}
			</div>
			<Composer />
		</aside>
	);
}

function TurnView({ turn, onVersion }: { turn: Turn; onVersion: () => void }) {
	const t = useT();
	const files = useMemo(() => [...new Set(turn.tools.filter((x) => x.name === "Write" || x.name === "Edit" || x.name === "MultiEdit").map((x) => x.file).filter(Boolean))], [turn.tools]);
	const reads = turn.tools.filter((x) => x.name === "Read").length;
	return (
		<article className={"turn " + turn.status}>
			<div className="gutter">
				{turn.status === "running" ? <span className="run" aria-label={t("working")} /> : turn.version ? <button onClick={onVersion} title={turn.version.short}>v{turn.version.n}</button> : <span className="mono dim" style={{ fontSize: 11 }}>—</span>}
			</div>
			<div style={{ minWidth: 0 }}>
				{turn.request && <div className="req"><Mentioned text={turn.request} turn={turn} /></div>}
				{turn.pins.length > 0 && (
					<div className="req-pins">
						{turn.pins.map((p) => <div key={p.n}><i>{p.n}</i><span><span className="mono" style={{ fontSize: 11 }}>{p.slideNo}{t("slideN") === "쪽" ? "쪽" : ""} · </span>{p.text || "—"}</span></div>)}
					</div>
				)}
				{(turn.reply || turn.status === "running") && <div className="reply">{turn.reply}</div>}
				{turn.phase && <div className="meta">{turn.phase}</div>}
				{turn.error && <div className="err">{turn.error}</div>}
				{(files.length > 0 || turn.cost != null) && (
					<div className="files">
						{files.map((f) => <span key={f}>{f}</span>)}
						{reads > 0 && <span>read ×{reads}</span>}
						{turn.cost != null && <span>${turn.cost.toFixed(3)}</span>}
						{turn.status === "stopped" && <span>{t("stop")}</span>}
					</div>
				)}
			</div>
		</article>
	);
}

/** 요청 글의 @쪽 을 눌러 그 쪽으로 가는 칩으로 그린다. 지난 턴은 보낼 때 푼 쪽(id)을 따른다 — 그 뒤 순서가 바뀌어도 같은 쪽으로 간다 */
function Mentioned({ text, turn }: { text: string; turn?: Turn }) {
	const deck = useDeck((s) => s.deck)!;
	const setCurrent = useDeck((s) => s.setCurrent);
	const toks = mentionTokens(text);
	if (!toks.length) return <>{text}</>;
	const go = (no: number) => {
		const id = turn?.mentions?.find((m) => m.no === no)?.id;
		const i = id ? deck.slides.findIndex((s) => s.id === id) : no - 1;
		if (i >= 0 && i < deck.slides.length) setCurrent(i);
	};
	const out: React.ReactNode[] = [];
	let at = 0;
	toks.forEach((tk, k) => {
		out.push(<Fragment key={"t" + k}>{text.slice(at, tk.start)}</Fragment>);
		out.push(<button key={"m" + k} className="mention" onClick={() => go(tk.from)}>{text.slice(tk.start, tk.end).trim()}</button>);
		at = tk.end;
	});
	out.push(<Fragment key="end">{text.slice(at)}</Fragment>);
	return <>{out}</>;
}

function Composer() {
	const t = useT();
	const pins = useDeck((s) => s.pins);
	const deck = useDeck((s) => s.deck)!;
	const running = useDeck((s) => s.running);
	const send = useDeck((s) => s.send);
	const stop = useDeck((s) => s.stop);
	const update = useDeck((s) => s.updatePin);
	const remove = useDeck((s) => s.removePin);
	const setCurrent = useDeck((s) => s.setCurrent);
	const dir = useDeck((s) => s.dir);
	const current = useDeck((s) => s.current);
	const mentionReq = useDeck((s) => s.mentionReq);
	const rev = useDeck((s) => s.rev);
	const [text, setText] = useState("");
	const [attach, setAttach] = useState<string[]>([]);
	const ta = useRef<HTMLTextAreaElement>(null);
	// @ 고르기 창 — start 는 @ 자리, sel 은 고른 줄
	const [pick, setPick] = useState<{ start: number; q: string; sel: number } | null>(null);
	const cands = useMemo(() => (pick ? mentionCandidates(deck, pick.q, current) : []), [pick, deck, current]);
	const mentioned = useMemo(() => mentionsIn(text, deck), [text, deck]);
	const sense = (value: string, caret: number) => {
		const m = typingMention(value, caret);
		setPick(m ? { ...m, sel: 0 } : null);
	};
	/** 글의 [from, to) 를 「@번호 」로 바꾸고 커서를 그 뒤에 둔다 */
	const put = (from: number, to: number, no: number) => {
		const ins = `@${no} `;
		const next = text.slice(0, from) + ins + text.slice(to).replace(/^ /, "");
		setText(next);
		setPick(null);
		requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(from + ins.length, from + ins.length); } });
	};
	// 방향키로 고른 줄이 고르기 창 밖으로 나가지 않게
	useEffect(() => { document.querySelector(".picker .on")?.scrollIntoView({ block: "nearest" }); }, [pick?.sel]);
	// 쪽 목록의 「이 쪽 언급」 — 커서 자리에 넣는다. 앞 글자에 붙지 않게 빈칸을 둔다
	useEffect(() => {
		if (!mentionReq) return;
		const el = ta.current;
		const at = el ? el.selectionStart : text.length;
		const pad = at > 0 && !/\s/.test(text[at - 1]) ? " " : "";
		const ins = `${pad}@${mentionReq.no} `;
		setText(text.slice(0, at) + ins + text.slice(at));
		requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + ins.length, at + ins.length); });
	}, [mentionReq]);
	useEffect(() => {
		const el = ta.current!;
		el.style.height = "auto";
		el.style.height = Math.min(220, el.scrollHeight) + "px";
	}, [text]);

	const can = !running && (text.trim() || pins.length);
	const go = () => {
		if (!can) return;
		send(text, attach);
		setText("");
		setPick(null);
		setAttach([]);
	};
	// 붙여 넣은 그림은 .claudeppt/attach 에 두고 경로를 요청에 붙인다 (Claude 의 Read 가 그림을 본다)
	const onPaste = async (e: React.ClipboardEvent) => {
		const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
		if (!files.length) return;
		e.preventDefault();
		for (const f of files) {
			const rel = `.claudeppt/attach/${Date.now().toString(36)}.${f.type.split("/")[1] || "png"}`;
			await api.writeB64(dir, rel, b64FromBytes(new Uint8Array(await f.arrayBuffer())));
			setAttach((a) => [...a, rel]);
		}
	};
	const slideNo = (id: string) => deck.slides.findIndex((s) => s.id === id) + 1;

	return (
		<div className="composer">
			{pins.length > 0 && (
				<div className="tray" aria-label={t("pins")}>
					{pins.map((p, i) => (
						<div className="tray-pin" key={p.id}>
							<span className="n">{i + 1}</span>
							<button className="where" onClick={() => setCurrent(slideNo(p.slide) - 1)}>{slideNo(p.slide)}{t("slideN") === "쪽" ? "쪽" : ""}</button>
							<input defaultValue={p.text} key={p.text} placeholder={p.target?.text || t("pinPlaceholder")} onBlur={(e) => { if (e.target.value !== p.text) update(p.id, e.target.value); }}
								onKeyDown={(e) => { if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); if (e.ctrlKey) go(); } }} />
							<button className="x" onClick={() => remove(p.id)} aria-label={t("delete")}>×</button>
						</div>
					))}
				</div>
			)}
			<div className="box">
				{pick && (
					<div className="picker" role="listbox" aria-label={t("slides")}>
						{cands.length === 0 && <div className="none">{t("mentionNone")}</div>}
						{cands.map((m, i) => (
							<button key={m.id} role="option" aria-selected={i === pick.sel} className={i === pick.sel ? "on" : ""}
								onMouseDown={(e) => { e.preventDefault(); put(pick.start, ta.current?.selectionStart ?? text.length, m.no); }}
								onMouseEnter={() => setPick({ ...pick, sel: i })}>
								<span className="mono">@{m.no}</span>
								{/* 작은 미리보기 — 제목이 없는 쪽(가져온 덱에 흔하다)도 모양으로 가려 고르게 */}
								<span className="pthumb" style={{ height: (64 * deck.size.h) / deck.size.w }}><SlideFrame file={m.file} rev={rev[m.id] || 0} w={deck.size.w} h={deck.size.h} width={64} /></span>
								<span className="title">{m.title || t("untitled")}</span>
								{m.no === current + 1 && <span className="here">{t("here")}</span>}
							</button>
						))}
					</div>
				)}
				<textarea ref={ta} rows={2} value={text} placeholder={t("composerHint")} onPaste={onPaste}
					onChange={(e) => { setText(e.target.value); sense(e.target.value, e.target.selectionStart); }}
					onClick={(e) => sense(text, e.currentTarget.selectionStart)}
					onBlur={() => setPick(null)}
					onKeyDown={(e) => {
						if (e.nativeEvent.isComposing) return;
						// 고르기 창이 떠 있으면 위아래 · Enter · Tab · Esc 는 창이 쓴다
						if (pick && cands.length) {
							if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setPick({ ...pick, sel: (pick.sel + (e.key === "ArrowDown" ? 1 : cands.length - 1)) % cands.length }); return; }
							if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); put(pick.start, e.currentTarget.selectionStart, cands[pick.sel].no); return; }
						}
						if (pick && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setPick(null); return; }
						if (e.key === "Enter" && (e.ctrlKey || !e.shiftKey)) { e.preventDefault(); go(); }
					}}
					onKeyUp={(e) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) sense(text, e.currentTarget.selectionStart); }} />
				<div className="bar">
					<div className="attach">
						{mentioned.map((m) => <button key={m.id} className="mention" onClick={() => setCurrent(m.no - 1)} title={m.title || ""}>@{m.no}{m.title ? ` ${m.title}` : ""}</button>)}
						{attach.map((a) => <span key={a}>{a.split("/").pop()}<button onClick={() => setAttach(attach.filter((x) => x !== a))}>×</button></span>)}
					</div>
					{running ? (
						<button className="send stop" onClick={stop}>{t("stop")}</button>
					) : (
						<button className={"send" + (pins.length ? " pins" : "")} disabled={!can} onClick={go}>
							{pins.length ? `${t("sendPins")} ${pins.length}` : t("send")}<kbd>↵</kbd>
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
