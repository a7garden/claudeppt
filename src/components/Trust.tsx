// 명부 · 승인 기록 · 주고받기 (2026.11.27, trust.rs · sync.rs): 변경 기록 창 위쪽 한 줄. 펴면 명부와 주고받기가 나온다.
//   명부      누가 승인자인지, 이 PC 를 잃으면 어떻게 되는지. 내 이름 고치기 · 복구 열쇠 만들기 · 복구 열쇠로 되찾기
//   주고받기  묶음 파일로 보내기 · 들이기, 공유 폴더 우편함, 이 PC 에만 있는 변경 알림
//   제안      승인자에게는 남의 제안 · 참여 요청, 승인자가 아닌 사람에게는 승인을 기다리는 내 변경
// 승인자가 한 명이고 열쇠가 이 PC 하나뿐이거나, 이 PC 에만 있는 변경이 있으면 경고색이다
import { open as pickFile, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api, type SyncStatus, type TrustRole, type TrustView } from "../lib/api";
import { tNow, useT } from "../lib/i18n";
import { useDeck } from "../lib/store";
import { copyText } from "./ContextMenu";

const ROLES: TrustRole[] = ["edit", "assigned", "comment", "view", "approve"];

/** 우편함을 정한 덱이면 1분마다 주고받는다. 앱 안 Claude 가 일하는 동안은 건너뛴다(덱 폴더를 판으로 남기므로) */
export function useMailbox(dir: string | null) {
	useEffect(() => {
		if (!dir) return;
		let live = true;
		const tick = async () => {
			const st = useDeck.getState();
			if (!live || st.running || st.dir !== dir) return;
			const r = await api.syncMailboxRun(dir).catch(() => null);
			if (!r || !live) return;
			if (r.received) {
				st.refreshVersions();
				st.notify(tNow("syncMailboxGot").replace("{n}", String(r.received)), "ok");
			}
			if (r.conflicts.length) st.notify(tNow("syncConflicts").replace("{files}", r.conflicts.join(", ")), "err", { sticky: true });
			if (r.errors.length) st.notify(r.errors.join("\n"), "err");
		};
		const first = setTimeout(tick, 5000);
		const every = setInterval(tick, 60000);
		return () => { live = false; clearTimeout(first); clearInterval(every); };
	}, [dir]);
}

