// 변경 기록 — 제목 줄의 줄 이름(본안 · 시안 · 변경 번호)을 누르면 편다. 본안 · 시안 · 보류의 변경을 그래프 하나로 (branch.rs vcs_graph).
//   갈래로 보기    세로 줄이 본안 · 시안 · 보류. 갈라진 자리와 합친 자리가 선으로 보인다
//   사람별로 보기  세로 줄이 사람. 담당이 나뉜 덱에서 누가 언제 무엇을 했는지
//   점 색은 사람마다 — 아래 사람 목록을 누르면 그 사람 것만 진하게
//   행을 누르면 그때를 무대에서 보고, 우클릭은 비교 · 되돌리기 · 여기서 시안 만들기 · (시안 · 보류의 끝이면) 그 줄 다루기
// 2026.11.27 : 판 목록(목록뿐, 본 줄만)을 이것으로 바꿨다 — 시안 · 보류 · 사람이 섞이면 목록으로는 어느 줄의 일인지 보이지 않는다.
//              「판」은 이제 사용자가 내는 확정본(PPTX)만 뜻한다. 고칠 때마다 쌓이는 것은 「변경」이다
import { open as pickDir, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Commit, type GraphHead, type GraphNode } from "../lib/api";
import { lanes } from "../lib/graph";
import { useT } from "../lib/i18n";
import { useDeck } from "../lib/store";
import { remote } from "../lib/transport";
import { openMenu } from "./ContextMenu";

const ROW = 30;
const COL = 14;
/** 사람 색 — 밝은 바탕 · 어두운 바탕 모두에서 점으로 읽히는 중간 밝기, 서로 헷갈리지 않는 색만. 이름 없는 변경(ClaudePPT · 바깥 CLI)은 흐린 색 */
const PEOPLE = ["#3b82f6", "#e5484d", "#12a594", "#e5a000", "#8e4ec6", "#d6409f", "#8d6e4f", "#5b6b7f"];
const NOBODY = "ClaudePPT";

type Graph = { nodes: GraphNode[]; heads: GraphHead[] };
type Ask = { kind: "sian"; from?: string } | { kind: "send" } | { kind: "fetch"; from: string };
/** 넣기 · 본안 받기가 겹쳤다 — 겹친 곳을 어느 쪽 것으로 할지 사람이 고른다 */
type Clash = { kind: "merge" | "update"; id: string };

