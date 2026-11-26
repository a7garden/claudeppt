// 제목 줄 오른쪽 — 내보내기(PPTX 두 갈래 · CPPT 묶음 · 폴더 열기)와 릴리즈. 누른 단추 아래에 작은 띄움 상자로 편다.
// 2026.11.18 : 내보내기의 「비교」는 무대 도구 띠 오른쪽으로 옮겼다 — 내보내는 일이 아니라 무대에서 보는 일이다.
// 2026.11.26 : 「점검」(처음 이름은 감사)을 더했다 — 서식 · 배치 · 표현 규칙에 걸린 곳을 쪽마다 짚고, 고르면 Claude 에게 고치게 한다 (audit.ts).
//              「쪽 설정」을 더했다 — 덱의 쪽 여백을 네 변으로 정한다.
import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { api, join } from "../lib/api";
import { type Margins, repageCss, safeName } from "../lib/deck";
import type { AuditKind } from "../lib/audit";
import { focus, hideCheck, runCheck, useCheck, useGuides } from "../lib/checkView";
import { type Key, useT } from "../lib/i18n";
import { deckTemplate, pageMargins } from "../lib/prompt";
import { useSettings } from "../lib/settings";
import { me, useDeck } from "../lib/store";
import { remote } from "../lib/transport";

export default function DeckActions() {
	const t = useT();
	const [open, setOpen] = useState<"" | "audit" | "page" | "export" | "release">("");
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const k = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(""); };
		const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(""); };
		addEventListener("mousedown", k);
		addEventListener("keydown", esc);
		return () => { removeEventListener("mousedown", k); removeEventListener("keydown", esc); };
	}, [open]);
	useEffect(() => {
		const k = (e: KeyboardEvent) => { if (e.ctrlKey && e.key.toLowerCase() === "e") { e.preventDefault(); setOpen("export"); } };
		addEventListener("keydown", k);
		return () => removeEventListener("keydown", k);
	}, []);
	const busy = useDeck((s) => !!s.busy || !!s.running);
	return (
		<div ref={ref} className="deck-acts">
			<button className={"tb-btn" + (open === "page" ? " on" : "")} onClick={() => setOpen(open === "page" ? "" : "page")} disabled={busy || remote}>{t("pageSetup")}</button>
			<button className={"tb-btn" + (open === "audit" ? " on" : "")} onClick={() => setOpen(open === "audit" ? "" : "audit")} disabled={busy}>{t("audit")}</button>
			<button className={"tb-btn" + (open === "export" ? " on" : "")} onClick={() => setOpen(open === "export" ? "" : "export")} disabled={busy}>{t("export")}</button>
			<button className={"tb-btn" + (open === "release" ? " on" : "")} onClick={() => setOpen(open === "release" ? "" : "release")} disabled={busy}>{t("release")}</button>
			{open === "audit" && <AuditPop onDone={() => setOpen("")} />}
			{open === "page" && <PagePop onDone={() => setOpen("")} />}
			{open === "export" && <ExportPop onDone={() => setOpen("")} />}
			{open === "release" && <ReleasePop onDone={() => setOpen("")} />}
		</div>
	);
}

/** 내보내기 — 두 PPTX 는 「무엇이 되는가」 한 줄로 가른다. 이름 뒤 작은 꼬리표만으로는 둘의 차이를 몰랐다 */
function ExportPop({ onDone }: { onDone: () => void }) {
	const t = useT();
	const { deck, dir, versions, exportTo, notify } = useDeck.getState();
	const n = versions[0]?.n ?? 0;
	const base = `${safeName(deck!.title)}_v${n}`;
	const pptx = async (exact: boolean) => {
		onDone();
		const p = await save({ defaultPath: base + (exact ? "_exact" : "") + ".pptx", filters: [{ name: "PowerPoint", extensions: ["pptx"] }] });
		if (p) exportTo(p, exact);
	};
	return (
		<div className="pop export">
			<div className="choices">
				<button onClick={() => pptx(false)}>
					<b>{t("pptxEditable")}</b>
					<span>{t("pptxEditableHint")}</span>
				</button>
				<button onClick={() => pptx(true)}>
					<b>{t("pptxExact")}</b>
					<span>{t("pptxExactHint")}</span>
				</button>
			</div>
			<div className="list">
				<button onClick={async () => {
					onDone();
					const p = await save({ defaultPath: base + ".cppt", filters: [{ name: "ClaudePPT", extensions: ["cppt"] }] });
					if (p) { await api.commit(dir, t("direct"), me()).catch(() => {}); await api.pack(dir, p).then(() => notify(p.split(/[\\/]/).pop()!), (e) => notify(String(e), "err")); }
				}}>
					{t("cppt")}<span>{t("cpptHint")}</span>
				</button>
				<button onClick={() => { onDone(); api.reveal(join(dir, "deck.json")); }}>
					{t("folder")}<span>↗</span>
				</button>
			</div>
		</div>
	);
}

