// 처음 화면 — 위에 주제 한 줄(쓰면 바로 Claude 가 짓기 시작) · 가져오기 · 열기, 그 아래 최근 덱을 첫 쪽 미리보기 카드로 깐다.
// 창에 끌어 놓기는 DropZone(App 에 하나)이 받는다.
// 2026.11.18 : 최근 목록을 오른쪽 글자 줄에서 화면 대부분을 쓰는 카드로 바꿨다 — 가장 잦은 일이 지난 덱을 여는 것이고, 덱은 모양으로 알아본다.
// 2026.11.26 : 「공유 덱 열기」 — 팀원이 보낸 초대 링크를 브라우저 대신 이 앱의 새 창으로 연다 (collab.rs collab_join). 들어간 곳은 아래 「공유 덱」에 남는다.
// 2026.11.27 : 최근 덱 카드에 관리 메뉴(우클릭 · 카드 위 「⋯」) — 이름 바꾸기 · 탐색기 · CPPT 내보내기 · 목록에서 빼기 · 휴지통. 전에는 열기밖에 없어 지우려면 탐색기로 가야 했다.
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, deckUrl, type LibItem } from "../lib/api";
import { readDeck, safeName, writeDeck } from "../lib/deck";
import { openAny, startNew } from "../lib/flows";
import { useT } from "../lib/i18n";
import { useSettings } from "../lib/settings";
import { useDeck } from "../lib/store";
import { inviteInClip, isInvite, joinShared } from "../lib/join";
import { originOf, type RunnerState, setMine, useRunners } from "../lib/runner";
import { openMenu } from "./ContextMenu";

