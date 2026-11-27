// 백엔드(src-tauri) 명령을 부르는 얇은 층. 이름은 Rust 명령과 같다. 길(Tauri · 협업 브라우저)은 transport.ts 가 고른다.
import { call as invoke, remote, remoteDeck } from "./transport";

/** author — 이 판을 시킨 팀원 이름 (직접 편집 · 바깥 CLI 의 판은 ClaudePPT) */
export interface Commit { n: number; hash: string; short: string; date: string; subject: string; tags: string[]; author: string }
/** 덱에 들어가지 못한 변경 묶음 (vcs.rs Hold) — name 은 그 턴 id. conflicts 는 얹으려다 겹친 파일(얹을 때만 안다) */
export interface Hold { name: string; hash: string; author: string; subject: string; date: string; files: string[]; conflicts: string[] }
/** 턴의 변경을 덱 위에 얹은 결과 (vcs.rs Landed) */
export type Landed = { kind: "none" } | { kind: "applied"; commit: Commit; files: string[] } | { kind: "held"; hold: Hold };
/** 갈래 (branch.rs) — 가지 하나. ahead 는 줄기에 없는 변경 수 · behind 는 받지 않은 줄기의 변경 수 · path 는 열어 둔 작업 폴더 */
export interface Sian { id: string; name: string; by: string; hash: string; date: string; ahead: number; behind: number; path: string | null; chain?: ChainRelation }
/** 사본에서 가져올 때 사본의 서명 기록이 이 덱의 것과 어떤 사이인가 (trust.rs compare_copy) */
export type ChainRelation = "none" | "same" | "ahead" | "behind" | "diverged" | "foreign" | "invalid";
/** 명부 · 승인 기록 (trust.rs View) */
export type TrustRole = "approve" | "edit" | "assigned" | "comment" | "view";
export interface TrustPerson { id: string; name: string; role: TrustRole; keys: number; slides: string[]; me: boolean }
/** 주고받기 상태 (sync.rs Status) */
export interface SyncStatus {
	peers: number; member: boolean; approver: boolean; unsent: boolean; sent_at: string | null; sent_to: string | null; behind: boolean; pending: number;
	props: { key: string; id: string; name: string; at: string; ahead: number; mine: boolean }[];
	joins: { key: string; name: string; at: string }[];
	mailbox: string | null;
}
export interface SyncImported { chain: ChainRelation; adopted: boolean; props: number; joins: number; conflicts: string[] }
export interface SyncRan { sent: string | null; received: number; waiting: number; errors: string[]; conflicts: string[] }
export interface PeerRan { asked: number; reached: number; received: number; conflicts: string[]; errors: string[] }
/** 서명 대기 명부 판 (trust.rs PendingView) : changes 의 kind 는 add · remove · role · keys · rename · review */
export interface TrustPending { hash: string; signed: string[]; mine: boolean; changes: { kind: "add" | "remove" | "role" | "keys" | "rename" | "review"; name: string; from: string | null; to: string | null }[] }
export interface TrustView { deck: string; n: number; sealed: boolean; people: TrustPerson[]; review: boolean; me: string; approver: boolean; fragile: boolean; pending: TrustPending[] }
/** 이 폴더는 어느 덱의 어느 줄인가 — sian 이 있으면 가지 폴더, main 은 본 덱 폴더 */
export interface Where { main: string; sian: string | null; name: string | null; origin: string | null }
/** 합친 결과 — ok 가 아니면 겹친 파일 */
export interface Merged { ok: boolean; commit: Commit | null; conflicts: string[] }
/** 변경 그래프 (branch.rs vcs_graph) — nodes 는 새것부터(부모보다 늘 위), heads 는 줄마다의 끝 */
export interface GraphNode { hash: string; short: string; parents: string[]; author: string; date: string; subject: string; tags: string[] }
export interface GraphHead { kind: "main" | "sian" | "hold"; id: string; name: string; hash: string }
export interface LibItem { dir: string; deck: any; modified: number }
/** 설정 「바깥 연결」 — 통로 · 최근 바깥 명령 · 스킬 상태 (control.rs remote_info) */
export interface RemoteInfo {
	enabled: boolean;
	port: number;
	control: string;
	recent: { at: string; cmd: string; dir: string; ok: boolean; error: string | null; ms: number }[];
	skill: { dir: string; installed: boolean; current: boolean; exe: string; linked: string | null };
}
export interface Tool { name: string; path: string | null; version: string }
/** 깔린 글꼴 하나. family = 가족 이름(나라말마다) · full = 전체 이름들 · local = @font-face local() 에 쓸 영어 전체 이름 */
/** metrics = [winAscent, winDescent, typoAscender, typoDescender, typoLineGap] (em 비율) · typo = USE_TYPO_METRICS */
export interface FontFace { file: string; family: string[]; full: string[]; local: string; bold: boolean; italic: boolean; weight: number; metrics: number[]; typo: boolean }

