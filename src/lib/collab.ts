// 팀 협업 — 호스트 앱과 협업 브라우저가 같은 덱을 함께 본다 (서버: src-tauri/src/collab.rs, 설계: 「설정 › 협업」).
//
//   호스트(startHost)   덱 · 대화 · 세션 · 판 · 핀을 서버에 올린다(collab_publish). 바뀐 칸만, 턴은 바뀐 턴만.
//                       브라우저가 보낸 「의도」(요청 보내기 · 직접 편집 · 의견)를 받아 호스트 store 로 처리하고 답한다 — 쓰기는 호스트 한 곳
//   브라우저(connect)   /_/ws 로 상태를 받아 store 에 얹는다. 쓰는 동작은 의도로 바꿔 보낸다(REMOTE_ACTIONS).
//                       보는 쪽 · 지금 대화 · 도구 같은 보는 사람 몫은 브라우저마다 따로다
//   접속               누가 붙었고 어느 쪽을 보는지 — useCollab.members. 쪽 목록 · 무대 머리에 보인다
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api, b64FromBytes } from "./api";
import { attachable, relFor, useAttach } from "./attach";
import { appWindow, call, remote, remoteDeck } from "./transport";
import { tNow } from "./i18n";
import { type ShareVia, useSettings } from "./settings";
import { inPool, isMine, me, nextSession, persistTalk, type Turn, useDeck } from "./store";

/** runner — 이 기기가 「내 PC 의 Claude」를 붙여 두었다 (runner.rs) · app — 앱의 공유 덱 창으로 들어왔다 (화면이 알려 온 것, collab.rs Member) */
export interface Member { conn: number; device: string; name: string; slide: string | null; host: boolean; since: number; runner?: boolean; app?: boolean }
/** app — 앱으로 여는 링크(claudeppt://…, 앱끼리 잇는 길이 없으면 null) · url — 브라우저로 여는 링크 */
export interface InviteLink { id: string; app: string | null; url: string; name: string | null; expires: number | null; expired: boolean }
export interface Device { id: string; name: string; seen: number; online: boolean }
/** 서버 정보 — bases: 이 서버에 닿는 주소 · links: 초대 링크 · devices: 링크로 들어온 기기 · locked: 회의 잠금 */
/** app — 앱끼리 잇는 주소(claudeppt://<열쇠>) · lan — 사무실 망에 열었나(브라우저 팀원용) */
/** deck — 공유한 덱 (2026.11.27). 공유는 켤 때 연 덱 하나에 묶인다 */
export interface CollabInfo { port: number; app: string | null; lan: boolean; bases: string[]; tunnel: { url: string; kind: "tailscale" | "cloudflare" } | null; links: InviteLink[]; devices: Device[]; locked: boolean; members: Member[]; deck: { dir: string; title: string } }
export interface TunnelTools { tailscale: string | null; cloudflared: string | null }

interface C {
	/** 호스트: 서버가 켜져 있으면 그 정보 */
	info: CollabInfo | null;
	members: Member[];
	/** 브라우저: 서버가 준 내 연결 번호 · 붙어 있는가 */
	conn: number | null;
	connected: boolean;
	/** 브라우저: 호스트가 협업을 껐다 · 나를 내보냈다 */
	ended: boolean;
	kicked: boolean;
	/** 따라가는 사람의 연결 번호 — 그 사람이 쪽을 넘기면 내 화면도 넘어간다. 내가 쪽을 옮기면 풀린다 (보는 사람 몫) */
	follow: number | null;
	/** 브라우저: 덱 주인이 자기 Claude · 세션을 함께 쓰게 했나 (settings collab.shareClaude 를 받는다) */
	shareClaude: boolean;
	/** 브라우저: 덱 주인이 공유한 덱을 닫았다(다른 덱 · 처음 화면) — 다시 열면 이어진다 */
	away: boolean;
}
export const useCollab = create<C>()(() => ({ info: null, members: [], conn: null, connected: false, ended: false, kicked: false, follow: null, shareClaude: false, away: false }));

/** 이 화면이 보고 쓰는 세션 묶음 (store Session.owner) — 덱 주인 화면은 hostPool, 팀원 화면은 세션 공유면 묶음 없이 · 앱 창이면 내 기기 · 브라우저면 덱 주인 묶음.
 *  덱 주인 쪽 claudeFor 와 같은 규칙이다 — 여기는 보이기만 하고, 정하는 것은 덱 주인이다 */
export function poolOf(c: Pick<C, "shareClaude" | "members" | "conn">, share: boolean): string | undefined {
	if (!remote) return share ? undefined : "";
	if (c.shareClaude) return undefined;
	return appWindow ? c.members.find((m) => m.conn === c.conn)?.device ?? "?" : "";
}
export const usePool = () => {
	const share = useSettings((x) => x.s.collab.shareClaude);
	return useCollab((c) => poolOf(c, share));
};

