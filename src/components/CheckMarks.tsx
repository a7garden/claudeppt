// 무대 위 점검 표시 · 쪽 여백 안내선 (상태: lib/checkView.ts)
//
//   CheckMarks   걸린 요소에 갈래 색 테두리와 차례 번호. 지금 보는 항목은 진하게, 나머지는 옅게. 누르기는 슬라이드로 지나간다
//   CheckBar     무대 위 띠 — 지금 항목의 갈래 · 한 줄, ◀ ▶ 로 덱 전체를 차례로, 끄기. 점검 뒤 고친 쪽은 자리가 맞지 않아 표시를 걷고 다시 점검을 권한다
//   PageGuides   쪽 설정의 여백 안쪽을 점선으로 — 「쪽 설정 › 여백 안내선 보기」
import { useState } from "react";
import type { AuditKind } from "../lib/audit";
import { flat, hideCheck, runCheck, stepCheck, useCheck, useGuides } from "../lib/checkView";
import { type Key, useT } from "../lib/i18n";
import { deckTemplate, pageMargins } from "../lib/prompt";
import { useSettings } from "../lib/settings";
import { useDeck } from "../lib/store";

const KIND: Record<AuditKind, Key> = { template: "auditKindTemplate", layout: "auditKindLayout", slop: "auditKindSlop", review: "auditKindReview" };

/** 점검한 뒤 이 쪽을 고쳤는가 — 그러면 잰 자리가 지금 모양과 다르다 */
const useStale = (slideId: string) => {
	const rev = useDeck((s) => s.rev[slideId] || 0);
	const then = useCheck((s) => s.revs[slideId] || 0);
	return rev !== then;
};

export function CheckMarks({ slideId, scale }: { slideId: string; scale: number }) {
	const { report, show, active } = useCheck();
	const stale = useStale(slideId);
	const s = report?.slides.find((x) => x.id === slideId);
	if (!show || !s || stale) return null;
	const pad = 3;
	return (
		<div className="check-marks" aria-hidden>
			{s.findings.map((f, i) => {
				const on = active?.slide === slideId && active.i === i;
				const dim = !!active && active.slide === slideId && !on;
				// Claude 검토가 의도한 것으로 본 규칙 결과는 그리지 않는다
				return (f.ok ? [] : f.boxes || []).map((b, j) => (
					<i key={`${i}-${j}`} className={`cm k-${f.kind}${on ? " on" : ""}${dim ? " dim" : ""}`}
						style={{ left: b.x * scale - pad, top: b.y * scale - pad, width: b.w * scale + pad * 2, height: b.h * scale + pad * 2 }}>
						{j === 0 && <b>{i + 1}</b>}
					</i>
				));
			})}
		</div>
	);
}

export function CheckBar({ slideId }: { slideId: string }) {
	const t = useT();
	const { report, show, active } = useCheck();
	const stale = useStale(slideId);
	const [step, setStep] = useState<[number, number, string?] | null>(null);
	if (!show || !report) return null;
	const all = flat(report);
	const k = active ? all.findIndex((x) => x.slide === active.slide && x.i === active.i) : -1;
	const cur = k >= 0 ? all[k] : null;
	const here = report.slides.find((s) => s.id === slideId)?.findings.filter((f) => !f.ok).length ?? 0;
	const again = async () => {
		try { await runCheck((i, n, note) => setStep([i, n, note])); }
		catch (e) { useDeck.getState().notify(String(e), "err"); }
		finally { setStep(null); }
	};
	return (
		<div className="check-bar" role="status">
			<b>{t("audit")}</b>
			{step ? <span className="dim mono">{step[2] ?? `${step[0]}/${step[1]}`}</span>
				: stale && here ? <span className="dim">{t("auditStale")}</span>
				: cur && cur.slide === slideId ? <><span className={"k k-" + cur.f.kind}>{t(KIND[cur.f.kind])}</span><span className="msg" title={cur.f.msg}>{cur.f.msg}</span></>
				: <span className="dim">{here ? t("auditHere").replace("{n}", String(here)) : t("auditNoneHere")}</span>}
			{all.length > 0 && (
				<span className="nav">
					<button onClick={() => stepCheck(-1)} aria-label={t("auditPrev")} title={t("auditPrev")}>‹</button>
					<span className="mono">{k >= 0 ? k + 1 : "-"}/{all.length}</span>
					<button onClick={() => stepCheck(1)} aria-label={t("auditNext")} title={t("auditNext")}>›</button>
				</span>
			)}
			{stale && !step && <button onClick={again}>{t("auditAgain")}</button>}
			<button onClick={hideCheck} title={t("auditHide")}>{t("auditHide")}</button>
		</div>
	);
}

export function PageGuides({ w, h, scale }: { w: number; h: number; scale: number }) {
	const on = useGuides((s) => s.on);
	const deck = useDeck((s) => s.deck);
	const s = useSettings((x) => x.s);
	if (!on || !deck) return null;
	const m = pageMargins(deck, deckTemplate(s, deck));
	if (!m) return null;
	return <div className="page-guides" aria-hidden style={{ left: m.l * scale, top: m.t * scale, width: (w - m.l - m.r) * scale, height: (h - m.t - m.b) * scale }} />;
}
