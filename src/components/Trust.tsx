// 명부 · 승인 기록 (2026.11.27, trust.rs): 변경 기록 창 위쪽 한 줄. 누가 이 덱의 승인자인지, 이 PC 를 잃으면 어떻게 되는지를 보인다.
// 1단계에서는 혼자 쓰는 덱이 대부분이라 하는 일은 셋뿐이다: 내 이름 고치기 · 복구 열쇠 만들기 · 복구 열쇠로 이 PC 를 되찾기.
// 승인자가 한 명이고 열쇠가 이 PC 하나뿐이면 늘 경고한다: 그 열쇠를 잃으면 이 덱의 줄기를 아무도 옮기지 못한다
import { useEffect, useState } from "react";
import { api, type TrustView } from "../lib/api";
import { useT } from "../lib/i18n";
import { useDeck } from "../lib/store";
import { copyText } from "./ContextMenu";

export function TrustLine({ dir }: { dir: string }) {
	const t = useT();
	const notify = useDeck((s) => s.notify);
	const head = useDeck((s) => s.versions[0]?.hash);
	const [v, setV] = useState<TrustView | null>(null);
	const [open, setOpen] = useState(false);
	const [secret, setSecret] = useState<string | null>(null);
	const [ask, setAsk] = useState<"name" | "recover" | null>(null);
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let live = true;
		api.trustState(dir).then((x) => { if (live) setV(x); }, () => { if (live) setV(null); });
		return () => { live = false; };
	}, [dir, head]);
	if (!v) return null;

	const me = v.people.find((p) => p.me);
	const approvers = v.people.filter((p) => p.role === "approve");
	const run = async (f: () => Promise<void>) => {
		setBusy(true);
		try { await f(); } catch (e) { notify(String(e), "err"); } finally { setBusy(false); }
	};
	const submit = () => run(async () => {
		if (ask === "name") setV(await api.trustRename(dir, text));
		else if (ask === "recover") { setV(await api.trustRecover(dir, text)); notify(t("trustRecovered"), "ok"); }
		setAsk(null);
	});
	const makeKey = () => run(async () => {
		setSecret(await api.trustRecovery(dir));
		setV(await api.trustState(dir));
	});

	return (
		<section className={"hist-trust" + (v.fragile || !v.approver ? " warn" : "")}>
			<button className="sum" aria-expanded={open} onClick={() => setOpen(!open)}>
				<span>{t("trustSum").replace("{names}", approvers.map((p) => p.name).join(", ")).replace("{n}", String(v.n))}</span>
				{!v.approver && <b>{t("trustNotApprover")}</b>}
				{v.approver && v.fragile && <b>{t("trustFragile")}</b>}
			</button>
			{open && (
				<div className="more">
					<ul>
						{v.people.map((p) => (
							<li key={p.id}>
								<span>{p.name}{p.me && <i className="dim"> · {t("trustMe")}</i>}</span>
								<span className="dim">{t(("trustRole_" + p.role) as "trustRole_approve")} · {t("trustKeys").replace("{n}", String(p.keys))}</span>
							</li>
						))}
					</ul>
					{v.approver && v.fragile && <p>{t("trustFragileHint")}</p>}
					{!v.approver && <p>{t("trustNotApproverHint")}</p>}
					{!v.sealed && <p>{t("trustUnsealed")}</p>}
					{secret && (
						<div className="secret" role="alert">
							<p>{t("trustSecretHint")}</p>
							<code>{secret}</code>
							<div className="acts">
								<button onClick={() => { copyText(secret); notify(t("trustSecretCopied"), "ok"); }}>{t("copy")}</button>
								<button onClick={() => setSecret(null)}>{t("trustSecretDone")}</button>
							</div>
						</div>
					)}
					{ask ? (
						<form onSubmit={(e) => { e.preventDefault(); submit(); }}>
							<input className="field" autoFocus value={text} placeholder={t(ask === "name" ? "trustNamePh" : "trustRecoverPh")} onChange={(e) => setText(e.target.value)} />
							<div className="acts">
								<button type="button" onClick={() => setAsk(null)}>{t("cancel")}</button>
								<button className="send" disabled={busy || !text.trim()}>{t(ask === "name" ? "trustNameGo" : "trustRecoverGo")}</button>
							</div>
						</form>
					) : (
						<div className="acts">
							{me && <button disabled={busy} onClick={() => { setText(me.name); setAsk("name"); }}>{t("trustRename")}</button>}
							{v.approver && <button disabled={busy || !!secret} onClick={makeKey}>{t("trustMakeKey")}</button>}
							{!v.approver && <button className="send" disabled={busy} onClick={() => { setText(""); setAsk("recover"); }}>{t("trustRecover")}</button>}
						</div>
					)}
				</div>
			)}
		</section>
	);
}
