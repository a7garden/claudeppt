// 팀 협업 화면 조각 — 제목 줄 「공유」(공유 창) · 쪽 목록 · 무대의 「보는 사람」 표시 (상태: lib/collab.ts)
//   2026.11.27 : 쪽 담당 · 권한 — 쪽 목록의 담당 표시(AssignTag) · 쪽 우클릭 「담당」(assignItems) · 공유 창 사람마다 권한 고르기 · 팀원 창 「내 담당」
import { ask } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { assignedTo, collabKick, collabLimit, collabLinkNew, collabLinkRemove, collabLock, collabRole, collabTools, follow, ROLES, type Role, setShareClaude, setVia, type InviteLink, type TunnelTools, type Member, startHost, stopHost, useCollab, useRole } from "../lib/collab";
import { useT } from "../lib/i18n";
import { useSettings } from "../lib/settings";
import { useDeck } from "../lib/store";
import { remote } from "../lib/transport";
import { copyText, type MenuItem } from "./ContextMenu";

/** 사람 머리글자 — 한글 이름은 앞 글자, 영어는 첫 글자 대문자 */
const initial = (name: string) => (name.trim()[0] || "?").toUpperCase();

/** 같은 이름이 같은 색이 되게 — 주홍(핀 색)은 쓰지 않는다 */
const HUES = [210, 150, 265, 45, 185, 320, 95];
const hue = (name: string) => HUES[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];

/** 나를 뺀 다른 사람들. 호스트 앱은 호스트(conn 0)가 나, 브라우저는 서버가 준 번호가 나 */
export function useOthers(): Member[] {
	const { members, conn } = useCollab();
	return members.filter((m) => (remote ? m.conn !== conn : !m.host));
}

export function Face({ m, small }: { m: Member; small?: boolean }) {
	const t = useT();
	const name = m.name || t("collabNoName");
	return (
		<i className={"face" + (small ? " sm" : "")} style={{ "--h": hue(name) } as React.CSSProperties} title={name + (m.host ? ` (${t("collabHostTag")})` : "")}>
			{initial(name)}
		</i>
	);
}

/** 쪽 목록 번호 옆 — 이 쪽을 보는 다른 사람 머리글자 */
export function SlideFaces({ slideId }: { slideId: string }) {
	const others = useOthers().filter((m) => m.slide === slideId);
	if (!others.length) return null;
	return (
		<span className="faces">
			{others.slice(0, 3).map((m) => <Face key={m.conn} m={m} small />)}
			{others.length > 3 && <i className="face sm more">+{others.length - 3}</i>}
		</span>
	);
}

/** 쪽 목록 번호 옆 — 이 쪽을 맡은 사람 머리글자 (보는 사람 얼굴과 달리 네모). 내가 맡은 쪽이면 진하게 */
export function AssignTag({ slideId }: { slideId: string }) {
	const t = useT();
	const names = useDeck((s) => s.assign[slideId]);
	const me = useSettings((s) => s.s.me.trim());
	if (!names?.length) return null;
	return (
		<span className={"assign-tag" + (names.includes(me) ? " mine" : "")} title={`${t("assignBy")} · ${names.join(", ")}`}>
			{names.slice(0, 2).map((n) => <i key={n} style={{ "--h": hue(n) } as React.CSSProperties}>{initial(n)}</i>)}
			{names.length > 2 && <i className="more">+{names.length - 2}</i>}
		</span>
	);
}

/** 쪽 우클릭 「담당」 — 덱 주인이 공유 중일 때, 들어온 적 있는 사람마다 한 줄(누르면 맡기기 · 풀기). 같은 이름의 기기는 한 사람이다 */
export function assignItems(slideId: string, t: ReturnType<typeof useT>): MenuItem[] {
	const info = useCollab.getState().info;
	if (remote || !info) return [];
	const st = useDeck.getState();
	const cur = st.assign[slideId] ?? [];
	const names = [...new Set(info.devices.map((d) => d.name))];
	if (!names.length) return [];
	return [
		"-",
		...names.map((n): MenuItem => ({ label: `${t("assignBy")} · ${n}`, checked: cur.includes(n), run: () => st.setAssign(slideId, cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n]) })),
		...(cur.length ? [{ label: t("assignClear"), run: () => st.setAssign(slideId, []) }] : []),
	];
}