export function History({ onClose }: { onClose: () => void }) {
	const t = useT();
	const dir = useDeck((s) => s.dir);
	const line = useDeck((s) => s.line);
	const versions = useDeck((s) => s.versions);
	const sians = useDeck((s) => s.sians);
	const holds = useDeck((s) => s.holds);
	const preview = useDeck((s) => s.preview);
	const running = useDeck((s) => s.running);
	const [g, setG] = useState<Graph | null>(null);
	const [mode, setMode] = useState<"line" | "people">("line");
	const [who, setWho] = useState<string | null>(null);
	const [ask, setAsk] = useState<Ask | null>(null);
	const [name, setName] = useState("");
	const [clash, setClash] = useState<Clash | null>(null);
	const [busy, setBusy] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const main = line?.main ?? dir;
	const head = versions[0];
	const st = useDeck.getState();

	useEffect(() => {
		let live = true;
		// 공유 덱 창(팀원)은 그래프를 읽지 못한다 — 덱 주인이 올려 준 본안의 변경 목록으로 한 줄만 그린다
		const flat = (): Graph => ({
			nodes: versions.map((c, i) => ({ hash: c.hash, short: c.short, parents: versions[i + 1] ? [versions[i + 1].hash] : [], author: c.author, date: c.date, subject: c.subject, tags: c.tags })),
			heads: head ? [{ kind: "main", id: "main", name: "main", hash: head.hash }] : [],
		});
		if (remote) setG(flat());
		else api.graph(main, 300).then((x) => { if (live) setG(x); }, () => { if (live) setG(flat()); });
		return () => { live = false; };
	}, [main, head?.hash, sians.map((x) => x.hash).join(), holds.length]);
	useEffect(() => {
		const k = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.(".stamp, .ctx")) onClose(); };
		const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
		addEventListener("mousedown", k);
		addEventListener("keydown", esc);
		return () => { removeEventListener("mousedown", k); removeEventListener("keydown", esc); };
	}, [onClose]);

	const nodes = g?.nodes ?? [];
	const people = useMemo(() => {
		const n = new Map<string, number>();
		for (const x of nodes) n.set(x.author, (n.get(x.author) ?? 0) + 1);
		return [...n].sort((a, b) => b[1] - a[1]).map(([p]) => p);
	}, [nodes]);
	// 색은 이름의 가나다 차례로 — 많이 한 차례로 매기면 변경이 쌓일 때마다 같은 사람의 색이 바뀌었고, 이름 해시는 비슷한 색끼리 겹쳤다 (2026.11.27 화면 확인).
	// 그래프는 본안 · 시안 · 보류를 다 담아 어느 줄에서 열어도 사람이 같으므로 색도 같다
	const named = useMemo(() => people.filter((x) => x !== NOBODY).sort((a, b) => a.localeCompare(b)), [people]);
	const color = (p: string) => (p === NOBODY ? "var(--faint)" : PEOPLE[named.indexOf(p) % PEOPLE.length]);
	const lay = useMemo(() => {
		if (mode === "line") return lanes(nodes, g?.heads ?? []);
		const col = new Map(nodes.map((n) => [n.hash, people.indexOf(n.author)]));
		return { col, kind: new Map(), cols: Math.max(1, people.length) };
	}, [nodes, g, mode, people]);
	const row = useMemo(() => new Map(nodes.map((n, i) => [n.hash, i])), [nodes]);
	const x = (c: number) => 9 + c * COL;
	const y = (r: number) => r * ROW + ROW / 2;
	const width = x(lay.cols - 1) + 9;
	const headsAt = useMemo(() => {
		const m = new Map<string, GraphHead[]>();
		for (const h of g?.heads ?? []) m.set(h.hash, [...(m.get(h.hash) ?? []), h]);
		return m;
	}, [g]);
	const onLine = (hash: string) => versions.find((c) => c.hash === hash);
	const asCommit = (n: GraphNode): Commit => onLine(n.hash) ?? { n: 0, hash: n.hash, short: n.short, date: n.date, subject: n.subject, tags: n.tags, author: n.author };
	const pick = (n: GraphNode) => st.setPreview(n.hash === head?.hash || preview?.hash === n.hash ? null : asCommit(n));
	const run = async (f: () => Promise<unknown>) => { setBusy(true); try { await f(); } finally { setBusy(false); } };

	const merge = (id: string, prefer?: "theirs") => run(async () => {
		const ok = await st.mergeSian(id, prefer);
		setClash(ok ? null : { kind: "merge", id });
	});
	const update = (prefer?: "theirs" | "ours") => run(async () => {
		const ok = await st.updateSian(prefer);
		setClash(ok ? null : { kind: "update", id: line?.sian ?? "" });
	});
	const menu = (e: React.MouseEvent, n: GraphNode) => {
		const c = onLine(n.hash);
		const hs = headsAt.get(n.hash) ?? [];
		openMenu(e, [
			{ label: t("viewVersion"), run: () => pick(n), disabled: n.hash === head?.hash },
			{ label: t("compareWith"), run: () => { onClose(); st.startCompare(asCommit(n)); }, disabled: n.hash === head?.hash },
			...(c ? [
				{ label: t("restore"), run: () => st.restore(c), disabled: c === head || !!running || remote },
				{ label: t("mentionVersion"), run: () => { onClose(); st.mentionVersion(c.n); }, disabled: c === head },
			] : []),
			...(remote ? [] : ["-" as const, { label: t("sianFromHere"), run: () => { setName(""); setAsk({ kind: "sian", from: n.hash }); } }]),
			...(remote ? [] : hs.flatMap((h) => h.kind === "sian" ? ["-" as const,
				{ label: t("sianOpen").replace("{name}", h.name), run: () => { onClose(); st.openSian(h.id); }, disabled: line?.sian === h.id },
				{ label: t("sianMerge"), run: () => merge(h.id) },
				{ label: t("sianDrop"), run: () => st.dropSian(h.id), danger: true },
			] : h.kind === "hold" ? ["-" as const,
				{ label: t("heldRetry"), run: () => st.holdRetry(h.id) },
				{ label: t("heldTake"), run: () => st.holdTake(h.id) },
				{ label: t("heldDrop"), run: () => st.holdDrop(h.id), danger: true },
			] : [])),
		]);
	};
	const submit = () => run(async () => {
		const a = ask!;
		setAsk(null);
		if (a.kind === "sian") { onClose(); await st.newSian(name.trim() || t("sianUntitled"), a.from); }
		else if (a.kind === "send") await st.sendToOrigin(name.trim() || t("sianUntitled"));
		else await st.fetchFork(a.from, name.trim() || t("sianUntitled"));
	});
	const more = (e: React.MouseEvent) => openMenu(e, [
		{ label: t("forkMake"), run: async () => {
			const dest = await save({ title: t("forkMake"), defaultPath: `${useDeck.getState().deck?.title ?? "deck"} ${t("forkSuffix")}` });
			if (dest) { onClose(); await st.forkDeck(dest); }
		} },
		{ label: t("forkSend"), run: () => { setName(""); setAsk({ kind: "send" }); }, disabled: !line?.origin },
		{ label: t("forkFetch"), run: async () => {
			const from = await pickDir({ directory: true, title: t("forkFetch") });
			if (typeof from === "string") { setName(""); setAsk({ kind: "fetch", from }); }
		} },
	]);
	const sian = line?.sian ? sians.find((s) => s.id === line.sian) : null;

	return (
		<div className="pop history" ref={ref} role="dialog" aria-label={t("versions")}>
			<div className="hist-head">
				<div className="seg" role="radiogroup" aria-label={t("histView")}>
					<button role="radio" aria-checked={mode === "line"} onClick={() => setMode("line")}>{t("histByLine")}</button>
					<button role="radio" aria-checked={mode === "people"} onClick={() => setMode("people")}>{t("histByPeople")}</button>
				</div>
				{!remote && <button className="send" disabled={busy} onClick={() => { setName(""); setAsk({ kind: "sian" }); }} title={t("sianNewHint")}>{t("sianNew")}</button>}
				{!remote && <button className="more" disabled={busy} onClick={more} aria-label={t("forkMenu")} title={t("forkMenu")}>⋯</button>}
			</div>

			{line?.sian && (
				<section className="hist-sian">
					<p><b>{t("sianNow").replace("{name}", line.name ?? line.sian)}</b> {sian ? t("sianCounts").replace("{a}", String(sian.ahead)).replace("{b}", String(sian.behind)) : ""}</p>
					{!remote && (
						<div className="acts">
							<button disabled={busy || !sian?.behind} onClick={() => update()} title={t("sianUpdateHint")}>{t("sianUpdate")}</button>
							<button className="send" disabled={busy || !sian?.ahead} onClick={() => merge(line.sian!)} title={t("sianMergeHint")}>{t("sianMerge")}</button>
							<button disabled={busy} onClick={() => { onClose(); st.openMain(); }}>{t("sianBack")}</button>
						</div>
					)}
				</section>
			)}
			{clash && (
				<section className="hist-clash" role="alert">
					<p>{t(clash.kind === "merge" ? "sianClashMerge" : "sianClashUpdate")}</p>
					<div className="acts">
						{clash.kind === "merge"
							? <button disabled={busy} onClick={() => merge(clash.id, "theirs")}>{t("sianPreferSian")}</button>
							: <>
								<button disabled={busy} onClick={() => update("theirs")}>{t("sianPreferMain")}</button>
								<button disabled={busy} onClick={() => update("ours")}>{t("sianPreferMine")}</button>
							</>}
						<button disabled={busy} onClick={() => setClash(null)}>{t("cancel")}</button>
					</div>
				</section>
			)}
			{ask && (
				<form className="hist-ask" onSubmit={(e) => { e.preventDefault(); submit(); }}>
					<label>
						<span>{t(ask.kind === "sian" ? "sianNameAsk" : ask.kind === "send" ? "forkSendAsk" : "forkFetchAsk")}</span>
						<input className="field" autoFocus value={name} placeholder={t("sianNamePh")} onChange={(e) => setName(e.target.value)} />
					</label>
					<div className="acts">
						<button type="button" onClick={() => setAsk(null)}>{t("cancel")}</button>
						<button className="send" disabled={busy}>{t(ask.kind === "sian" ? "sianMake" : ask.kind === "send" ? "forkSendGo" : "forkFetchGo")}</button>
					</div>
				</form>
			)}

			<div className="hist-body" role="listbox" aria-label={t("versions")}>
				<div className="hist-rows" style={{ height: nodes.length * ROW }}>
					<svg className="hist-graph" width={width} height={nodes.length * ROW} aria-hidden>
						{mode === "line" && nodes.flatMap((n, i) => n.parents.map((p, k) => {
							const c1 = lay.col.get(n.hash) ?? 0, r2 = row.get(p), c2 = r2 == null ? c1 : lay.col.get(p) ?? 0;
							const x1 = x(c1), y1 = y(i), x2 = x(c2), y2 = r2 == null ? nodes.length * ROW : y(r2);
							const kind = lay.kind.get(k === 0 ? c1 : c2);
							const d = c1 === c2 ? `M${x1} ${y1}V${y2}` : k === 0 ? `M${x1} ${y1}V${y2 - ROW / 2}Q${x1} ${y2} ${x2} ${y2}` : `M${x1} ${y1}Q${x2} ${y1} ${x2} ${y1 + ROW / 2}V${y2}`;
							return <path key={n.hash + p} d={d} className={"edge " + (kind ?? "main")} />;
						}))}
						{mode === "people" && people.map((p, c) => {
							const rs = nodes.map((n, i) => (n.author === p ? i : -1)).filter((i) => i >= 0);
							return rs.length > 1 ? <path key={p} d={`M${x(c)} ${y(rs[0])}V${y(rs.at(-1)!)}`} className="edge person" /> : null;
						})}
						{nodes.map((n, i) => {
							const c = lay.col.get(n.hash) ?? 0;
							const hold = (headsAt.get(n.hash) ?? []).some((h) => h.kind === "hold") || lay.kind.get(c) === "hold";
							return <circle key={n.hash} cx={x(c)} cy={y(i)} r={n.hash === head?.hash ? 5.5 : 4.5} fill={color(n.author)} className={(hold ? "held " : "") + (who && who !== n.author ? "dim" : "")} />;
						})}
					</svg>
					{nodes.map((n, i) => {
						const on = preview ? preview.hash === n.hash : n.hash === head?.hash;
						const c = onLine(n.hash);
						const hs = headsAt.get(n.hash) ?? [];
						const rel = n.tags.find((x) => /^r\d+$/.test(x));
						return (
							<button key={n.hash} role="option" aria-selected={on} className={"hist-row" + (on ? " on" : "") + (who && who !== n.author ? " dim" : "")}
								style={{ top: i * ROW, height: ROW, paddingLeft: width + 6 }} onClick={() => pick(n)} onContextMenu={(e) => menu(e, n)}>
								<span className="no">{c ? `#${c.n}` : n.short}</span>
								<span className="s">
									{hs.map((h) => <i key={h.kind + h.id} className={"tag " + h.kind}>{h.kind === "main" ? t("mainLine") : h.kind === "sian" ? h.name : t("heldTag")}</i>)}
									{n.hash === head?.hash && <i className="tag now">{t("histNow")}</i>}
									{rel && <i className="rtag">{rel}</i>}
									<span className="sub">{n.subject}</span>
								</span>
								<span className="d">{n.author !== NOBODY ? `${n.author} · ` : ""}{n.date.slice(5, 16)}</span>
							</button>
						);
					})}
				</div>
				{!nodes.length && <p className="dim hist-empty">{t("histEmpty")}</p>}
			</div>

			{people.length > 0 && (
				<div className="hist-people" role="group" aria-label={t("histPeople")}>
					{people.map((p) => (
						<button key={p} aria-pressed={who === p} onClick={() => setWho(who === p ? null : p)}>
							<i style={{ background: color(p) }} />{p === NOBODY ? t("histNobody") : p}<span className="dim">{nodes.filter((n) => n.author === p).length}</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}