/** 덱 주인: 세션 공유를 켜고 끈다 — 팀원 화면에도 바로 알린다 */
export function setShareClaude(on: boolean) {
	useSettings.getState().set((x) => ({ ...x, collab: { ...x.collab, shareClaude: on } }));
	if (useCollab.getState().info) flush();
}

/** 따라가기 — 그 사람의 쪽으로 가고, 그 뒤로 그 사람이 넘기는 대로 넘어간다 (2026.11.26) */
export function follow(conn: number | null) {
	useCollab.setState({ follow: conn });
	if (conn !== null) followNow();
}

/** 따라가는 사람의 쪽으로 — 그 사람이 나갔으면 따라가기를 푼다 */
function followNow() {
	const { follow: f, members } = useCollab.getState();
	if (f === null) return;
	const m = members.find((x) => x.conn === f);
	if (!m) return useCollab.setState({ follow: null });
	const d = useDeck.getState();
	const i = d.deck?.slides.findIndex((s) => s.id === m.slide) ?? -1;
	if (i >= 0 && i !== d.current) { following = true; d.setCurrent(i); following = false; }
}
let following = false;
let followWired = false;
/** 접속 목록이 바뀌면 따라가고, 내가 직접 쪽을 옮기면 따라가기를 푼다 */
function wireFollow() {
	if (followWired) return;
	followWired = true;
	useCollab.subscribe((s, p) => { if (s.members !== p.members) followNow(); });
	useDeck.subscribe((s, p) => {
		if (s.current === p.current || following || s.deck !== p.deck) return;
		if (useCollab.getState().follow !== null) useCollab.setState({ follow: null });
	});
}

/** 호스트와 브라우저가 함께 쓰는 칸 — 나머지(보는 쪽 · 도구 · 비교 · 알림 · 되돌리기 쌓임)는 보는 사람 몫 */
const SHARED = ["dir", "id", "deck", "rev", "sessions", "bind", "talkKey", "versions", "releases", "running", "runs", "pins", "editing", "histBy"] as const;
type Key = (typeof SHARED)[number];

// ── 호스트 ──

let lastSet: Partial<Record<Key, unknown>> = {};
let lastTurns = new Set<Turn>();
let lastOrder = "";
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let unsub: (() => void) | null = null;
let hostListening: Promise<unknown> | null = null;

/** 공유한 덱 폴더 (collab.rs Hub.dir) — 덱 주인이 이 덱을 열고 있는 동안만 덱 · 대화를 올린다 */
let sharedDir: string | null = null;
let away = false;
/** 덱 주인 화면이 지금 공유한 덱을 보고 있나 */
const here = () => !!sharedDir && useDeck.getState().dir === sharedDir;

/** 바뀐 칸만 모아 올린다. full 이면 통째 (켤 때 · 공유한 덱으로 돌아왔을 때).
 *  2026.11.27 : 다른 덱 · 처음 화면에 있으면 「자리 비움」만 한 번 — 전에는 덱 주인이 연 덱을 팀원이 그대로 따라 봤다 */
function flush(full = false) {
	flushTimer = undefined;
	if (!here()) {
		if (!away) { away = true; lastSet = {}; lastTurns = new Set(); lastOrder = ""; lastShare = undefined; call("collab_publish", { patch: { away: true } }).catch(() => {}); }
		return;
	}
	if (away) { away = false; full = true; }
	const st = useDeck.getState() as any;
	const set: Record<string, unknown> = full ? { away: false } : {};
	for (const k of SHARED) if (full || st[k] !== lastSet[k]) { set[k] = st[k]; lastSet[k] = st[k]; }
	// 덱 주인의 세션 공유 — 팀원 화면이 세션 목록 · 「내 Claude」 고르기를 이것으로 그린다
	const share = useSettings.getState().s.collab.shareClaude;
	if (full || share !== lastShare) { set.shareClaude = share; lastShare = share; }
	const turns: Turn[] = st.turns;
	const order = turns.map((t) => t.id).join(",");
	const put = turns.filter((t) => full || !lastTurns.has(t));
	const patch: any = {};
	if (full) patch.reset = true;
	if (Object.keys(set).length) patch.set = set;
	if (full || order !== lastOrder || put.length) patch.turns = { ...(full || order !== lastOrder ? { order: turns.map((t) => t.id) } : {}), put };
	lastTurns = new Set(turns);
	lastOrder = order;
	if (Object.keys(patch).length) call("collab_publish", { patch }).catch(() => {});
}

let lastShare: boolean | undefined;

/** 글자가 흐르는 동안 매 글자마다 보내지 않게 묶는다 (30ms) */
const schedule = () => { flushTimer ??= setTimeout(() => flush(), 30); };