export function TrustLine({ dir }: { dir: string }) {
	const t = useT();
	const notify = useDeck((s) => s.notify);
	const head = useDeck((s) => s.versions[0]?.hash);
	const [v, setV] = useState<TrustView | null>(null);
	const [sync, setSync] = useState<SyncStatus | null>(null);
	const [open, setOpen] = useState(false);
	const [secret, setSecret] = useState<string | null>(null);
	const [ask, setAsk] = useState<"name" | "recover" | "join" | null>(null);
	const [text, setText] = useState("");
	const [roles, setRoles] = useState<Record<string, TrustRole>>({});
	const [busy, setBusy] = useState(false);
	const [tick, setTick] = useState(0);

	useEffect(() => {
		let live = true;
		api.trustState(dir).then((x) => { if (live) setV(x); }, () => { if (live) setV(null); });
		api.syncStatus(dir).then((x) => { if (live) setSync(x); }, () => { if (live) setSync(null); });
		return () => { live = false; };
	}, [dir, head, tick]);
	if (!v) return null;

	const me = v.people.find((p) => p.me);
	const approvers = v.people.filter((p) => p.role === "approve");
	const reload = () => { setTick((x) => x + 1); useDeck.getState().refreshVersions(); };
	const run = async (f: () => Promise<void>) => {
		setBusy(true);
		try { await f(); } catch (e) { notify(String(e), "err"); } finally { setBusy(false); reload(); }
	};
	const submit = () => run(async () => {
		if (ask === "name") setV(await api.trustRename(dir, text));
		else if (ask === "recover") { setV(await api.trustRecover(dir, text)); notify(t("trustRecovered"), "ok"); }
		else if (ask === "join") { await api.syncJoin(dir, text); notify(t("syncJoinMade"), "ok"); }
		setAsk(null);
	});
	const makeKey = () => run(async () => { setSecret(await api.trustRecovery(dir)); });
	const exportTo = (full: boolean) => run(async () => {
		const title = useDeck.getState().deck?.title ?? "deck";
		const out = await save({ title: t(full ? "syncExportFull" : "syncExport"), defaultPath: `${title}${full ? " " + t("syncFullSuffix") : ""}.cpptb`, filters: [{ name: t("cpptbName"), extensions: ["cpptb"] }] });
		if (!out) return;
		const made = await api.syncExport(dir, out, full);
		notify(t(made ? "syncExported" : "syncNothing"), "ok");
	});
	const importFrom = () => run(async () => {
		const f = await pickFile({ title: t("syncImport"), filters: [{ name: t("cpptbName"), extensions: ["cpptb"] }] });
		if (typeof f !== "string") return;
		const r = await api.syncImport(dir, f);
		if (r.chain === "foreign" || r.chain === "invalid") notify(t(r.chain === "foreign" ? "chainForeign" : "chainInvalid"), "err", { sticky: true });
		else if (r.conflicts.length) notify(t("syncConflicts").replace("{files}", r.conflicts.join(", ")), "err", { sticky: true });
		else notify(t("syncImported"), "ok");
	});
	const pickBox = () => run(async () => {
		const f = await pickFile({ directory: true, title: t("syncMailbox") });
		if (typeof f === "string") await api.syncMailboxSet(dir, f);
	});
	const runBox = () => run(async () => {
		const r = await api.syncMailboxRun(dir);
		if (r.conflicts.length) notify(t("syncConflicts").replace("{files}", r.conflicts.join(", ")), "err", { sticky: true });
		else if (r.errors.length) notify(r.errors.join("\n"), "err");
		else notify(t("syncMailboxDone").replace("{n}", String(r.received)).replace("{sent}", t(r.sent ? "syncMailboxSent" : "syncMailboxNoSend")), "ok");
	});
	const approve = (key: string, id: string) => run(async () => {
		const left = await api.syncApprove(dir, key, id);
		notify(left.length ? t("syncApproveClash").replace("{files}", left.join(", ")) : t("syncApproved"), left.length ? "err" : "ok", left.length ? { sticky: true } : {});
	});
	const admit = (key: string) => run(async () => {
		await api.syncAdmit(dir, key, roles[key] ?? "edit");
		notify(t("syncAdmitted"), "ok");
	});

	const warn = v.fragile || !v.approver || !!sync?.unsent || !!sync?.behind;
	const theirs = sync?.props.filter((p) => !p.mine) ?? [];
	return (
		<section className={"hist-trust" + (warn ? " warn" : "")}>
			<button className="sum" aria-expanded={open} onClick={() => setOpen(!open)}>
				<span>{t("trustSum").replace("{names}", approvers.map((p) => p.name).join(", ")).replace("{n}", String(v.n))}</span>
				{sync && !sync.member && <b>{t("syncNotMemberShort")}</b>}
				{sync?.member && !v.approver && <b>{t("trustNotApprover")}</b>}
				{v.approver && v.fragile && <b>{t("trustFragile")}</b>}
				{sync?.unsent && <b>{t("syncUnsent")}</b>}
				{sync?.behind && <b>{t("syncBehind")}</b>}
				{v.approver && theirs.length > 0 && <i className="badge">{t("syncPropsN").replace("{n}", String(theirs.length))}</i>}
				{v.approver && !!sync?.joins.length && <i className="badge">{t("syncJoinsN").replace("{n}", String(sync.joins.length))}</i>}
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
					{sync && !sync.member && <p>{t("syncNotMember")}</p>}
					{sync?.member && !v.approver && sync.pending > 0 && <p>{t("syncMyProp").replace("{n}", String(sync.pending))}</p>}
					{!v.sealed && v.approver && <p>{t("trustUnsealed")}</p>}
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
							<input className="field" autoFocus value={text} placeholder={t(ask === "name" ? "trustNamePh" : ask === "join" ? "syncJoinPh" : "trustRecoverPh")} onChange={(e) => setText(e.target.value)} />
							<div className="acts">
								<button type="button" onClick={() => setAsk(null)}>{t("cancel")}</button>
								<button className="send" disabled={busy || !text.trim()}>{t(ask === "name" ? "trustNameGo" : ask === "join" ? "syncJoinGo" : "trustRecoverGo")}</button>
							</div>
						</form>
					) : (
						<div className="acts">
							{me && <button disabled={busy} onClick={() => { setText(me.name); setAsk("name"); }}>{t("trustRename")}</button>}
							{v.approver && <button disabled={busy || !!secret} onClick={makeKey}>{t("trustMakeKey")}</button>}
							{sync && !sync.member && <button className="send" disabled={busy} onClick={() => { setText(""); setAsk("join"); }}>{t("syncJoinMake")}</button>}
							{!v.approver && <button disabled={busy} onClick={() => { setText(""); setAsk("recover"); }}>{t("trustRecover")}</button>}
						</div>
					)}

					{v.approver && theirs.length > 0 && (
						<div className="group">
							<h4>{t("syncPropsTitle")}</h4>
							{theirs.map((p) => (
								<div className="row" key={p.key + p.id}>
									<span>{t("syncPropItem").replace("{name}", p.name).replace("{n}", String(p.ahead)).replace("{at}", p.at.slice(5, 16).replace("T", " "))}</span>
									<button className="send" disabled={busy} onClick={() => approve(p.key, p.id)}>{t("syncApprove")}</button>
								</div>
							))}
						</div>
					)}
					{v.approver && !!sync?.joins.length && (
						<div className="group">
							<h4>{t("syncJoinsTitle")}</h4>
							{sync.joins.map((j) => (
								<div className="row" key={j.key}>
									<span>{j.name}</span>
									<select value={roles[j.key] ?? "edit"} onChange={(e) => setRoles({ ...roles, [j.key]: e.target.value as TrustRole })} aria-label={t("syncRole")}>
										{ROLES.map((r) => <option key={r} value={r}>{t(("trustRole_" + r) as "trustRole_approve")}</option>)}
									</select>
									<button className="send" disabled={busy} onClick={() => admit(j.key)}>{t("syncAdmit")}</button>
								</div>
							))}
						</div>
					)}

					<div className="group">
						<h4>{t("syncTitle")}</h4>
						<p>{sync?.unsent ? t("syncUnsentHint") : sync?.sent_at ? t("syncSentAt").replace("{at}", sync.sent_at.slice(5, 16).replace("T", " ")) : t("syncNeverSent")}</p>
						<div className="acts">
							<button className={sync?.unsent ? "send" : ""} disabled={busy} onClick={() => exportTo(false)}>{t("syncExport")}</button>
							<button disabled={busy} onClick={() => exportTo(true)} title={t("syncExportFullHint")}>{t("syncExportFull")}</button>
							<button disabled={busy} onClick={importFrom}>{t("syncImport")}</button>
						</div>
						<p>{sync?.mailbox ? t("syncMailboxAt").replace("{dir}", sync.mailbox) : t("syncMailboxNone")}</p>
						<div className="acts">
							<button disabled={busy} onClick={pickBox}>{t("syncMailboxPick")}</button>
							{sync?.mailbox && <button disabled={busy} onClick={runBox}>{t("syncMailboxRun")}</button>}
							{sync?.mailbox && <button disabled={busy} onClick={() => run(() => api.syncMailboxSet(dir, null))}>{t("syncMailboxOff")}</button>}
						</div>
					</div>
				</div>
			)}
		</section>
	);
}
