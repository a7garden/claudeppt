// 대화 — 턴마다 왼쪽 여백에 그 턴이 남긴 판(v<n>)을 찍는다. 대화 기록이 곧 판 이력이다.
// 아래 요청칸 위에 아직 보내지 않은 핀이 쌓이고, 보내기 한 번에 글과 핀이 함께 간다.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, b64FromBytes } from "../lib/api";
import { useT } from "../lib/i18n";
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
				{turn.request && <div className="req">{turn.request}</div>}
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
	const [text, setText] = useState("");
	const [attach, setAttach] = useState<string[]>([]);
	const ta = useRef<HTMLTextAreaElement>(null);
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
				<textarea ref={ta} rows={2} value={text} placeholder={t("composerHint")} onChange={(e) => setText(e.target.value)} onPaste={onPaste}
					onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || !e.shiftKey) && !e.nativeEvent.isComposing) { e.preventDefault(); go(); } }} />
				<div className="bar">
					<div className="attach">
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