export const api = {
	readText: (root: string, rel: string) => invoke<string>("fs_read_text", { root, rel }),
	clipText: () => invoke<string>("clip_text"),
	writeText: (root: string, rel: string, text: string) => invoke<void>("fs_write_text", { root, rel, text }),
	writeB64: (root: string, rel: string, data: string) => invoke<void>("fs_write_base64", { root, rel, data }),
	exists: (root: string, rel: string) => invoke<boolean>("fs_exists", { root, rel }),
	/** 큰 파일은 base64 를 거치지 않고 날바이트로 — 그림 · 동영상 · 원본 PPTX */
	writeBytes: (root: string, rel: string, data: Uint8Array) => invoke<void>("fs_write_bytes", data, { headers: { "x-root": encodeURIComponent(root), "x-rel": encodeURIComponent(rel) } }),
	absReadBytes: (path: string) => invoke<ArrayBuffer>("abs_read_bytes", { path }),
	absWriteBytes: (path: string, data: Uint8Array) => invoke<void>("abs_write_bytes", data, { headers: { "x-path": encodeURIComponent(path) } }),
	absCopyIn:(src: string, root: string, rel: string) => invoke<void>("abs_copy_in", { src, root, rel }),

	paths: () => invoke<{ data: string; library: string }>("app_paths"),
	settingsLoad: () => invoke<any>("settings_load"),
	settingsSave: (value: unknown) => invoke<void>("settings_save", { value }),
	open: (dir: string) => invoke<string>("project_open", { dir }),
	close: (id: string) => invoke<void>("project_close", { id }),
	library: (dir: string) => invoke<LibItem[]>("library_list", { dir }),
	pack: (dir: string, out: string) => invoke<void>("pack_deck", { dir, out }),
	unpack: (file: string, dest: string) => invoke<string>("unpack_deck", { file, dest }),
	reveal: (path: string) => invoke<void>("reveal", { path }),
	/** 덱 폴더를 휴지통으로 — deck.json 이 있는 폴더만 받는다 */
	trashDeck: (dir: string) => invoke<void>("deck_trash", { dir }),

	vcsInit: (dir: string) => invoke<void>("vcs_init", { dir }),
	/** author — 이 판을 시킨 팀원 이름. 주면 git 작성자로 남는다 */
	commit: (dir: string, message: string, author?: string) => invoke<Commit | null>("vcs_commit", { dir, message, author: author || null }),
	/** 작업 사본 (vcs.rs) — Claude 턴은 세션마다 둔 사본에서 돌고, 끝나면 묶음 하나로 덱 위에 얹는다. 겹치면 보류 갈래로 남는다 */
	workPrepare: (dir: string, key: string) => invoke<{ path: string; base: string }>("vcs_work_prepare", { dir, key }),
	workBring: (dir: string, key: string, paths: string[]) => invoke<void>("vcs_work_bring", { dir, key, paths }),
	workFinish: (dir: string, key: string, turn: string, message: string, author?: string) => invoke<Landed>("vcs_work_finish", { dir, key, turn, message, author: author || null }),
	holds: (dir: string) => invoke<Hold[]>("vcs_holds", { dir }),
	holdRetry: (dir: string, name: string) => invoke<Landed>("vcs_hold_retry", { dir, name }),
	holdTake: (dir: string, name: string, message: string, author?: string) => invoke<Commit | null>("vcs_hold_take", { dir, name, message, author: author || null }),
	holdDrop: (dir: string, name: string) => invoke<void>("vcs_hold_drop", { dir, name }),
	/** 갈래 (branch.rs) — 가지 · 사본 · 그래프. dir 은 본 덱 폴더 (가지 폴더에서는 where().main) */
	where: (dir: string) => invoke<Where>("vcs_where", { dir }),
	sians: (dir: string) => invoke<Sian[]>("vcs_sians", { dir }),
	sianNew: (dir: string, name: string, by?: string, from?: string) => invoke<Sian>("vcs_sian_new", { dir, name, by: by || null, from: from || null }),
	sianOpen: (dir: string, id: string) => invoke<string>("vcs_sian_open", { dir, id }),
	/** prefer — 겹친 곳을 어느 쪽 것으로 (ours: 받는 쪽 · theirs: 들어오는 쪽). 겹친 것을 보고 사람이 고른 때만 준다 */
	sianMerge: (dir: string, id: string, message: string, author?: string, prefer?: "ours" | "theirs") => invoke<Merged>("vcs_sian_merge", { dir, id, message, author: author || null, prefer: prefer || null }),
	sianUpdate: (dir: string, id: string, author?: string, prefer?: "ours" | "theirs") => invoke<Merged>("vcs_sian_update", { dir, id, author: author || null, prefer: prefer || null }),
	sianDrop: (dir: string, id: string) => invoke<void>("vcs_sian_drop", { dir, id }),
	graph: (dir: string, limit?: number) => invoke<{ nodes: GraphNode[]; heads: GraphHead[] }>("vcs_graph", { dir, limit }),
	fork: (dir: string, dest: string) => invoke<void>("vcs_fork", { dir, dest }),
	forkSend: (dir: string, name: string, by?: string) => invoke<string>("vcs_fork_send", { dir, name, by: by || null }),
	forkFetch: (dir: string, from: string, name: string, by?: string) => invoke<Sian>("vcs_fork_fetch", { dir, from, name, by: by || null }),
	trustState: (dir: string) => invoke<TrustView | null>("trust_state", { dir }),
	trustRename: (dir: string, name: string) => invoke<TrustView>("trust_rename", { dir, name }),
	trustRecovery: (dir: string) => invoke<string>("trust_recovery", { dir }),
	trustRecover: (dir: string, secret: string) => invoke<TrustView>("trust_recover", { dir, secret }),
	trustCosign: (dir: string, hash: string) => invoke<TrustView>("trust_cosign", { dir, hash_: hash }),
	trustPendingDrop: (dir: string, hash: string) => invoke<void>("trust_pending_drop", { dir, hash_: hash }),
	syncStatus: (dir: string) => invoke<SyncStatus | null>("sync_status", { dir }),
	syncExport: (dir: string, out: string, full: boolean) => invoke<string | null>("sync_export", { dir, out, full }),
	syncImport: (dir: string, file: string) => invoke<SyncImported>("sync_import", { dir, file }),
	syncApprove: (dir: string, key: string, id: string) => invoke<string[]>("sync_approve", { dir, key, id }),
	syncJoin: (dir: string, name: string) => invoke<void>("sync_join", { dir, name }),
	syncAdmit: (dir: string, key: string, role: TrustRole) => invoke<void>("sync_admit", { dir, key, role }),
	syncMailboxSet: (dir: string, folder: string | null) => invoke<void>("sync_mailbox_set", { dir, folder }),
	syncMailboxRun: (dir: string) => invoke<SyncRan>("sync_mailbox_run", { dir }),
	syncOpen: (file: string, dest: string) => invoke<string>("sync_open", { file, dest }),
	syncPeersRun: (dir: string) => invoke<PeerRan>("sync_peers_run", { dir }),
	log: (dir: string, limit?: number) => invoke<Commit[]>("vcs_log", { dir, limit }),
	tag: (dir: string, name: string) => invoke<void>("vcs_tag", { dir, name }),
	restore: (dir: string, hash: string, message: string, author?: string) => invoke<Commit | null>("vcs_restore", { dir, hash, message, author: author || null }),

	claudeDetect: (path: string) => invoke<{ path: string; version: string } | null>("claude_detect", { path }),
	claudeRun: (spec: { turn: string; dir: string; cwd?: string; prompt: string; system: string; claudePath: string; model: string; effort: string; resume?: string | null; sessionId?: string | null; mode?: "fonts" }) => invoke<{ code: number; stderr: string }>("claude_run", { spec }),
	claudeStop: (turn: string) => invoke<void>("claude_stop", { turn }),
	/** 팀원 PC 의 Claude 로 돌린다 (collab.rs claude_run_remote) — claudeRun 과 같은 답 */
	claudeRunRemote: (spec: { turn: string; dir: string; work?: string; device: string; prompt: string; system: string; resume?: string | null; sessionId?: string | null }) => invoke<{ code: number; stderr: string }>("claude_run_remote", { spec }),

	toolsDetect: () => invoke<Tool[]>("tools_detect"),
	imageGenerate: (spec: { provider: string; prompt: string; out: string; apiKey?: string; model?: string; size?: string }) => invoke<string>("image_generate", { spec }),
	fontIndex: () => invoke<FontFace[]>("font_index"),
	fontInstall: (urls: string[]) => invoke<{ url: string; files: string[]; error: string | null }[]>("font_install", { urls }),
	remoteInfo: () => invoke<RemoteInfo>("remote_info"),
	skillInstall: () => invoke<RemoteInfo["skill"]>("skill_install"),
	/** dir 안 EMF · WMF 를 긴 변 max 픽셀 PNG 로 바꾼다 (Windows GDI+) — "<너비>x<높이>" */
	metafilePng: (dir: string, src: string, out: string, max = 1600) => invoke<string>("metafile_png", { dir, src, out, max }),
	pptSnapshot: (pptx: string, outDir: string, width = 1280, height = 720) => invoke<number>("ppt_snapshot", { pptx, outDir, width, height }),
};

/** 슬라이드 주소. Windows WebView2 는 사용자 프로토콜을 http://<이름>.localhost 로 연다. 협업 브라우저는 호스트 서버의 /_/d/<덱 열쇠> */
export const deckUrl = (id: string, rel: string, rev?: string) => {
	const base = remote ? `${location.origin}/_/d/${remoteDeck.key}` : navigator.userAgent.includes("Windows") ? "http://deck.localhost" : "deck://localhost";
	return `${base}/${id}${rev ? "@" + rev : ""}/${rel.split("/").map(encodeURIComponent).join("/")}`;
};

export const join = (...p: string[]) => p.filter(Boolean).join("\\").replace(/[\\/]+/g, "\\");

export const b64FromBytes = (u8: Uint8Array) => {
	let s = "";
	for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
	return btoa(s);
};
export const bytesFromB64 = (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