/** 담당표 (2026.11.27) — 쪽마다 맡은 사람을 한 표로. 덱 주인 앱(공유 중)은 칸을 눌러 맡기고 풀고, 팀원 화면은 보기만.
 *  쪽 번호를 누르면 그 쪽으로. 사람은 들어온 적 있는 사람(덱 주인 앱) · 맡은 쪽이 있는 사람 */
export function AssignBoard({ onClose }: { onClose: () => void }) {
	const t = useT();
	const deck = useDeck((s) => s.deck);
	const assign = useDeck((s) => s.assign);
	const current = useDeck((s) => s.current);
	const info = useCollab((c) => c.info);
	const host = !remote && !!info;
	const names = useMemo(() => [...new Set([...(host ? info!.devices.map((d) => d.name) : []), ...Object.values(assign).flat()])].sort((a, b) => a.localeCompare(b)), [host, info, assign]);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const k = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.(".rail-board")) onClose(); };
		const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
		addEventListener("mousedown", k);
		addEventListener("keydown", esc);
		return () => { removeEventListener("mousedown", k); removeEventListener("keydown", esc); };
	}, [onClose]);
	if (!deck) return null;
	const st = useDeck.getState();
	return (
		<div className="pop assign-board" ref={ref} role="dialog" aria-label={t("assignBoard")}>
			<div className="head"><b>{t("assignBoard")}</b><span className="dim">{t(host ? "assignBoardHost" : "assignBoardView")}</span></div>
			{names.length === 0 ? <p className="dim">{t("assignBoardEmpty")}</p> : (
				<div className="grid-wrap">
					<table>
						<thead>
							<tr>
								<th />
								{names.map((n) => (
									<th key={n} title={n}>
										<i style={{ "--h": hue(n) } as React.CSSProperties}>{initial(n)}</i>
										<span>{n}</span>
										<small>{deck.slides.filter((s) => assign[s.id]?.includes(n)).length}</small>
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{deck.slides.map((sl, i) => {
								const cur = assign[sl.id] ?? [];
								return (
									<tr key={sl.id} className={(i === current ? "on" : "") + (cur.length ? "" : " none")}>
										<th>
											<button className="mono" onClick={() => st.setCurrent(i)}>{i + 1}</button>
											<span className="ttl">{sl.hidden ? t("slideLocked") : sl.title || ""}</span>
										</th>
										{names.map((n) => {
											const on = cur.includes(n);
											return (
												<td key={n}>
													{host
														? <button aria-pressed={on} aria-label={`${i + 1} · ${n}`} onClick={() => st.setAssign(sl.id, on ? cur.filter((x) => x !== n) : [...cur, n])}><i style={on ? ({ "--h": hue(n) } as React.CSSProperties) : undefined} /></button>
														: on && <i style={{ "--h": hue(n) } as React.CSSProperties} />}
												</td>
											);
										})}
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

/** 권한 이름 — 고르기 · 팀원 창 */
const roleKey = (r: Role) => ({ edit: "roleEdit", assigned: "roleAssigned", comment: "roleComment", view: "roleView" } as const)[r];

/** 맡은 쪽 번호 단추들 — 누르면 그 쪽으로 */
function AssignedSlides({ name }: { name: string }) {
	const t = useT();
	const deck = useDeck((s) => s.deck);
	useDeck((s) => s.assign);
	const setCurrent = useDeck((s) => s.setCurrent);
	const ids = assignedTo(name);
	if (!deck) return null;
	if (!ids.length) return <span className="dim">{t("assignNone")}</span>;
	return (
		<span className="assigned">
			{ids.map((id) => {
				const i = deck.slides.findIndex((s) => s.id === id);
				return <button key={id} className="mono" onClick={() => setCurrent(i)} title={deck.slides[i]?.title || undefined}>{i + 1}</button>;
			})}
		</span>
	);
}

/** 무대 위 — 이 쪽을 다른 사람이 방금(8초 안) 손으로 고쳤으면 「○○ 님이 고치는 중」. 같은 요소를 둘이 고치면 나중 것이 남는다 */
export function EditingNote({ slideId }: { slideId: string }) {
	const t = useT();
	const e = useDeck((s) => s.editing[slideId]);
	const mine = useSettings((s) => s.s.me.trim());
	const [, tick] = useState(0);
	const fresh = !!e && e.by !== mine && Date.now() - e.at < 8000;
	useEffect(() => {
		if (!fresh) return;
		const id = setTimeout(() => tick((n) => n + 1), 8000 - (Date.now() - e!.at) + 50);
		return () => clearTimeout(id);
	}, [fresh, e?.at]);
	if (!fresh) return null;
	return <div className="editing-note" role="status">{t("collabEditing").replace("{name}", e!.by)}</div>;
}

/** 무대 위 — 이 쪽을 함께 보는 사람 · 다른 쪽을 보는 사람. 누르면 그 사람을 따라간다(그 사람이 넘기면 같이 넘어간다).
 *  다시 누르거나 내가 쪽을 옮기면 풀린다. 발표자를 따라 보는 회의에서 쪽마다 얼굴을 누르지 않게 */
export function StageFaces({ slideId }: { slideId: string }) {
	const t = useT();
	const others = useOthers();
	const deck = useDeck((s) => s.deck);
	const following = useCollab((s) => s.follow);
	if (!others.length || !deck) return null;
	const lead = others.find((m) => m.conn === following);
	return (
		<div className="stage-faces" role="group" aria-label={t("collabViewing")}>
			{lead && <span className="following" role="status">{t("collabFollowing").replace("{name}", lead.name || t("collabNoName"))}</span>}
			{others.map((m) => {
				const here = m.slide === slideId;
				const no = deck.slides.findIndex((s) => s.id === m.slide) + 1;
				const on = m.conn === following;
				const name = m.name || t("collabNoName");
				return (
					<button key={m.conn} className={(here ? "here" : "") + (on ? " on" : "")} onClick={() => follow(on ? null : m.conn)} aria-pressed={on} title={on ? t("collabUnfollow").replace("{name}", name) : t("collabFollow").replace("{name}", name)}>
						<Face m={m} />
						{!here && no > 0 && <span className="mono">{no}</span>}
					</button>
				);
			})}
		</div>
	);
}

/** 제목 줄 「공유」 (2026.11.26) — 덱 주인 앱: 꺼져 있으면 「공유」, 켜져 있으면 「공유 중 · n명」. 누르면 공유 창(켜기 · 초대 링크 · 들어온 사람 · 끝내기).
 *  공유 덱 창(팀원): 연결 상태와 사람 수. 누르면 누가 어디를 보는지.
 *  예전에는 「설정 › 협업」의 「브라우저로 같이 보기」 체크칸이었다 — 공유는 덱을 보다가 하는 일이라 덱 곁에 둔다 */
export function CollabChip() {
	const t = useT();
	const { info, members, connected, ended, kicked } = useCollab();
	const deck = useDeck((s) => s.deck);
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		if (!open) return;
		const k = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
		addEventListener("mousedown", k);
		return () => removeEventListener("mousedown", k);
	}, [open]);
	if (!remote && !info && !deck) return null;
	const off = remote && (!connected || ended);
	const label = remote
		? off ? (kicked ? t("collabKicked") : ended ? t("collabEnded") : t("collabOffline")) : t("collabCount").replace("{n}", String(members.length))
		: info ? t("shareOn").replace("{n}", String(members.filter((m) => !m.host).length)) : t("shareBtn");
	return (
		<span className="collabwrap" ref={ref}>
			<button className={"tb-btn collab-chip" + (off ? " off" : "")} onClick={() => setOpen(!open)} aria-expanded={open} title={remote ? t("collabMembers") : t("shareTitle")}>
				{(remote || info) && <span className="dot" aria-hidden />}
				{label}
			</button>
			{open && (remote ? <MembersPop /> : <div className="pop share" role="dialog" aria-label={t("shareTitle")}><SharePanel /></div>)}
		</span>
	);
}

/** 공유 덱 창 — 내 권한 · 내가 맡은 쪽, 그리고 누가 어디를 보는지 */
function MembersPop() {
	const t = useT();
	const { members } = useCollab();
	const deck = useDeck((s) => s.deck);
	const role = useRole();
	const me = useSettings((s) => s.s.me.trim());
	return (
		<div className="pop collab-pop" role="dialog" aria-label={t("collabMembers")}>
			<section className="my-role">
				<div className="row"><span className="lbl">{t("roleMine")}</span><b>{t(roleKey(role))}</b></div>
				<p className="note">{t((roleKey(role) + "Note") as "roleEditNote")}</p>
				<div className="row"><span className="lbl">{t("assignMineH")}</span><AssignedSlides name={me} /></div>
				{members.find((m) => m.conn === useCollab.getState().conn)?.limit && <p className="note">{t("limitMine")}</p>}
			</section>
			{members.length === 0 && <p className="dim">{t("collabNobody")}</p>}
			{members.map((m) => {
				const no = deck ? deck.slides.findIndex((s) => s.id === m.slide) + 1 : 0;
				return (
					<div className="row" key={m.conn}>
						<Face m={m} />
						<span className="nm">{m.name || t("collabNoName")}{m.host && <em> · {t("collabHostTag")}</em>}{m.runner && <em title={t("runnerUseHint")}> · {t("runnerMine")}</em>}</span>
						<span className="dim mono">{no > 0 ? `${no}${t("slideN") === "쪽" ? "쪽" : ""}` : ""}</span>
					</div>
				);
			})}
		</div>
	);
}

/** 공유 창 — 맨 위에서 링크를 어떻게 내줄지(앱 · 웹 사무실 · 웹 어디서나) 고르고, 그 아래 초대 링크 하나. 꺼져 있으면 고른 길로 시작.
 *  「설정 › 협업」도 같은 것을 쓴다(bare: 제목 · 이름 칸은 설정 쪽 줄이 맡는다) — 2026.11.27 : 공유를 제목 줄에만 두니 덱을 열기 전에는 공유를 만들 곳이 없었다.
 *  2026.11.27 : 「브라우저로 들어오게 하기」 펼침(사무실 망 · 바깥 길 따로 켜기)을 세 갈래 고르기로 바꿨다 — 링크가 어느 길 것인지 한눈에 보이고 바꾸기도 한 번이다 */
export function SharePanel({ bare }: { bare?: boolean }) {
	const t = useT();
	const { info, members } = useCollab();
	const me = useSettings((s) => s.s.me);
	const via = useSettings((s) => s.s.collab.via);
	const shareClaude = useSettings((s) => s.s.collab.shareClaude);
	const deck = useDeck((s) => s.deck);
	const dir = useDeck((s) => s.dir);
	const notify = useDeck((s) => s.notify);
	const [busy, setBusy] = useState(false);
	const [more, setMore] = useState(false);
	const [who, setWho] = useState("");
	const [hours, setHours] = useState(0);
	const [tools, setTools] = useState<TunnelTools | null>(null);
	useEffect(() => { collabTools().then(setTools, () => {}); }, []);
	const run = async (f: () => Promise<unknown>) => {
		setBusy(true);
		try { await f(); } catch (e) { notify(String(e), "err"); } finally { setBusy(false); }
	};
	const copy = (url: string) => { copyText(url); notify(t("collabCopied"), "ok"); };
	const setMe = (v: string) => useSettings.getState().set((x) => ({ ...x, me: v }));
	const noTools = !!tools && !tools.tailscale && !tools.cloudflared;

	const pick = (
		<div className="share-via" role="radiogroup" aria-label={t("shareVia")}>
			{(["app", "office", "internet"] as const).map((v) => (
				<button key={v} role="radio" aria-checked={via === v} disabled={busy || (v === "internet" && noTools && via !== v)} title={v === "internet" && noTools ? t("collabNoTools") : undefined}
					onClick={() => via !== v && run(() => setVia(v))}>
					<b>{t(v === "app" ? "shareViaApp" : v === "office" ? "shareViaOffice" : "shareViaInternet")}</b>
					<span>{t(v === "app" ? "shareViaAppSub" : v === "office" ? "shareViaOfficeSub" : "shareViaInternetSub")}</span>
				</button>
			))}
		</div>
	);
	// 세션 · Claude 를 함께 쓸지 (2026.11.27) — 기본은 꺼짐: 앱 팀원은 저마다 자기 PC 의 Claude 와 자기 세션
	const claude = (
		<label className="check share-claude">
			<input type="checkbox" checked={shareClaude} onChange={() => setShareClaude(!shareClaude)} />
			<span>{t("shareClaude")}<small>{t(shareClaude ? "shareClaudeOn" : "shareClaudeOff")}</small></span>
		</label>
	);

	if (!info) {
		return (
			<>
				{!bare && <b className="share-h">{t("shareTitle")}</b>}
				<p className="note">{t("shareIntro")}</p>
				{/* 공유는 덱 하나에 묶인다 (2026.11.27) — 무엇이 나가는지 켜기 전에 보인다 */}
				<p className="note">{deck ? t("shareThisDeck").replace("{title}", deck.title) : t("shareNeedDeck")}</p>
				{pick}
				{via === "internet" && noTools && <p className="note">{t("collabNoTools")}</p>}
				{claude}
				{!bare && (
					<label className="share-name">
						<span>{t("myName")}</span>
						<input className="field" value={me} placeholder={t("myNamePh")} onChange={(e) => setMe(e.target.value)} />
					</label>
				)}
				<button className="send share-go" disabled={busy || !deck} onClick={() => run(async () => {
					// 공유는 팀원 세션(요청 · 판에 보낸 사람)과 함께 간다 — 「설정 › 협업 쓰기」를 같이 켠다
					useSettings.getState().set((x) => ({ ...x, collab: { ...x.collab, on: true } }));
					await startHost();
				})}>{busy ? t("shareStarting") : t("shareStart")}</button>
			</>
		);
	}

	// 다른 덱을 보고 있다 — 공유한 덱은 그대로 두고(팀원에게는 「자리 비움」), 바꾸려면 끄고 이 덱으로 다시 켠다
	const other = info.deck.dir !== dir && (
		<section className="share-other">
			<p className="note">{t("shareOther").replace("{title}", info.deck.title)}</p>
			{deck && <button disabled={busy} title={t("shareSwitchNote")} onClick={() => run(async () => { await stopHost(); await startHost(); })}>{t("shareSwitch")}</button>}
		</section>
	);

	// 고른 길이 실제로 열려 있나 — 바깥 길이 끊겼거나 여는 중이면 링크 대신 그 까닭
	const ready = via === "app" ? !!info.app : via === "office" ? info.lan : !!info.tunnel;
	const linkOf = (l: InviteLink) => (via === "app" ? l.app : l.url);
	const pub = info.links.find((l) => !l.name && !l.expired) ?? info.links[0];
	const link = pub && ready ? linkOf(pub) : null;
	const online = (id: string) => members.find((m) => m.device === id);
	const slideNo = (id: string | null) => (deck && id ? deck.slides.findIndex((s) => s.id === id) + 1 : 0);
	const expiry = (l: InviteLink) => (l.expired ? t("collabExpired") : l.expires ? t("collabUntil").replace("{at}", new Date(l.expires).toLocaleString()) : t("collabNoExpiry"));
	// 지금 들어와 있는 사람이 위로
	const people = [...info.devices].sort((a, b) => Number(!!online(b.id)) - Number(!!online(a.id)));
	const note =
		via === "app" ? t("shareViaAppNote")
		: via === "office" ? `${t("shareViaOfficeNote")} ${t("collabFirewall")}`
		: `${t("shareViaInternetNote")}${info.tunnel?.kind === "cloudflare" ? ` ${t("collabCloudflareNote")}` : ""}`;
	return (
		<>
			{other}
			{pick}
			<section className="share-link">
				<span className="lbl">{t("shareLink")}</span>
				{link ? (
					<div className="field-row">
						<input className="field mono" readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label={t("shareLink")} />
						<button className="send" onClick={() => copy(link)}>{t("collabCopy")}</button>
					</div>
				) : <p className="note">{via === "app" ? t("shareNoApp") : via === "internet" && noTools ? t("collabNoTools") : t("shareViaClosed")}</p>}
				<p className="note">{note}</p>
				{via !== "app" && <p className="note">{t("shareViaWebAlso")}</p>}
			</section>
			{claude}

			<section className="collab-members">
				<span className="lbl">{t("collabPeople")}</span>
				{people.length === 0 && <p className="dim">{t("collabNobody")}</p>}
				{people.map((d) => {
					const m = online(d.id);
					const no = slideNo(m?.slide ?? null);
					return (
						<div className="row" key={d.id}>
							<Face m={{ conn: 0, device: d.id, name: d.name, slide: null, host: false, since: d.seen }} />
							<span className="nm">{d.name}{m?.runner && <em title={t("runnerUseHint")}> · {t("runnerMine")}</em>}</span>
							<span className={"st" + (m ? " on" : "")}>{m ? (no > 0 ? `${t("collabOnline")} · ${no}${t("slideN") === "쪽" ? "쪽" : ""}` : t("collabOnline")) : new Date(d.seen).toLocaleDateString()}</span>
							<button className="rm" disabled={busy} title={t("collabKickHint")}
								onClick={async () => { if (await ask(t("collabKickAsk").replace("{name}", d.name), { title: t("collabKick"), kind: "warning", okLabel: t("collabKick"), cancelLabel: t("cancel") })) run(() => collabKick(d.id)); }}>{t("collabKick")}</button>
							{/* 권한 · 맡은 쪽 (2026.11.27) — 담당은 쪽 목록에서 쪽을 우클릭해 정한다 */}
							<div className="perm">
								<select className="field" value={d.role} disabled={busy} aria-label={`${d.name} · ${t("roleH")}`} title={t((roleKey(d.role) + "Note") as "roleEditNote")}
									onChange={(e) => run(() => collabRole(d.id, e.target.value as Role))}>
									{ROLES.map((r) => <option key={r} value={r}>{t(roleKey(r))}</option>)}
								</select>
								{/* 담당 쪽만 보이기 (2026.11.27) — 권한과 따로. 켜면 그 사람에게 남의 쪽은 잠긴 자리로만 간다(서버가 막는다) */}
								<label className="check limit" title={t("limitHint")}>
									<input type="checkbox" checked={d.limit} disabled={busy} onChange={() => run(() => collabLimit(d.id, !d.limit))} />
									<span>{t("limitLabel")}</span>
								</label>
								{deck && <AssignedSlides name={d.name} />}
							</div>
						</div>
					);
				})}
				{people.length > 0 && <p className="note">{t("assignHowTo")}</p>}
				<label className="check" title={t("collabLockNote")}>
					<input type="checkbox" checked={info.locked} disabled={busy} onChange={() => run(() => collabLock(!info.locked))} />
					<span>{t("collabLock")}</span>
				</label>
			</section>

			<div className="share-more" role="group">
				<button aria-expanded={more} onClick={() => setMore(!more)}>{t("shareMoreLinks")}</button>
			</div>

			{more && (
				<section className="share-sub">
					{info.links.map((l) => {
						const u = ready ? linkOf(l) : null;
						return (
							<div className={"link-row" + (l.expired ? " expired" : "")} key={l.id}>
								<span className="who">{l.name ? `${t("collabPersonal")} · ${l.name}` : t("collabPublic")}</span>
								<span className="dim when">{expiry(l)}</span>
								<button onClick={() => u && copy(u)} disabled={l.expired || !u} title={u ?? undefined}>{t("collabCopy")}</button>
								<button className="rm" onClick={() => run(() => collabLinkRemove(l.id))} title={t("collabLinkRemoveHint")}>{t("delete")}</button>
							</div>
						);
					})}
					<div className="link-new">
						<input className="field" placeholder={t("collabPersonalPh")} value={who} onChange={(e) => setWho(e.target.value)} aria-label={t("collabPersonalPh")} />
						<select className="field" value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label={t("collabExpiry")}>
							<option value={0}>{t("collabNoExpiry")}</option>
							<option value={24}>{t("collabHours24")}</option>
							<option value={168}>{t("collabDays7")}</option>
						</select>
						<button disabled={busy} onClick={() => run(async () => { await collabLinkNew(who.trim() || null, hours || null); setWho(""); })}>{who.trim() ? t("collabMakePersonal") : t("collabMakePublic")}</button>
					</div>
					<p className="note">{t("collabLinkNote")}</p>
				</section>
			)}

			<div className="share-foot">
				<span className="dim">{t("shareStopNote")}</span>
				{/* 들어와 있는 팀원이 있으면 묻는다 — 모두 끊기고 팀원이 돌리던 Claude 요청도 멈춘다 (2026.11.27) */}
				<button disabled={busy} onClick={async () => {
					const n = useCollab.getState().members.filter((m) => !m.host).length;
					if (n && !(await ask(t("shareStopAsk").replace("{n}", String(n)), { title: t("shareStop"), kind: "warning", okLabel: t("shareStop"), cancelLabel: t("cancel") }))) return;
					run(stopHost);
				}}>{t("shareStop")}</button>
			</div>
		</>
	);
}

/** 대화 머리 「의견 n」 — 덱의 열린 의견(누가 · 몇 쪽 · 무엇). 누르면 그 쪽으로, 해결 · 이 쪽 세션에 보내기. 협업 중에만 */
export function CommentsButton() {
	const t = useT();
	const pins = useDeck((s) => s.pins);
	const deck = useDeck((s) => s.deck);
	const setCurrent = useDeck((s) => s.setCurrent);
	const { info } = useCollab();
	const [open, setOpen] = useState(false);
	const [showDone, setShowDone] = useState(false);
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		if (!open) return;
		const k = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
		addEventListener("mousedown", k);
		return () => removeEventListener("mousedown", k);
	}, [open]);
	if ((!remote && !info) || !deck) return null;
	const live = pins.filter((p) => !p.done);
	const done = pins.filter((p) => p.done);
	const no = (id: string) => deck.slides.findIndex((s) => s.id === id) + 1;
	const list = showDone ? done : live;
	return (
		<span className="collabwrap" ref={ref}>
			<button className={"talk-comments" + (live.length ? " has" : "")} onClick={() => setOpen(!open)} aria-expanded={open}>{t("commentsN").replace("{n}", String(live.length))}</button>
			{open && (
				<div className="pop comments" role="dialog" aria-label={t("comments")}>
					{list.length === 0 && <p className="dim">{t("noComments")}</p>}
					{list.map((p) => (
						<div className="cm" key={p.id}>
							<div className="top">
								{p.by && <Face m={{ conn: 0, device: "", name: p.by, slide: null, host: false, since: 0 }} small />}
								<span className="nm">{p.by || "-"}</span>
								<button className="mono" onClick={() => setCurrent(no(p.slide) - 1)}>{no(p.slide)}{t("slideN") === "쪽" ? "쪽" : ""}</button>
							</div>
							<p className="txt">{p.text || "…"}</p>
							<div className="acts">
								{p.done
									? <button onClick={() => useDeck.getState().resolvePin(p.id, false)}>{t("reopen")}</button>
									: <>
										<button onClick={() => useDeck.getState().resolvePin(p.id, true)}>{t("resolve")}</button>
										<button onClick={() => { useDeck.getState().sendPin(p.id); setOpen(false); }} title={t("pinSendHint")}>{t("pinSendShort")}</button>
									</>}
							</div>
						</div>
					))}
					{done.length > 0 && <button className="more" onClick={() => setShowDone(!showDone)}>{showDone ? t("commentsN").replace("{n}", String(live.length)) : t("resolvedN").replace("{n}", String(done.length))}</button>}
				</div>
			)}
		</span>
	);
}
