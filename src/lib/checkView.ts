// 점검 결과를 무대에 보이는 상태 — 마지막 점검 · 지금 보는 항목 · 표시 켜짐. 점검 엔진(audit.ts)은 쓸 때 불러오므로 상태는 여기 따로 둔다.
//
//   report   마지막 점검 결과 (덱마다 하나 — 덱이 바뀌면 걷는다)
//   revs     점검할 때 쪽마다의 고친 횟수(store.rev). 그 뒤 고친 쪽은 표시 자리가 맞지 않을 수 있어 상자를 걷고 「다시 점검」을 권한다
//   active   지금 보는 항목 — 쪽 id 와 그 쪽 안 차례. 무대 띠의 ◀ ▶ 가 덱 전체를 차례로 넘긴다
import { create } from "zustand";
import type { AuditKind, AuditReport } from "./audit";
import { deckTemplate, pageMargins } from "./prompt";
import { useSettings } from "./settings";
import { useDeck } from "./store";

interface V {
	dir: string;
	report: AuditReport | null;
	revs: Record<string, number>;
	active: { slide: string; i: number } | null;
	show: boolean;
}
export const useCheck = create<V>()(() => ({ dir: "", report: null, revs: {}, active: null, show: false }));

export function setReport(dir: string, report: AuditReport) {
	useCheck.setState({ dir, report, revs: { ...useDeck.getState().rev }, active: null, show: true });
}

/** 덱 전체의 항목을 한 줄로 — ◀ ▶ 차례. Claude 검토가 의도한 것으로 본 것(ok)은 건너뛴다 */
export function flat(r: AuditReport | null) {
	return (r?.slides || []).flatMap((s) => s.findings.map((f, i) => ({ slide: s.id, no: s.no, i, f })).filter((x) => !x.f.ok));
}

/** 그 항목으로 — 그 쪽으로 가고 걸린 요소를 강조한다 */
export function focus(slide: string, i: number) {
	const d = useDeck.getState();
	const at = d.deck?.slides.findIndex((s) => s.id === slide) ?? -1;
	if (at >= 0) d.setCurrent(at);
	useCheck.setState({ active: { slide, i }, show: true });
}

export function stepCheck(by: 1 | -1) {
	const { report, active } = useCheck.getState();
	const all = flat(report);
	if (!all.length) return;
	const k = active ? all.findIndex((x) => x.slide === active.slide && x.i === active.i) : -1;
	const n = all[(k + by + all.length) % all.length];
	focus(n.slide, n.i);
}

export const hideCheck = () => useCheck.setState({ show: false, active: null });

/** 점검을 돌린다 — 점검 상자의 「점검 시작」 · 「다시 점검」과 무대 띠의 「다시 점검」이 같은 길이다. kinds 를 주지 않으면 지난번 갈래 */
export async function runCheck(step: (i: number, n: number, note?: string) => void, kinds?: AuditKind[]) {
	const { deck, dir, id } = useDeck.getState();
	if (!deck) return null;
	const { runAudit } = await import("./audit");
	const tpl = deckTemplate(useSettings.getState().s, deck);
	const r = await runAudit(dir, id, deck, tpl, step, { kinds: kinds ?? useCheck.getState().report?.kinds, margins: pageMargins(deck, tpl) });
	setReport(dir, r);
	return r;
}

/** 쪽 여백 안내선 — 보는 사람 몫이라 이 PC 에만 기억한다 */
const GUIDES = "cppt.pageGuides";
export const useGuides = create<{ on: boolean; set: (on: boolean) => void }>()((set) => ({
	on: (() => { try { return localStorage.getItem(GUIDES) === "1"; } catch { return false; } })(),
	set: (on) => { set({ on }); try { localStorage.setItem(GUIDES, on ? "1" : "0"); } catch {} },
}));

// 다른 덱을 열면 걷는다
let lastDir = "";
useDeck.subscribe((s) => {
	if (s.dir === lastDir) return;
	lastDir = s.dir;
	if (useCheck.getState().dir !== s.dir) useCheck.setState({ dir: s.dir, report: null, revs: {}, active: null, show: false });
});