/** 호스트도 한 사람으로 — 이름과 보는 쪽. 바뀌었을 때만 — 덱은 편집 · Claude 의 쓰기마다 바뀌어, 그때마다 보내면 모든 브라우저에 접속 목록이 다시 간다 */
let lastView = "";
function hostView(force = false) {
	const d = useDeck.getState();
	const v = { name: me() || "Host", slide: d.deck?.slides[d.current]?.id ?? null };
	const k = JSON.stringify(v);
	if (!force && k === lastView) return;
	lastView = k;
	call("collab_view", v).catch(() => {});
}

/** 지금 연 덱을 공유한다. 이미 켜져 있으면(화면을 다시 띄움 · resumeHost) 공유하던 덱 그대로 */
export async function startHost(): Promise<CollabInfo> {
	const d = useDeck.getState();
	const info = (await call<CollabInfo | null>("collab_info").catch(() => null)) ?? (await call<CollabInfo>("collab_start", { dir: d.dir, title: d.deck?.title ?? "" }));
	sharedDir = info.deck.dir;
	away = false;
	useCollab.setState({ info, members: info.members });
	hostListening ??= Promise.all([
		listen<Member[]>("collab-members", (e) => useCollab.setState({ members: e.payload })),
		listen<CollabInfo>("collab-info", (e) => useCollab.setState({ info: e.payload, members: e.payload.members })),
		listen<{ id: string; from: From; name: string; args: any }>("collab-intent", (e) => handleIntent(e.payload)),
	]);
	await hostListening;
	watchComments();
	wireFollow();
	flush(true);
	hostView(true);
	// 지난번에 고른 길로 연다 — 다시 붙을 때(resumeHost)는 이미 열려 있으면 그대로
	const via = useSettings.getState().s.collab.via;
	if (via !== "app") setVia(via).catch((e) => useDeck.getState().notify(String(e), "err"));
	// 2026.11.26 : 바깥 길을 켜자마자 열던 것을 그만뒀다 — 팀원 앱은 앱끼리 잇는 길(p2p.rs)로 들어오고, 브라우저 팀원용 길은 공유 창에서 연다.
	// 바깥 길은 덱을 인터넷에 내놓는 일이라 사람이 고른다
	unsub?.();
	let cur = useDeck.getState().current, deckRef = useDeck.getState().deck;
	unsub = useDeck.subscribe((s) => {
		schedule();
		if (s.current !== cur || s.deck !== deckRef) { cur = s.current; deckRef = s.deck; hostView(); }
	});
	return info;
}

/** 링크 · 기기 · 잠금 — 호스트 화면의 「설정 › 협업」 */
const setInfo = (info: CollabInfo) => { useCollab.setState({ info, members: info.members }); return info; };
export const collabLinkNew = (name: string | null, hours: number | null) => call<CollabInfo>("collab_link_new", { name, hours }).then(setInfo);
export const collabLinkRemove = (id: string) => call<CollabInfo>("collab_link_remove", { id }).then(setInfo);
export const collabKick = (device: string) => call<CollabInfo>("collab_kick", { device }).then(setInfo);
export const collabLock = (on: boolean) => call<CollabInfo>("collab_lock", { on }).then(setInfo);
/** 사무실 망 — 같은 망의 브라우저 팀원용 입구 (collab.rs collab_lan) */
export const collabLan = (on: boolean) => call<CollabInfo>("collab_lan", { on }).then(setInfo);
/** 바깥 길(터널) — 사무실 밖에서도 같은 링크로 (tunnel.rs) */
export const collabTunnel = (on: boolean) => call<CollabInfo>("collab_tunnel", { on }).then(setInfo);
export const collabTools = () => call<TunnelTools>("collab_tools");

/** 초대 링크를 어떻게 내줄지 고른다 (2026.11.27) — 고른 길만 열고 나머지는 닫는다. 앱 팀원은 어느 쪽이든 그대로 붙어 있다(앱끼리 잇는 길은 늘 열려 있다).
 *  웹을 고르면 그 길이 열린 다음에야 바꾼다 — 바깥 도구가 없거나 못 열면 전 것 그대로. 공유가 꺼져 있으면 고르기만 해 두고 켤 때 연다(startHost) */
export async function setVia(via: ShareVia) {
	const info = useCollab.getState().info;
	if (info) {
		if (via === "internet" && !info.tunnel) await collabTunnel(true);
		if (via === "office" && !info.lan) await collabLan(true);
		if (via !== "internet" && info.tunnel) await collabTunnel(false);
		// 바깥 길(https)을 열면 사무실 망(http · 암호화 안 됨)은 닫는다 — 바깥 길이 사무실 안에서도 열린다
		if (via !== "office" && info.lan) await collabLan(false);
	}
	useSettings.getState().set((x) => ({ ...x, collab: { ...x.collab, via } }));
}

