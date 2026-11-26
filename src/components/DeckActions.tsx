// 제목 줄 오른쪽 — 내보내기(PPTX 두 갈래 · CPPT 묶음 · 폴더 열기)와 릴리즈. 누른 단추 아래에 작은 띄움 상자로 편다.
// 2026.11.18 : 내보내기의 「비교」는 무대 도구 띠 오른쪽으로 옮겼다 — 내보내는 일이 아니라 무대에서 보는 일이다.
// 2026.11.26 : 「감사」를 더했다 — 템플릿을 벗어난 곳 · AI 티가 나는 곳을 쪽마다 짚고, 고르면 Claude 에게 고치게 한다 (audit.ts).
import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { api, join } from "../lib/api";
import { safeName } from "../lib/deck";
import type { AuditKind, AuditReport } from "../lib/audit";
import { type Key, useT } from "../lib/i18n";
import { deckTemplate } from "../lib/prompt";
import { useSettings } from "../lib/settings";
import { me, useDeck } from "../lib/store";

export default function DeckActions() {
	const t = useT();
	const [open, setOpen] = useState<"" | "audit" | "export" | "release">("");
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
			<button className={"tb-btn" + (open === "audit" ? " on" : "")} onClick={() => setOpen(open === "audit" ? "" : "audit")} disabled={busy}>{t("audit")}</button>
			<button className={"tb-btn" + (open === "export" ? " on" : "")} onClick={() => setOpen(open === "export" ? "" : "export")} disabled={busy}>{t("export")}</button>
			<button className={"tb-btn" + (open === "release" ? " on" : "")} onClick={() => setOpen(open === "release" ? "" : "release")} disabled={busy}>{t("release")}</button>
			{open === "audit" && <AuditPop onDone={() => setOpen("")} />}
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

/** 덱마다 마지막 감사 — 상자를 닫았다 열어도 다시 돌리지 않는다. 고친 뒤에는 「다시 감사」 */
let lastAudit: { dir: string; report: AuditReport } | null = null;
const KINDS: { k: AuditKind | "all"; label: Key }[] = [
	{ k: "all", label: "auditAll" }, { k: "template", label: "auditKindTemplate" }, { k: "slop", label: "auditKindSlop" }, { k: "layout", label: "auditKindLayout" },
];

/** 감사 — 쪽마다 짚은 것을 한 줄씩. 쪽 줄을 누르면 그 쪽으로 가고, 「Claude 에게 고치기」는 지금 고른 갈래만 보낸다 */
function AuditPop({ onDone }: { onDone: () => void }) {
	const t = useT();
	const dir = useDeck((s) => s.dir);
	const [report, setReport] = useState<AuditReport | null>(lastAudit?.dir === dir ? lastAudit.report : null);
	const [step, setStep] = useState<[number, number] | null>(null);
	const [kind, setKind] = useState<AuditKind | "all">("all");
	const run = async () => {
		const { deck, id, notify } = useDeck.getState();
		if (!deck) return;
		setStep([0, deck.slides.length]);
		try {
			const { runAudit } = await import("../lib/audit");
			const r = await runAudit(dir, id, deck, deckTemplate(useSettings.getState().s, deck), (i, n) => setStep([i, n]));
			lastAudit = { dir, report: r };
			setReport(r);
		} catch (e) { notify(String(e), "err"); }
		finally { setStep(null); }
	};
	useEffect(() => { if (!report) run(); }, []);
	// 쪽 안에서는 갈래끼리 모아 보인다 (템플릿 · 배치 · AI 티)
	const order: AuditKind[] = ["template", "layout", "slop"];
	const pick = (k: AuditKind | "all") => (report?.slides || []).map((s) => ({ ...s, findings: s.findings.filter((f) => k === "all" || f.kind === k).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)) })).filter((s) => s.findings.length);
	const shown = pick(kind);
	const count = (k: AuditKind | "all") => pick(k).reduce((n, s) => n + s.findings.length, 0);
	const fix = async () => {
		if (!report) return;
		const { auditFixPrompt } = await import("../lib/audit");
		const text = auditFixPrompt(report, kind === "all" ? undefined : [kind]);
		if (!text) return;
		onDone();
		lastAudit = null;
		useDeck.getState().send(text);
	};
	return (
		<div className="pop audit">
			{step ? (
				<div className="head"><b>{t("auditRunning")}</b><span className="mono">{step[0]}/{step[1]}</span><div className="audit-bar"><i style={{ width: `${step[1] ? (step[0] / step[1]) * 100 : 0}%` }} /></div></div>
			) : report && (
				<>
					<div className="head">
						<b>{count("all") ? t("auditSummary").replace("{s}", String(pick("all").length)).replace("{n}", String(count("all"))) : t("auditClean")}</b>
						<span>{report.template ? t("auditOf").replace("{v}", report.template) : t("auditNoTemplate")}</span>
					</div>
					{count("all") > 0 && (
						<div className="seg audit-kinds" role="group">
							{KINDS.map((x) => <button key={x.k} aria-pressed={kind === x.k} disabled={!count(x.k)} onClick={() => setKind(x.k)}>{t(x.label)} <span className="mono">{count(x.k)}</span></button>)}
						</div>
					)}
					{shown.length > 0 && (
						<div className="audit-list">
							{shown.map((s) => (
								<section key={s.id}>
									<button className="slide-row" onClick={() => useDeck.getState().setCurrent(s.no - 1)} title={s.title}>
										<span className="mono">{s.no}</span><span className="t">{s.title || t("untitled")}</span>
									</button>
									<ul>
										{s.findings.map((f, i) => <li key={i}><span className="k">{t(KINDS.find((x) => x.k === f.kind)!.label)}</span><span>{f.msg}</span></li>)}
									</ul>
								</section>
							))}
						</div>
					)}
					<div className="acts">
						<button className="ghost" onClick={run}>{t("auditAgain")}</button>
						{count(kind) > 0 && <button className="send" onClick={fix}>{t("auditFix")}</button>}
					</div>
				</>
			)}
		</div>
	);
}