export default function Home() {
	const t = useT();
	const s = useSettings((x) => x.s);
	const busy = useDeck((x) => x.busy);
	const [brief, setBrief] = useState("");
	const [items, setItems] = useState<LibItem[]>([]);
	// 저장 폴더 안의 덱 — 폴더를 읽어 늘 다시 뜨므로 「목록에서 빼기」를 주지 않는다 (치우려면 휴지통)
	const [inLib, setInLib] = useState<Set<string>>(new Set());
	// 이름 바꾸는 중인 덱 폴더 · 목록 다시 읽기 (이름을 바꾸거나 휴지통으로 보낸 뒤)
	const [renaming, setRenaming] = useState<string | null>(null);
	const [tick, setTick] = useState(0);
	const [working, setWorking] = useState(false);
	// 이번에 만들 덱의 템플릿 — 처음엔 설정의 「새 덱」 템플릿. 여기서 바꿔도 설정은 그대로 둔다
	const [tpl, setTpl] = useState(s.template);
	// 공유 덱 열기 — 초대 링크 칸
	// 2026.11.27 : 링크 넣는 일을 줄였다. 전에는 단추 → 칸이 펴짐 → 붙여 넣기 → 「들어가기」 네 번이었고, 복사해 둔 링크를 묻는 줄이 따로 떴다.
	//   복사해 둔 초대 링크가 있으면 「공유 덱 열기」가 곧 그 링크로 들어가기 · 칸에 붙여 넣으면 바로 들어간다 · 처음 화면 어디서든 Ctrl+V 도 된다
	const [joining, setJoining] = useState(false);
	const [link, setLink] = useState("");
	const [entering, setEntering] = useState(false);
	const [clip, setClip] = useState<string | null>(null);
	useEffect(() => {
		const look = () => inviteInClip().then(setClip);
		look();
		addEventListener("focus", look);
		return () => removeEventListener("focus", look);
	}, []);
	const enter = async (u: string) => {
		if (entering) return;
		setEntering(true);
		try {
			if (await joinShared(u)) { setLink(""); setJoining(false); setClip(null); }
		} finally { setEntering(false); }
	};
	// 입력칸 밖에서 붙여 넣은 초대 링크 — 칸을 열 것 없이 들어간다 (덱 이름 · 요청 칸에 붙여 넣은 것은 그 칸의 글이다)
	useEffect(() => {
		const k = (e: ClipboardEvent) => {
			if ((e.target as Element).closest?.("input, textarea, [contenteditable]")) return;
			const s = e.clipboardData?.getData("text") ?? "";
			if (isInvite(s)) { e.preventDefault(); enter(s.trim()); }
		};
		addEventListener("paste", k);
		return () => removeEventListener("paste", k);
	});
	// 공유 덱 목록의 덱 주인 — 앱 링크는 열쇠 대신 「앱끼리 연결」, 브라우저 링크는 주소
	const where = (u: string) => (u.startsWith("claudeppt:") ? t("sharedViaApp") : u.replace(/^https?:\/\//, "").replace(/\/$/, ""));

	useEffect(() => {
		(async () => {
			const lib = await api.library(s.library).catch(() => []);
			const extra: LibItem[] = [];
			for (const d of s.recent) {
				if (lib.some((l) => l.dir.toLowerCase() === d.toLowerCase())) continue;
				try { extra.push({ dir: d, deck: JSON.parse(await api.readText(d, "deck.json")), modified: 0 }); } catch {}
			}
			const rank = (d: string) => { const i = s.recent.findIndex((r) => r.toLowerCase() === d.toLowerCase()); return i < 0 ? 999 : i; };
			setInLib(new Set(lib.map((l) => l.dir.toLowerCase())));
			setItems([...lib, ...extra].sort((a, b) => rank(a.dir) - rank(b.dir) || b.modified - a.modified));
		})();
	}, [s.library, s.recent, tick]);

	// 최근 목록에서 뺀다 — 휴지통으로 보낸 덱이 「최근」에 남으면 다음 실행에 없는 폴더를 읽으려 한다
	const forget = (dir: string) => useSettings.getState().set((v) => ({ ...v, recent: v.recent.filter((d) => d.toLowerCase() !== dir.toLowerCase()) }));
	const titleOf = (it: LibItem): string => it.deck?.title || it.dir.split(/[\\/]/).pop()!;
	const rename = async (dir: string, title: string) => {
		setRenaming(null);
		try {
			const d = await readDeck(dir);
			if (!title || title === d.title) return;
			await writeDeck(dir, { ...d, title });
			setTick((n) => n + 1);
		} catch (e) { useDeck.getState().notify(String(e), "err"); }
	};
	const pack = async (it: LibItem) => {
		const p = await save({ defaultPath: safeName(titleOf(it)) + ".cppt", filters: [{ name: "ClaudePPT", extensions: ["cppt"] }] });
		if (!p) return;
		const { notify } = useDeck.getState();
		// 남은 변경을 판으로 남기고 묶는다 — 제목 줄 「내보내기 › CPPT」와 같다
		await api.commit(it.dir, t("direct")).catch(() => {});
		await api.pack(it.dir, p).then(() => notify(p.split(/[\\/]/).pop()!), (e) => notify(String(e), "err"));
	};
	const trash = async (it: LibItem) => {
		if (!(await ask(t("deckTrashAsk").replace("{name}", titleOf(it)), { title: t("deckTrash"), kind: "warning", okLabel: t("deckTrash"), cancelLabel: t("cancel") }))) return;
		try {
			await api.trashDeck(it.dir);
			forget(it.dir);
			setTick((n) => n + 1);
			useDeck.getState().notify(t("deckTrashed"));
		} catch (e) { useDeck.getState().notify(String(e), "err"); }
	};
	const menu = (e: React.MouseEvent | MouseEvent, it: LibItem) => openMenu(e, [
		{ label: t("open"), run: () => openAny(it.dir) },
		{ label: t("deckRename"), kbd: "F2", run: () => setRenaming(it.dir) },
		"-",
		{ label: t("deckReveal"), run: () => api.reveal(it.dir) },
		{ label: t("deckPack"), run: () => pack(it) },
		"-",
		...(inLib.has(it.dir.toLowerCase()) ? [] : [{ label: t("deckForget"), run: () => forget(it.dir) }]),
		{ label: t("deckTrash"), danger: true, run: () => trash(it) },
	]);


	const go = async () => {
		if (working) return;
		setWorking(true);
		try { await startNew(brief, tpl); } catch (e) { useDeck.getState().notify(String(e), "err"); }
		setWorking(false);
	};
	const pickPptx = async () => {
		const p = await open({ filters: [{ name: "PowerPoint", extensions: ["pptx"] }] });
		if (typeof p === "string") openAny(p);
	};
	const pickDeck = async () => {
		const p = await open({ filters: [{ name: "ClaudePPT", extensions: ["cppt", "json"] }], defaultPath: s.library });
		if (typeof p === "string") openAny(p);
	};

	useEffect(() => {
		const k = (e: KeyboardEvent) => {
			if (!e.ctrlKey) return;
			if (e.key.toLowerCase() === "o") { e.preventDefault(); e.shiftKey ? pickDeck() : pickPptx(); }
		};
		addEventListener("keydown", k);
		return () => removeEventListener("keydown", k);
	});

	return (
		<main className="home">
			{(working || busy) && <div className="progress-line" />}
			<section className="home-top">
				<div className="brief">
					<div className="line">
						<textarea
							id="brief"
							aria-label={t("brief")}
							autoFocus
							rows={1}
							placeholder={t("briefHint")}
							value={brief}
							onChange={(e) => setBrief(e.target.value)}
							onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); go(); } }}
						/>
						<button className="send" onClick={go} disabled={working}>{brief.trim() ? t("start") : t("new")}<kbd>↵</kbd></button>
					</div>
				</div>
				<div className="home-acts">
					{/* 템플릿이 한 벌뿐이면 고를 것이 없다 — 칸을 띄우지 않는다 */}
					{s.templates.length > 1 && (
						<label className="tpl-pick">
							{t("templatePick")}
							<select value={s.templates.some((x) => x.id === tpl) ? tpl : s.template} onChange={(e) => setTpl(e.target.value)}>
								{s.templates.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
							</select>
						</label>
					)}
					<button onClick={pickPptx}>{t("openPptx")}<kbd>Ctrl O</kbd></button>
					<button onClick={pickDeck}>{t("openDeck")}<kbd>Ctrl ⇧ O</kbd></button>
					{/* 복사해 둔 초대 링크가 있으면 칸을 펴지 않고 바로 그 링크로 들어간다 */}
					{clip && !joining ? (
						<button className="join-clip" onClick={() => enter(clip)} disabled={entering} title={t("joinClipHint")}>{entering ? t("joinBusy") : t("joinClipGo")}</button>
					) : (
						<button onClick={() => setJoining(!joining)} aria-expanded={joining}>{t("joinShared")}</button>
					)}
				</div>
				{joining && (
					<form className="join-row" onSubmit={(e) => { e.preventDefault(); enter(link); }}>
						<input className="field" autoFocus value={link} disabled={entering} placeholder={t("joinPh")} aria-label={t("joinShared")}
							onChange={(e) => { setLink(e.target.value); if (isInvite(e.target.value)) enter(e.target.value.trim()); }}
							onKeyDown={(e) => { if (e.key === "Escape") setJoining(false); }} />
						<button className="send" disabled={!link.trim() || entering}>{entering ? t("joinBusy") : t("joinGo")}</button>
						<span className="dim">{t("joinNote")}</span>
					</form>
				)}
			</section>
			<section className="home-decks" aria-label={t("recentDecks")}>
				{s.shared.length > 0 && (
					<div className="shared">
						<div className="side-head">{t("sharedDecks")}<span>{s.shared.length}</span></div>
						<div className="shared-list">
							{s.shared.map((x) => (
								<span className="shared-item" key={x.url}>
									<button onClick={() => joinShared(x.url)} title={x.url}>
										{/* 덱 제목은 「내 Claude」가 붙었을 때 덱 주인이 알려 준다 — 모르면 덱 주인 PC 주소 */}
										<b className={x.title ? "t" : ""}>{x.title || where(x.url)}</b>
										<span className="dim">{x.title ? `${where(x.url)} · ` : ""}{new Date(x.at).toLocaleDateString()}</span>
									</button>
									<MineToggle url={x.url} on={!!x.mine} />
									<button className="x" onClick={() => useSettings.getState().set((v) => ({ ...v, shared: v.shared.filter((y) => y.url !== x.url) }))} aria-label={t("delete")} title={t("sharedForget")}>×</button>
								</span>
							))}
						</div>
					</div>
				)}
				<div className="side-head">{t("recentDecks")}<span>{items.length || ""}</span></div>
				{items.length === 0 ? (
					<div className="decks-empty">{t("decksEmpty")}</div>
				) : (
					<div className="decks">
						{items.map((it) => {
							const n = <span className="n">{it.deck?.slides?.length ?? 0}{t("slideN") === "쪽" ? "쪽" : " sl"}</span>;
							return (
								<div className="deck-item" key={it.dir} onContextMenu={(e) => menu(e, it)}>
									{/* 이름 바꾸는 동안은 단추가 아니다 — 단추 안의 입력칸은 누를 때마다 덱을 연다 */}
									{renaming === it.dir ? (
										<div className="deck-card">
											<DeckThumb item={it} />
											<input className="t field" autoFocus defaultValue={titleOf(it)} aria-label={t("deckRename")} onFocus={(e) => e.target.select()}
												onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { const el = e.target as HTMLInputElement; el.value = titleOf(it); el.blur(); } }}
												onBlur={(e) => rename(it.dir, e.target.value.trim())} />
											{n}
										</div>
									) : (
										<button className="deck-card" onClick={() => openAny(it.dir)} title={it.dir}
											onKeyDown={(e) => { if (e.key === "F2") { e.preventDefault(); setRenaming(it.dir); } }}>
											<DeckThumb item={it} />
											<span className="t">{titleOf(it)}</span>
											{n}
										</button>
									)}
									<button className="more" aria-label={t("deckMenu")} title={t("deckMenu")} onClick={(e) => {
										// 「⋯」 아래에 편다 — 키보드로 누르면 마우스 자리가 0,0 이다
										const r = e.currentTarget.getBoundingClientRect();
										menu({ defaultPrevented: false, preventDefault() {}, clientX: r.right, clientY: r.bottom } as MouseEvent, it);
									}}>⋯</button>
								</div>
							);
						})}
					</div>
				)}
			</section>
		</main>
	);
}