/** 호스트 화면을 다시 띄웠는데(새로 고침 · 오류 뒤 다시 그림) 서버가 켜져 있으면 다시 붙는다 — 안 붙으면 브라우저가 멈춘 화면을 본다 */
export async function resumeHost() {
	if (await call("collab_info").catch(() => null)) await startHost();
}

/** 받은 의견 알림 — 다른 사람이 핀(의견)을 새로 꽂으면 한 줄 알린다 (호스트 · 브라우저 모두) */
let pinWatch: (() => void) | null = null;
function watchComments() {
	if (pinWatch) return;
	let known = new Set(useDeck.getState().pins.map((p) => p.id));
	let deckId = useDeck.getState().id;
	pinWatch = useDeck.subscribe((s) => {
		if (s.id !== deckId) { deckId = s.id; known = new Set(s.pins.map((p) => p.id)); return; }
		const mine = useSettings.getState().s.me.trim();
		for (const p of s.pins) {
			if (known.has(p.id)) continue;
			known.add(p.id);
			if (p.by && p.by !== mine) {
				const no = (s.deck?.slides.findIndex((x) => x.id === p.slide) ?? -1) + 1;
				s.notify(tNow("commentNew").replace("{name}", p.by).replace("{no}", String(no)), "ok");
			}
		}
	});
}

export async function stopHost() {
	unsub?.();
	unsub = null;
	clearTimeout(flushTimer);
	flushTimer = undefined;
	lastSet = {};
	lastTurns = new Set();
	lastOrder = "";
	lastView = "";
	sharedDir = null;
	away = false;
	await call("collab_stop").catch(() => {});
	useCollab.setState({ info: null, members: [], follow: null });
}

/** 의도 처리기 — 이름 → (보낸 사람, 인자) → 값. 여기 없는 이름은 거절한다 (서버 INTENTS 와 함께 지킨다) */
type From = { conn: number; name: string; device?: string };
const handlers: Record<string, (from: From, args: any) => Promise<unknown>> = {};
export const onIntent = (name: string, fn: (from: From, args: any) => Promise<unknown>) => { handlers[name] = fn; };

