// 제목 줄 오른쪽 — 내보내기(PPTX · CPPT 묶음 · 폴더 열기)와 릴리즈. 누른 단추 아래에 작은 띄움 상자로 편다.
import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { api, join } from "../lib/api";
import { safeName } from "../lib/deck";
import { useT } from "../lib/i18n";
import { useDeck } from "../lib/store";

export default function DeckActions() {
	const t = useT();
	const [open, setOpen] = useState<"" | "export" | "release">("");
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
		<div ref={ref} style={{ display: "flex", gap: 2 }}>
			<button className={"tb-btn" + (open === "export" ? " on" : "")} onClick={() => setOpen(open === "export" ? "" : "export")} disabled={busy}>{t("export")}</button>
			<button className={"tb-btn" + (open === "release" ? " on" : "")} onClick={() => setOpen(open === "release" ? "" : "release")} disabled={busy}>{t("release")}</button>
			{open === "export" && <ExportPop onDone={() => setOpen("")} />}
			{open === "release" && <ReleasePop onDone={() => setOpen("")} />}
		</div>
	);
}

function ExportPop({ onDone }: { onDone: () => void }) {
	const t = useT();
	const { deck, dir, versions, exportTo, notify } = useDeck.getState();
	const n = versions[0]?.n ?? 0;
	const base = `${safeName(deck!.title)}_v${n}`;
	return (
		<div className="pop" style={{ right: 210 }}>
			<div className="menu">
				<button onClick={async () => { onDone(); const p = await save({ defaultPath: base + ".pptx", filters: [{ name: "PowerPoint", extensions: ["pptx"] }] }); if (p) exportTo(p); }}>
					{t("pptx")}<span>{t("editable")}</span>
				</button>
				<button onClick={async () => { onDone(); const p = await save({ defaultPath: base + "_exact.pptx", filters: [{ name: "PowerPoint", extensions: ["pptx"] }] }); if (p) exportTo(p, true); }}>
					{t("pptx")}<span>{t("exact")}</span>
				</button>
				<button onClick={async () => {
					onDone();
					const p = await save({ defaultPath: base + ".cppt", filters: [{ name: "ClaudePPT", extensions: ["cppt"] }] });
					if (p) { await api.commit(dir, t("direct")).catch(() => {}); await api.pack(dir, p).then(() => notify(p.split(/[\\/]/).pop()!), (e) => notify(String(e), "err")); }
				}}>
					{t("cppt")}<span>.cppt</span>
				</button>
				<button onClick={() => { onDone(); useDeck.getState().check(); }}>
					{t("compare")}<span>{t("web")} ↔ PPT · C</span>
				</button>
				<button onClick={() => { onDone(); api.reveal(join(dir, "deck.json")); }}>
					{t("folder")}<span>↗</span>
				</button>
			</div>
		</div>
	);
}

function ReleasePop({ onDone }: { onDone: () => void }) {
	const t = useT();
	const releases = useDeck((s) => s.releases);
	const versions = useDeck((s) => s.versions);
	const release = useDeck((s) => s.release);
	const dir = useDeck((s) => s.dir);
	const [name, setName] = useState("");
	const [notes, setNotes] = useState("");
	const next = `r${releases.length + 1}`;
	return (
		<div className="pop" style={{ right: 150 }}>
			<div className="k">{next} · v{(versions[0]?.n ?? 0) + 1}</div>
			<input className="field" autoFocus placeholder={t("name")} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { onDone(); release(name, notes); } }} />
			<textarea className="field" rows={3} placeholder={t("notes")} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ fontFamily: "var(--ui)", fontSize: 13 }} />
			<div className="acts">
				<button className="ghost" onClick={onDone}>{t("cancel")}</button>
				<button className="send" onClick={() => { onDone(); release(name, notes); }}>{t("confirm")}</button>
			</div>
			{releases.length > 0 && (
				<div className="rels">
					{[...releases].reverse().map((r) => (
						<div key={r.tag}>
							<span className="mono" style={{ color: "var(--accent)" }}>{r.tag}</span>
							<span>{r.name}</span>
							<button className="mono" title={r.file} onClick={() => api.reveal(join(dir, r.file))}>v{r.n} ↗</button>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