/** 「내 Claude 쓰기」 — 이 덱 주인에게 내 PC 의 Claude 를 붙인다 (runner.ts). 켜면 지금 상태(기다림 · 연결 · 일하는 중)를 함께 */
const RUNNER_LABEL: Record<RunnerState, "runnerWaiting" | "runnerConnected" | "runnerRunning" | "runnerError" | "runnerUse"> = {
	waiting: "runnerWaiting", connected: "runnerConnected", running: "runnerRunning", error: "runnerError", off: "runnerUse",
};
function MineToggle({ url, on }: { url: string; on: boolean }) {
	const t = useT();
	const st = useRunners((r) => r.st[originOf(url)]);
	return (
		<label className={"mine" + (on ? " on" : "") + (st ? " " + st.state : "")} title={st?.detail || t("runnerUseHint")}>
			<input type="checkbox" checked={on} onChange={() => setMine(url, !on).catch((e) => useDeck.getState().notify(String(e), "err"))} />
			<span>{on && st ? t(RUNNER_LABEL[st.state]) : t("runnerUse")}</span>
		</label>
	);
}

/** 최근 덱 카드의 첫 쪽 미리보기. deck:// 은 열어 둔 프로젝트만 내주므로 잠깐 열어 id 를 받고 감시는 바로 끈다
 *  (project_close 는 감시만 끄고 id 는 남긴다). 화면 언저리에 올 때만 띄운다 — 덱이 많으면 iframe 이 쌓인다 */