async function handleIntent(p: { id: string; from: From; name: string; args: any }) {
	const fn = handlers[p.name];
	let reply: any;
	try {
		// 덱 주인이 다른 덱을 보고 있으면 받지 않는다 — 그 덱에 팀원 요청 · 편집이 들어가지 않게
		if (!here()) throw new Error(tNow("collabAway"));
		reply = fn ? { ok: true, value: (await fn(p.from, p.args ?? {})) ?? null } : { ok: false, error: tNow("collabNotYet") };
	} catch (e) {
		reply = { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
	call("collab_reply", { id: p.id, reply }).catch(() => {});
}

// ── 호스트: 의도 처리기 — 브라우저 팀원이 하려는 일을 호스트 store 로. 보낸 사람(from.name)은 서버가 정한 기기 이름 ──

/** 첨부 한 파일의 가장 큰 크기 — 큰 파일은 바깥 길에서 오래 걸리고 Claude 도 다 읽지 못한다 */
const UPLOAD_MAX = 10 * 1024 * 1024;

/** 팀원 요청을 돌릴 Claude 와 세션 묶음 (2026.11.27) — 서버가 정한 기기(from.device)로 고르므로 남의 PC · 남의 세션을 고를 수 없다.
 *    세션 공유 켬     묶음 없이 모두가 이어 쓴다. Claude 는 그 팀원이 「내 Claude」를 골랐고 붙어 있으면 그 PC, 아니면 덱 주인 PC (전과 같다)
 *    세션 공유 끔     앱 팀원 — 자기 PC 의 Claude · 자기 세션 묶음. 내 Claude 가 안 붙어 있으면 덱 주인 Claude 로 넘기지 않고 막는다
 *    (기본)          브라우저 팀원 — 자기 Claude 가 없으니 덱 주인 Claude · 덱 주인 묶음 */
function claudeFor(from: From, wantsMine: boolean): { runner?: string; pool?: string } {
	const members = useCollab.getState().members;
	const m = members.find((x) => x.conn === from.conn);
	const hasRunner = !!from.device && members.some((x) => x.device === from.device && x.runner);
	if (useSettings.getState().s.collab.shareClaude) {
		if (!wantsMine) return {};
		if (!hasRunner) throw new Error(tNow("runnerOff"));
		return { runner: from.device };
	}
	if (!m?.app) return { pool: "" };
	if (!hasRunner || !from.device) throw new Error(tNow("runnerNeed"));
	return { runner: from.device, pool: from.device };
}

onIntent("send", (from, a) => new Promise((ok, no) => {
	const d = useDeck.getState();
	if (!d.deck) return no(new Error(tNow("collabWaiting")));
	// 바쁘면 거절하지 않는다 — 같은 세션은 앞 턴 뒤에 기다리고, 다른 세션은 함께 돈다 (store sendTurn)
	// 그 팀원이 꽂은 열린 핀만 — 남의 의견을 자기 요청에 실어 지우지 못하게
	const pins = d.pins.filter((p) => Array.isArray(a.pins) && a.pins.includes(p.id) && isMine(p, from.name));
	// 첨부는 그 팀원이 올린 것(.claudeppt/attach/)만 — 다른 곳의 경로를 적어 보내 Claude 가 읽게 하지 못하게
	const atts: string[] = (Array.isArray(a.attachments) ? a.attachments : []).filter((x: unknown) => typeof x === "string" && /^\.claudeppt\/attach\/[^\\/]+$/.test(x));
	let who: { runner?: string; pool?: string };
	try { who = claudeFor(from, a.runner === "mine"); } catch (e) { return no(e); }
	let started = false;
	d.send(String(a.text ?? ""), atts, true, { by: from.name || tNow("collabNoName"), current: typeof a.current === "string" ? a.current : null, talkKey: typeof a.talkKey === "string" ? a.talkKey : null, pins, ...who, onStart: (r) => { started = true; ok(r); } })
		.then(() => { if (!started) ok(null); }, no);
}));

/** 멈춤 — 그 팀원이 보는 대화의 도는 턴이나 기다리는 턴 (턴 id 를 받는다) */
onIntent("stop", async (_from, a) => {
	const d = useDeck.getState();
	const t = d.turns.find((x) => x.id === a.turn);
	if (t && (t.status === "running" || t.status === "queued")) d.stop(t.id);
});

/** 새 대화 — 호스트가 보는 대화는 그대로 두고 새 세션만 만든다. 그 팀원의 지금 대화가 아직 빈 세션이면 그것을 쓴다 */
onIntent("newTalk", async (from, a) => {
	const st = useDeck.getState();
	if (!st.dir) throw new Error(tNow("collabWaiting"));
	// 그 팀원의 묶음에 — 세션 공유가 꺼져 있으면 앱 팀원 것은 그 사람 세션 (내 Claude 가 아직 안 붙었어도 세션은 만든다)
	const m = useCollab.getState().members.find((x) => x.conn === from.conn);
	const pool = useSettings.getState().s.collab.shareClaude ? undefined : m?.app && from.device ? from.device : "";
	const cur = st.sessions.find((x) => x.key === a.talkKey);
	if (cur && inPool(cur, pool) && !cur.claude && !st.turns.some((t) => t.session === cur.key)) return { key: cur.key };
	const ns = nextSession(st.sessions, pool);
	useDeck.setState({ sessions: [...st.sessions, ns] });
	persistTalk(st.dir, useDeck.getState());
	return { key: ns.key };
});

/** 직접 편집 — 글자 고치기 · 끌어 옮기기 · 지우기. 호스트가 한 줄(serial)로 받아 원본에 쓰고, 판 작성자 · 되돌리기 걸음에 그 팀원 이름을 단다 */
onIntent("direct", async (from, a) => {
	const d = useDeck.getState();
	const op = a.op ?? {};
	const path = a.path;
	const okPath = path === null || (Array.isArray(path) && path.length < 64 && path.every((n: unknown) => Number.isInteger(n) && (n as number) >= 0));
	const okOp =
		(op.t === "edit" && typeof op.html === "string" && op.html.length < 200_000) ||
		(op.t === "patch" && op.style && typeof op.style === "object" && Object.values(op.style).every((v) => typeof v === "string")) ||
		op.t === "remove";
	if (typeof a.slideId !== "string" || !okPath || !okOp) throw new Error("bad edit");
	await d.applyDirect(a.slideId, path, op, from.name || tNow("collabNoName"));
});

/** 핀 · 의견 — 꽂기 · 고치기 · 지우기는 그 사람 것만, 해결 · 세션에 보내기는 누구나 */
const pinOf = (id: unknown) => useDeck.getState().pins.find((p) => p.id === id);
onIntent("pinAdd", async (from, a) => {
	const ok = typeof a.slide === "string" && Number.isFinite(a.x) && Number.isFinite(a.y) && useDeck.getState().deck?.slides.some((s) => s.id === a.slide);
	if (!ok) throw new Error("bad pin");
	return useDeck.getState().addPin({ slide: a.slide, x: a.x, y: a.y, text: String(a.text ?? "").slice(0, 2000), target: a.target, shape: a.shape }, from.name || tNow("collabNoName"), a.id);
});
onIntent("pinUpdate", async (from, a) => {
	const p = pinOf(a.id);
	if (p && p.by === from.name) useDeck.getState().updatePin(p.id, String(a.text ?? "").slice(0, 2000));
});
onIntent("pinRemove", async (from, a) => {
	const p = pinOf(a.id);
	if (p && p.by === from.name) useDeck.getState().removePin(p.id);
});
onIntent("pinResolve", async (_from, a) => {
	const p = pinOf(a.id);
	if (p) useDeck.getState().resolvePin(p.id, !!a.done);
});
onIntent("pinSend", async (from, a) => {
	const p = pinOf(a.id);
	if (!p) return;
	// 끝날 때까지 기다리지 않는다 — 턴이 서면 답한다
	const who = claudeFor(from, a.runner === "mine");
	useDeck.getState().sendPin(p.id, { by: from.name || tNow("collabNoName"), talkKey: typeof a.talkKey === "string" ? a.talkKey : null, ...who });
});

onIntent("undo", async (from) => useDeck.getState().undo(from.name || tNow("collabNoName")));
onIntent("redo", async (from) => useDeck.getState().redo(from.name || tNow("collabNoName")));

/** 첨부 올리기 — 그림 · PDF · 글만, 10MB 까지. 덱의 .claudeppt/attach/ 에 쓰고 그 경로를 돌려준다 */
onIntent("upload", async (_from, a) => {
	const { dir } = useDeck.getState();
	const name = String(a.name ?? "");
	const data = String(a.data ?? "");
	if (!dir) throw new Error(tNow("collabWaiting"));
	if (!attachable(name)) throw new Error(`${tNow("attachRefused")}: ${name}`);
	if (data.length > (UPLOAD_MAX * 4) / 3 + 4) throw new Error(tNow("collabTooBig"));
	const rel = relFor(name);
	await api.writeB64(dir, rel, data);
	return rel;
});

// ── 브라우저 ──

/** 내 기기가 「내 PC 의 Claude」를 붙여 두었나 — 서버가 준 내 연결 번호로 접속 목록에서 찾는다 */
export function myRunner() {
	const { members, conn } = useCollab.getState();
	return !!members.find((m) => m.conn === conn)?.runner;
}
/** 요청을 내 PC 의 Claude 로 보낼지 — 붙어 있으면 기본으로 켠다. 보는 사람 몫이라 이 브라우저에만 기억한다.
 *  seen — 이번에 내 Claude 가 붙은 적이 있다. 그 뒤 끊기면 요청을 덱 주인 Claude 로 조용히 넘기지 않고 막는다 (덱 주인 사용량을 모르게 쓰지 않게) */
const MINE_KEY = "cppt.useMine";
export const useMine = create<{ use: boolean; seen: boolean; set: (v: boolean) => void }>()((set) => ({
	seen: false,
	use: (() => { try { return localStorage.getItem(MINE_KEY) !== "0"; } catch { return true; } })(),
	set: (use) => { set({ use }); try { localStorage.setItem(MINE_KEY, use ? "1" : "0"); } catch {} },
}));

let ws: WebSocket | null = null;
let seq = 0;
const waiting = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();
const turnMap = new Map<string, Turn>();
let retry = 0;
let kicked = false;

function send(m: unknown) {
	if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

/** 호스트에 하려는 일을 보내고 답을 기다린다 */
export function intent<T = unknown>(name: string, args: unknown = {}): Promise<T> {
	const id = ++seq;
	return new Promise<T>((ok, no) => {
		if (ws?.readyState !== WebSocket.OPEN) return no(new Error(tNow("collabOffline")));
		waiting.set(id, { ok, no });
		send({ t: "intent", id, name, args });
	});
}

/** 이름 · 보는 쪽을 알린다. 바뀌었을 때만 (붙은 직후는 늘) */
let lastHello = "";
function hello(force = false) {
	const d = useDeck.getState();
	const m = { t: "hello", name: useSettings.getState().s.me.trim(), slide: d.deck?.slides[d.current]?.id ?? null, app: appWindow };
	const k = JSON.stringify(m);
	if (!force && k === lastHello) return;
	lastHello = k;
	send(m);
}

function apply(patch: any, full: boolean) {
	const st = useDeck.getState() as any;
	const next: Record<string, unknown> = {};
	if (full || patch.reset) turnMap.clear();
	for (const [k, v] of Object.entries(patch.set ?? {})) {
		if (k === "shareClaude") { useCollab.setState({ shareClaude: !!v }); continue; }
		if (k === "away") { useCollab.setState({ away: !!v }); continue; }
		// 지금 대화는 보는 사람 몫 — 처음 받을 때와, 보던 세션이 없어졌을 때만 호스트 것을 따른다
		if (k === "talkKey") {
			const sessions = (patch.set.sessions ?? st.sessions) as { key: string }[];
			if (st.talkKey && sessions.some((s) => s.key === st.talkKey)) continue;
		}
		next[k] = v;
	}
	// 되돌리기 걸음 수는 사람마다 — 내 것만 제목 줄 단추에
	if (next.histBy) next.hist = (next.histBy as Record<string, { u: number; r: number }>)[useSettings.getState().s.me.trim()] ?? { u: 0, r: 0 };
	if (patch.turns) {
		for (const t of patch.turns.put ?? []) turnMap.set(t.id, t);
		const order: string[] = patch.turns.order ?? st.turns.map((t: Turn) => t.id);
		for (const id of [...turnMap.keys()]) if (!order.includes(id)) turnMap.delete(id);
		next.turns = order.map((id) => turnMap.get(id)).filter(Boolean);
	}
	if ("dir" in next || "id" in next) {
		remoteDeck.dir = (next.dir as string) ?? st.dir;
		remoteDeck.id = (next.id as string) ?? st.id;
	}
	// 다른 덱으로 바뀌었으면 보는 쪽을 처음으로
	if ("id" in next && next.id !== st.id) next.current = 0;
	if (next.deck && st.current >= (next.deck as any).slides.length) next.current = 0;
	useDeck.setState(next as any);
}

/** 브라우저에서 — 호스트 서버에 붙고, 끊기면 다시 붙는다 */
export function connect() {
	if (!remote || ws) return;
	// 마지막으로 서버에서 무엇이든 받은 때 — 서버는 20초마다 ping 을 보낸다(collab.rs BEAT)
	let heard = Date.now();
	const lost = () => {
		ws = null;
		useCollab.setState({ connected: false });
		for (const w of waiting.values()) w.no(new Error(tNow("collabOffline")));
		waiting.clear();
		// 다시 붙기 — 0.5 · 1 · 2 · 4 … 최대 10초
		if (!kicked) setTimeout(open, Math.min(10000, 500 * 2 ** retry++));
	};
	// 50초 넘게 아무것도 못 받았으면 끊긴 것이다 — 덮었던 노트북을 열거나 와이파이가 바뀌면 브라우저는 한참 「연결됨」으로 남는다.
	// 옛 연결의 onclose 는 늦게 오거나 오지 않으므로 기다리지 않고 버린 뒤 새로 붙는다
	setInterval(() => {
		if (!ws || ws.readyState !== WebSocket.OPEN || Date.now() - heard < 50_000) return;
		const dead = ws;
		dead.onclose = dead.onmessage = null;
		dead.close();
		lost();
	}, 10_000);
	const open = () => {
		// 한 화면에 연결은 하나 — 개발 중 모듈이 다시 읽히면(HMR) 옛 연결이 남아 같은 사람이 둘로 보였다
		(window as any).__cpptWs?.close();
		ws = (window as any).__cpptWs = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/_/ws`);
		ws.onopen = () => { retry = 0; heard = Date.now(); useCollab.setState({ connected: true, ended: false }); hello(true); };
		ws.onmessage = (e) => {
			heard = Date.now();
			const m = JSON.parse(e.data);
			if (m.t === "ping") return;
			if (m.t === "hello") {
				remoteDeck.key = m.deckKey;
				useCollab.setState({ conn: m.conn });
				// 이름은 들어올 때 정한 것(서버가 기기마다 기억) — 요청 · 편집의 보낸 사람도 서버가 이 이름으로 붙인다
				if (m.name && useSettings.getState().s.me !== m.name) useSettings.getState().set((x) => ({ ...x, me: m.name }));
			}
			else if (m.t === "state") apply(m.patch, !!m.full);
			else if (m.t === "members") useCollab.setState({ members: m.list });
			else if (m.t === "reply") {
				const w = waiting.get(m.id);
				waiting.delete(m.id);
				if (w) m.ok ? w.ok(m.value) : w.no(new Error(m.error || "error"));
			} else if (m.t === "bye") useCollab.setState({ ended: true });
			// 내보내졌다 — 보던 덱을 걷고 다시 붙지 않는다 (기기 열쇠가 지워져 붙어도 401 이다)
			else if (m.t === "kicked") { kicked = true; useCollab.setState({ ended: true, kicked: true }); useDeck.setState({ deck: null, turns: [], pins: [] }); }
		};
		ws.onclose = lost;
	};
	open();
	watchComments();
	wireFollow();
	// 보는 쪽 · 이름이 바뀌면 알린다
	let cur = -1, deckRef: unknown = null;
	useDeck.subscribe((s) => { if (s.current !== cur || s.deck !== deckRef) { cur = s.current; deckRef = s.deck; hello(); } });
	let name = useSettings.getState().s.me;
	useSettings.subscribe((s) => { if (s.s.me !== name) { name = s.s.me; hello(); } });
	useDeck.setState(remoteActions());
	// 첨부는 호스트에 올려 그 덱의 첨부 폴더에 둔다 — 브라우저에는 이 PC 의 파일 경로가 없다
	useAttach.setState({
		addBlobs: async (files: File[]) => {
			for (const f of files) {
				const name = f.name && /\.[a-z0-9]+$/i.test(f.name) ? f.name : `image.${f.type.split("/")[1] || "png"}`;
				if (!attachable(name)) { useDeck.getState().notify(`${tNow("attachRefused")}: ${name}`, "err"); continue; }
				if (f.size > UPLOAD_MAX) { useDeck.getState().notify(`${name}: ${tNow("collabTooBig")}`, "err"); continue; }
				const rel = await intent<string>("upload", { name, data: b64FromBytes(new Uint8Array(await f.arrayBuffer())) }).catch((e) => { useDeck.getState().notify(String(e.message || e), "err"); return null; });
				if (rel) useAttach.setState({ files: [...useAttach.getState().files, rel] });
			}
		},
		addPaths: async () => {},
	});
}

/** 브라우저의 store 동작 — 쓰는 것은 의도로, 호스트만 하는 것은 막는다. 보는 사람 몫(쪽 옮기기 · 도구 · 세션 보기)은 그대로 */
function remoteActions() {
	const d = useDeck.getState();
	const fail = (e: unknown) => d.notify(String(e instanceof Error ? e.message : e), "err");
	const hostOnly = async () => { d.notify(tNow("collabHostOnly"), "err"); };
	return {
		openProject: hostOnly,
		closeProject: hostOnly,
		send: async (text: string, attachments: string[] = []) => {
			const st = useDeck.getState();
			const m = useMine.getState();
			if (m.use && m.seen && !myRunner()) { const e = new Error(tNow("runnerLostHint")); fail(e); throw e; }
			const mine = st.pins.filter((p) => isMine(p, useSettings.getState().s.me.trim())).map((p) => p.id);
			// 못 보냈으면 알리고 다시 던진다 — 요청칸(Talk)이 비웠던 글 · 첨부를 되살린다
			const r = await intent<{ key: string; via?: number } | null>("send", { text, attachments, pins: mine, talkKey: st.talkKey, current: st.deck?.slides[st.current]?.id ?? null, runner: useMine.getState().use && myRunner() ? "mine" : undefined }).catch((e) => { fail(e); throw e; });
			if (!r || !r.key) return;
			// 보던 대화와 다른 세션(그 쪽을 처음 고친 세션)으로 갔으면 알리고 대화칸을 그리로
			if (st.talkKey && r.key !== st.talkKey && r.via) d.notify(tNow("routedTo").replace("{no}", String(r.via)).replace("{n}", r.key.slice(1)), "ok");
			useDeck.setState({ talkKey: r.key });
		},
		stop: (turn?: string) => { const st = useDeck.getState(); intent("stop", { turn: turn ?? (st.talkKey ? st.runs[st.talkKey] : null) }).catch(fail); },
		newTalk: () => { intent<{ key: string }>("newTalk", { talkKey: useDeck.getState().talkKey }).then((r) => { if (r) { useDeck.setState({ talkKey: r.key }); d.notify(tNow("newTalkDone").replace("{n}", r.key.slice(1)), "ok"); } }, fail); },
		viewSession: (key: string) => useDeck.setState({ talkKey: key }),
		addSlide: hostOnly,
		duplicateSlide: hostOnly,
		moveSlide: () => { hostOnly(); },
		removeSlide: () => { hostOnly(); },
		saveDeck: hostOnly,
		restore: hostOnly,
		restoreSlide: hostOnly,
		exportTo: hostOnly,
		release: hostOnly,
		fixFonts: hostOnly,
		fixDiff: () => { hostOnly(); },
		undo: async () => { await intent("undo").catch(fail); },
		redo: async () => { await intent("redo").catch(fail); },
		applyDirect: async (slideId: string, path: number[] | null, op: unknown) => { await intent("direct", { slideId, path, op }).catch(fail); },
		addPin: (p: any) => { const id = "p" + Date.now().toString(36); intent("pinAdd", { ...p, id }).catch(fail); return id; },
		updatePin: (id: string, text: string) => { intent("pinUpdate", { id, text }).catch(fail); },
		removePin: (id: string) => { intent("pinRemove", { id }).catch(fail); },
		resolvePin: (id: string, done: boolean) => { intent("pinResolve", { id, done }).catch(fail); },
		sendPin: async (id: string) => { await intent("pinSend", { id, talkKey: useDeck.getState().talkKey, runner: useMine.getState().use && myRunner() ? "mine" : undefined }).catch(fail); },
	};
}
