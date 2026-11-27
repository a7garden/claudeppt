// 공유 덱에 들어가기 (2026.11.27 Home.tsx 에서 옮겼다) — 초대 링크를 넣는 길이 셋이라 한 곳에 둔다.
//   붙여 넣기     처음 화면 「공유 덱 열기」 칸
//   링크 누르기   메신저 · 브라우저에서 claudeppt://… 를 누르면 Windows 가 이 앱에 넘긴다 (collab.rs links_opened)
//   복사해 두기   카카오톡 · Slack 은 claudeppt:// 를 누를 수 있는 링크로 만들어 주지 않는 일이 많다 — 복사한 채 앱으로 오면 처음 화면이 알아본다
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { useCollab } from "./collab";
import { useSettings } from "./settings";
import { useDeck } from "./store";
import { call } from "./transport";

/** 공유 덱에 앱으로 들어간다 — 새 창이 뜬다. 들어간 덱 주인을 남겨 다음에는 그것만으로 (기기 쿠키가 앱에 남는다).
 *  앱 링크(claudeppt://<열쇠>)면 열쇠를, 브라우저 링크면 주소를 남긴다 (p2p.rs canon) */
export async function joinShared(raw: string) {
	const url = raw.trim();
	if (!url) return false;
	try {
		const canon = await call<string>("collab_join", { url });
		const at = canon.startsWith("claudeppt:") ? canon : canon + "/";
		useSettings.getState().set((s) => ({ ...s, shared: [{ url: at, at: Date.now() }, ...s.shared.filter((x) => x.url !== at)].slice(0, 12) }));
		return true;
	} catch (e) {
		useDeck.getState().notify(String(e), "err");
		return false;
	}
}

/** 누른 초대 링크를 받아 들어간다 — 앱이 그 링크로 켜졌으면 화면이 뜨자마자, 떠 있었으면 그때그때 */
export async function watchJoinLinks() {
	const take = async () => { for (const u of await call<string[]>("join_links_take").catch(() => [] as string[])) await joinShared(u); };
	await listen("join-links", take);
	await take();
}

/** 클립보드에 있는 앱 초대 링크 — 없으면 null. 열쇠 · 초대 열쇠 꼴만 본다(아무 글이나 링크로 읽지 않게).
 *  내 공유의 링크(팀원에게 보내려고 복사한 것)는 빼고 */
export async function inviteInClip(): Promise<string | null> {
	const s = (await api.clipText().catch(() => "")).trim();
	if (!/^claudeppt:\/\/[a-z0-9]{40,}\/j\/[A-Za-z0-9_-]+\/?$/i.test(s)) return null;
	const mine = useCollab.getState().info?.app;
	return mine && s.toLowerCase().startsWith(mine.toLowerCase() + "/") ? null : s;
}