function DeckThumb({ item }: { item: LibItem }) {
	const ref = useRef<HTMLSpanElement>(null);
	const [width, setWidth] = useState(0);
	const [near, setNear] = useState(false);
	const [id, setId] = useState<string | null>(null);
	const first = item.deck?.slides?.[0]?.file as string | undefined;
	const size = item.deck?.size || { w: 1280, h: 720 };
	useLayoutEffect(() => {
		const el = ref.current!;
		const ro = new ResizeObserver(() => setWidth(el.clientWidth));
		ro.observe(el);
		const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) setNear(true); }, { rootMargin: "50% 0px" });
		io.observe(el);
		return () => { ro.disconnect(); io.disconnect(); };
	}, []);
	useEffect(() => {
		if (!near || !first || id) return;
		let gone = false;
		api.open(item.dir).then((x) => { api.close(x).catch(() => {}); if (!gone) setId(x); }, () => {});
		return () => { gone = true; };
	}, [near, first, item.dir]);
	// 카드 틀은 16:9 로 고정하고 쪽은 그 안에 맞춰 넣는다 — 4:3 덱이 섞여도 카드 줄이 고르다
	const boxH = (width * 9) / 16;
	const k = Math.min(width / size.w, boxH / size.h);
	return (
		<span className="dthumb" ref={ref}>
			{id && first && width > 0 && (
				<iframe src={deckUrl(id, first)} title="" tabIndex={-1} width={size.w} height={size.h}
					style={{ transform: `translate(${(width - size.w * k) / 2}px, ${(boxH - size.h * k) / 2}px) scale(${k})` }} />
			)}
		</span>
	);
}
