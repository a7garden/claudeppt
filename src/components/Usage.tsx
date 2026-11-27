// Claude 남은 사용량 — 대화 머리의 칩(UsageChip)과 「설정 › Claude」의 줄(UsageRows). 값은 lib/usage.ts 가 묻는다.
// 칩은 가장 많이 쓴 한도 하나의 남은 % 만 보인다 — 실제로 먼저 막히는 것이 그것이다. 누르면 한도마다 펼친다.
import { useEffect, useRef, useState } from "react";
import type { UsageWindow } from "../lib/api";
import { useT } from "../lib/i18n";
import { useSettings } from "../lib/settings";
import { remote } from "../lib/transport";
import { untilReset, useUsage, useUsagePoll } from "../lib/usage";

/** 80% 넘게 쓰면 경고색 — 한 턴이 길면 남은 20% 를 금방 쓴다 */
const LOW = 80;

function useLabels() {
	const t = useT();
	const lang = useSettings((x) => x.s.lang);
	const name = (w: UsageWindow) => (w.key === "five_hour" ? t("usage5h") : w.model ? t("usageWeekModel").replace("{m}", w.model) : t("usageWeek"));
	const reset = (w: UsageWindow) => {
		const r = untilReset(w.resets_at);
		if (!r) return null;
		if ("at" in r) return t("usageResetAt").replace("{t}", r.at.toLocaleString(lang === "ko" ? "ko-KR" : "en-US", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }));
		const h = Math.floor(r.mins / 60), m = r.mins % 60;
		return t("usageResetIn").replace("{t}", h ? t("usageHM").replace("{h}", String(h)).replace("{m}", String(m)) : t("usageM").replace("{m}", String(m)));
	};
	const left = (w: UsageWindow) => t("usageLeft").replace("{n}", String(Math.round(100 - w.used)));
	return { t, lang, name, reset, left };
}

function Meter({ used }: { used: number }) {
	return <span className={"usage-meter" + (used >= LOW ? " low" : "")} aria-hidden><i style={{ width: `${Math.max(0, 100 - used)}%` }} /></span>;
}

/** 한도 목록 — 칩의 팝업과 설정이 함께 쓴다 */
function Windows() {
	const { name, reset, left } = useLabels();
	const ok = useUsage((s) => s.ok);
	if (!ok) return null;
	return (
		<div className="usage-list">
			{ok.windows.map((w) => (
				<div key={w.key} className="usage-win">
					<div className="usage-line"><b>{name(w)}</b><span className={"mono" + (w.used >= LOW ? " low" : "")}>{left(w)}</span></div>
					<Meter used={w.used} />
					{reset(w) && <div className="note">{reset(w)}</div>}
				</div>
			))}
		</div>
	);
}

/** 상태 한 줄 — 받지 못했을 때 까닭 · 받았으면 몇 시 기준인지 */
function Status() {
	const { t, lang } = useLabels();
	const last = useUsage((s) => s.last);
	const ok = useUsage((s) => s.ok);
	if (!last) return <span className="note">…</span>;
	if (last.state === "none") return <span className="note" style={{ whiteSpace: "normal" }}>{t("usageNone")}</span>;
	const why = last.state === "expired" ? t("usageExpired") : last.state === "error" ? `${t("usageError")}${last.error ? ` (${last.error})` : ""}` : null;
	const at = ok ? t("usageAt").replace("{t}", new Date(ok.at).toLocaleTimeString(lang === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit" })) : null;
	return <span className={"note" + (why ? " warn" : "")} style={{ whiteSpace: "normal" }}>{why ?? at}{why && at ? ` · ${at}` : ""}</span>;
}

function Refresh() {
	const { t } = useLabels();
	const busy = useUsage((s) => s.busy);
	return <button className="ghost" disabled={busy} onClick={() => useUsage.getState().load(true)}>{busy ? "…" : t("usageRefresh")}</button>;
}

export function UsageChip() {
	useUsagePoll();
	const { t, name, left } = useLabels();
	const ok = useUsage((s) => s.ok);
	const ref = useRef<HTMLSpanElement>(null);
	const [open, setOpen] = useState(false);
	useEffect(() => {
		if (!open) return;
		const k = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
		const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
		addEventListener("mousedown", k);
		addEventListener("keydown", esc);
		return () => { removeEventListener("mousedown", k); removeEventListener("keydown", esc); };
	}, [open]);
	if (remote || !ok?.windows.length) return null;
	const top = ok.windows.reduce((a, b) => (b.used > a.used ? b : a));
	return (
		<span className="usage" ref={ref}>
			<button className={"usage-chip" + (open ? " on" : "")} onClick={() => setOpen(!open)} aria-expanded={open} title={`${t("usageTitle")}: ${name(top)} ${left(top)}`}>
				<Meter used={top.used} />
				<span className="mono">{Math.round(100 - top.used)}%</span>
			</button>
			{open && (
				<div className="pop usage-pop" role="dialog" aria-label={t("usageTitle")}>
					<div className="head"><b>{t("usageTitle")}</b></div>
					<Windows />
					<div className="usage-foot"><Status /><Refresh /></div>
				</div>
			)}
		</span>
	);
}

/** 「설정 › Claude」의 사용량 줄 */
export function UsageRows({ Row }: { Row: (p: { k: string; children: React.ReactNode }) => React.ReactElement }) {
	useUsagePoll();
	const { t } = useLabels();
	if (remote) return null;
	return (
		<>
			<Row k={t("usage")}><div style={{ flex: 1, display: "grid", gap: 8 }}><Windows /><div className="usage-foot"><Status /><Refresh /></div></div></Row>
			<Row k=""><span className="note" style={{ whiteSpace: "normal" }}>{t("usageNote")}</span></Row>
		</>
	);
}