/** 릴리즈 — 무엇이 묶여 나가는지 보이게, 지난 릴리즈 뒤 보낸 요청을 메모에 미리 채운다. 사용자가 고쳐 쓴다 */
function ReleasePop({ onDone }: { onDone: () => void }) {
	const t = useT();
	const releases = useDeck((s) => s.releases);
	const versions = useDeck((s) => s.versions);
	const turns = useDeck((s) => s.turns);
	const release = useDeck((s) => s.release);
	const dir = useDeck((s) => s.dir);
	const last = releases[releases.length - 1];
	const since = turns.filter((x) => x.version && x.request && (!last || x.version.n > last.n));
	const [name, setName] = useState("");
	const [notes, setNotes] = useState(() => since.map((x) => "- " + x.request.replace(/\s+/g, " ").slice(0, 80)).join("\n"));
	const next = `r${releases.length + 1}`;
	const head = versions[0]?.n ?? 0;
	return (
		<div className="pop">
			<div className="head">
				<b>{t("release")} {next}</b>
				<span>{t("releaseOf").replace("{v}", `v${head}`)}{last ? ` · ${t("releaseSince").replace("{r}", last.tag).replace("{n}", String(since.length))}` : ""}</span>
			</div>
			<input className="field" autoFocus placeholder={t("releaseName")} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { onDone(); release(name, notes); } }} />
			<textarea className="field" rows={4} placeholder={t("notes")} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ fontFamily: "var(--ui)", fontSize: 13 }} />
			<div className="acts">
				<button className="ghost" onClick={onDone}>{t("cancel")}</button>
				<button className="send" onClick={() => { onDone(); release(name, notes); }}>{t("confirm")}</button>
			</div>
			{releases.length > 0 && (
				<div className="rels">
					{/* 판 목록과 같은 꼬리표 · 판 알약. 알약은 대화에서처럼 그 판을 보고, ↗ 는 만든 PPTX 가 있는 폴더를 연다 */}
					{[...releases].reverse().map((r) => {
						const c = versions.find((v) => v.n === r.n);
						return (
							<div key={r.tag}>
								<i className="rtag">{r.tag}</i>
								<span>{r.name}</span>
								<button className={"node" + (c && c === versions[0] ? " head" : "")} disabled={!c} onClick={() => { if (c) { onDone(); useDeck.getState().setPreview(c); } }} title={c?.subject}>v{r.n}</button>
								<button className="open" title={r.file} aria-label={r.file} onClick={() => api.reveal(join(dir, r.file))}>↗</button>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

/** 점검 갈래 — 이름과 무엇을 보는지 한 줄 */
const KINDS: { k: AuditKind; label: Key; hint: Key }[] = [
	{ k: "template", label: "auditKindTemplate", hint: "auditKindTemplateHint" },
	{ k: "layout", label: "auditKindLayout", hint: "auditKindLayoutHint" },
	{ k: "slop", label: "auditKindSlop", hint: "auditKindSlopHint" },
];
const kindLabel = (k: AuditKind): Key => KINDS.find((x) => x.k === k)!.label;
/** 고른 갈래 — 이 PC 에 기억한다 */
const KINDS_KEY = "cppt.checkKinds";
const savedKinds = (): AuditKind[] => {
	try { const v = JSON.parse(localStorage.getItem(KINDS_KEY) || "null"); if (Array.isArray(v) && v.length) return v; } catch {}
	return KINDS.map((x) => x.k);
};

/** 점검 — 누르면 먼저 무엇을 볼지(갈래 · 추가 지시)를 정하고 「점검 시작」. 결과의 항목을 누르면 그 쪽으로 가서 걸린 요소를 무대에 표시한다.
 *  2026.11.26 : 누르자마자 돌던 것을 시작 화면으로 바꿨다. 규칙 점검은 자동이고, 사람이 적은 지시는 「Claude 에게 고치기」에 함께 실린다 */
function AuditPop({ onDone }: { onDone: () => void }) {
	const t = useT();
	const dir = useDeck((s) => s.dir);
	const report = useCheck((s) => s.report);
	const [setup, setSetup] = useState(!report);
	const [kinds, setKinds] = useState<AuditKind[]>(savedKinds);
	// 추가 지시 — 덱 안 파일에 둔다. 읽기 전에는 null
	const [note, setNote] = useState<string | null>(null);
	const loaded = useRef("");
	useEffect(() => { import("../lib/audit").then((a) => a.readAuditNote(dir)).then((n) => { loaded.current = n; setNote(n); }); }, [dir]);
	const [step, setStep] = useState<[number, number] | null>(null);
	const [kind, setKind] = useState<AuditKind | "all">("all");
	const run = async (ks?: AuditKind[]) => {
		const { deck, notify } = useDeck.getState();
		if (!deck) return;
		try { localStorage.setItem(KINDS_KEY, JSON.stringify(kinds)); } catch {}
		setStep([0, deck.slides.length]);
		try {
			if (note !== null && note.trim() !== loaded.current) {
				const { writeAuditNote } = await import("../lib/audit");
				await writeAuditNote(dir, note);
				loaded.current = note.trim();
			}
			await runCheck((i, n) => setStep([i, n]), ks);
			setKind("all");
			setSetup(false);
		} catch (e) { notify(String(e), "err"); }
		finally { setStep(null); }
	};
	const toggle = (k: AuditKind) => setKinds((v) => (v.includes(k) ? v.filter((x) => x !== k) : KINDS.map((x) => x.k).filter((x) => x === k || v.includes(x))));

	if (step) {
		return (
			<div className="pop audit">
				<div className="head"><b>{t("auditRunning")}</b><span className="mono">{step[0]}/{step[1]}</span><div className="audit-bar"><i style={{ width: `${step[1] ? (step[0] / step[1]) * 100 : 0}%` }} /></div></div>
			</div>
		);
	}

	if (setup || !report) {
		return (
			<div className="pop audit">
				<div className="head"><b>{t("audit")}</b><span>{t("auditIntro")}</span></div>
				<div className="audit-pick" role="group" aria-label={t("auditWhat")}>
					{KINDS.map((x) => (
						<label key={x.k} className="check">
							<input type="checkbox" checked={kinds.includes(x.k)} onChange={() => toggle(x.k)} />
							<span><b>{t(x.label)}</b><span className="dim">{t(x.hint)}</span></span>
						</label>
					))}
				</div>
				<label className="audit-note">
					<span className="lbl">{t("auditNote")}</span>
					<textarea className="field" rows={3} value={note ?? ""} disabled={note === null} onChange={(e) => setNote(e.target.value)} placeholder={t("auditNotePh")} />
					<span className="dim">{t("auditNoteHint")}</span>
				</label>
				<div className="acts">
					{report ? <button className="ghost" onClick={() => setSetup(false)}>{t("auditBack")}</button> : <button className="ghost" onClick={onDone}>{t("cancel")}</button>}
					<button className="send" disabled={!kinds.length || note === null} onClick={() => run(kinds)}>{t("auditStart")}</button>
				</div>
			</div>
		);
	}

	const pick = (k: AuditKind | "all") => report.slides.map((s) => ({ ...s, findings: s.findings.map((f, i) => ({ f, i })).filter((x) => k === "all" || x.f.kind === k) })).filter((s) => s.findings.length);
	const shown = pick(kind);
	const count = (k: AuditKind | "all") => pick(k).reduce((n, s) => n + s.findings.length, 0);
	const fix = async () => {
		const { auditFixPrompt } = await import("../lib/audit");
		const text = auditFixPrompt(report, kind === "all" ? undefined : [kind]);
		if (!text) return;
		onDone();
		hideCheck();
		useDeck.getState().send(text);
	};
	const canFix = count(kind) > 0 || !!report.note;
	return (
		<div className="pop audit">
			<div className="head">
				<b>{count("all") ? t("auditSummary").replace("{s}", String(pick("all").length)).replace("{n}", String(count("all"))) : t("auditClean")}</b>
				<span>{[report.template ? t("auditOf").replace("{v}", report.template) : t("auditNoTemplate"), report.kinds.map((k) => t(kindLabel(k))).join(" · ")].join(" · ")}</span>
				{report.note && <span className="audit-noted" title={report.note}>{t("auditNote")}: {report.note.replace(/\s+/g, " ")}</span>}
			</div>
			{count("all") > 0 && report.kinds.length > 1 && (
				<div className="seg audit-kinds" role="group">
					<button aria-pressed={kind === "all"} onClick={() => setKind("all")}>{t("auditAll")} <span className="mono">{count("all")}</span></button>
					{KINDS.filter((x) => report.kinds.includes(x.k)).map((x) => <button key={x.k} aria-pressed={kind === x.k} disabled={!count(x.k)} onClick={() => setKind(x.k)}>{t(x.label)} <span className="mono">{count(x.k)}</span></button>)}
				</div>
			)}
			{shown.length > 0 && (
				<div className="audit-list">
					{shown.map((s) => (
						<section key={s.id}>
							<button className="slide-row" onClick={() => { focus(s.id, s.findings[0].i); onDone(); }} title={s.title}>
								<span className="mono">{s.no}</span><span className="t">{s.title || t("untitled")}</span>
							</button>
							<ul>
								{s.findings.map(({ f, i }) => (
									<li key={i}>
										<button onClick={() => { focus(s.id, i); onDone(); }} title={t("auditShow")}>
											<span className={"k k-" + f.kind}>{t(kindLabel(f.kind))}</span><span>{f.msg}</span>
										</button>
									</li>
								))}
							</ul>
						</section>
					))}
				</div>
			)}
			<div className="acts">
				<button className="ghost" onClick={() => setSetup(true)}>{t("auditSetup")}</button>
				<button className="ghost" onClick={() => run()}>{t("auditAgain")}</button>
				{canFix && <button className="send" onClick={fix}>{count(kind) ? t("auditFix") : t("auditFixNote")}</button>}
			</div>
		</div>
	);
}

/** 쪽 설정 — 워드의 쪽 설정처럼 이 덱의 여백을 네 변으로 정한다. theme.css 의 --margin-t · -r · -b · -l 과 deck.json 에 남고,
 *  Claude 에게도 매 턴 그 값이 실린다(prompt.ts pageRules). 이미 있는 쪽은 숫자를 직접 쓴 곳이 있어 저절로 따라오지 않으므로, 맞추기를 함께 맡길 수 있다 */
function PagePop({ onDone }: { onDone: () => void }) {
	const t = useT();
	const deck = useDeck((s) => s.deck)!;
	const dir = useDeck((s) => s.dir);
	const tpl = deckTemplate(useSettings.getState().s, deck);
	const base = tpl?.margin ?? 72;
	const cur = pageMargins(deck, tpl) ?? { t: base, r: base, b: base, l: base };
	const [m, setM] = useState<Margins>(cur);
	const [linked, setLinked] = useState(cur.t === cur.r && cur.r === cur.b && cur.b === cur.l);
	const [refit, setRefit] = useState(true);
	const guides = useGuides();
	const SIDES: { k: keyof Margins; label: Key }[] = [{ k: "t", label: "pageTop" }, { k: "b", label: "pageBottom" }, { k: "l", label: "pageLeft" }, { k: "r", label: "pageRight" }];
	const clamp = (v: number, k: keyof Margins) => Math.max(0, Math.min(Math.round(v) || 0, Math.floor((k === "t" || k === "b" ? deck.size.h : deck.size.w) / 2) - 20));
	const put = (k: keyof Margins, v: number) => setM((x) => (linked ? { t: clamp(v, "t"), r: clamp(v, "r"), b: clamp(v, "b"), l: clamp(v, "l") } : { ...x, [k]: clamp(v, k) }));
	const preset = (v: number) => setM({ t: v, r: v, b: v, l: v });
	const same = (a: Margins, b: Margins) => a.t === b.t && a.r === b.r && a.b === b.b && a.l === b.l;
	const apply = async (next: Margins | null) => {
		const st = useDeck.getState();
		onDone();
		try {
			await api.writeText(dir, "theme.css", repageCss(await api.readText(dir, "theme.css"), next));
			const { page: _, ...rest } = deck;
			await st.saveDeck(next ? { ...rest, page: { margin: next } } : rest);
			st.notify(next ? t("pageDone").replace("{v}", `${next.t} · ${next.r} · ${next.b} · ${next.l}`) : t("pageReset"), "ok");
			const eff = next ?? { t: base, r: base, b: base, l: base };
			if (refit && !same(eff, cur)) {
				st.send(`Page setup changed: margins are now top ${eff.t}px, right ${eff.r}px, bottom ${eff.b}px, left ${eff.l}px${next ? " (var(--margin-t), var(--margin-r), var(--margin-b), var(--margin-l))" : " (var(--margin))"}. Update every slide so its text and content sit inside the new margins, using the variables instead of fixed numbers. Do not change the content or the design otherwise.`);
			}
		} catch (e) { st.notify(String(e), "err"); }
	};
	return (
		<div className="pop page-set">
			<div className="head"><b>{t("pageSetup")}</b><span>{t("pageSize").replace("{w}", String(deck.size.w)).replace("{h}", String(deck.size.h))}</span></div>
			<div className="page-body">
				{/* 쪽 미리보기 — 여백 안쪽이 글이 놓일 자리 */}
				<div className="page-mini" style={{ aspectRatio: `${deck.size.w} / ${deck.size.h}` }} aria-hidden>
					<i style={{ left: `${(m.l / deck.size.w) * 100}%`, right: `${(m.r / deck.size.w) * 100}%`, top: `${(m.t / deck.size.h) * 100}%`, bottom: `${(m.b / deck.size.h) * 100}%` }} />
				</div>
				<div className="page-fields">
					{SIDES.map((x) => (
						<label key={x.k}>
							<span>{t(x.label)}</span>
							<input className="field mono" type="number" min={0} step={4} value={m[x.k]} onChange={(e) => put(x.k, +e.target.value)} />
							<span className="dim">px</span>
						</label>
					))}
				</div>
			</div>
			<label className="check"><input type="checkbox" checked={linked} onChange={() => { setLinked(!linked); if (!linked) preset(m.t); }} /><span>{t("pageLinked")}</span></label>
			<div className="seg" role="group" aria-label={t("pagePresets")}>
				<button onClick={() => preset(40)}>{t("pageNarrow")} 40</button>
				<button onClick={() => preset(base)}>{t("pageNormal")} {base}</button>
				<button onClick={() => preset(Math.round(base * 1.5))}>{t("pageWide")} {Math.round(base * 1.5)}</button>
			</div>
			<label className="check"><input type="checkbox" checked={guides.on} onChange={() => guides.set(!guides.on)} /><span>{t("pageGuides")}</span></label>
			<label className="check"><input type="checkbox" checked={refit} onChange={() => setRefit(!refit)} /><span>{t("pageRefit")}</span></label>
			<div className="acts">
				{deck.page && <button className="ghost" onClick={() => apply(null)} title={t("pageFollowHint")}>{t("pageFollow")}</button>}
				<button className="ghost" onClick={onDone}>{t("cancel")}</button>
				<button className="send" disabled={!!deck.page && same(m, cur)} onClick={() => apply(m)}>{t("pageApply")}</button>
			</div>
		</div>
	);
}
