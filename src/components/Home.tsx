// 처음 화면 — 위에 주제 한 줄(쓰면 바로 Claude 가 짓기 시작) · 가져오기 · 열기, 그 아래 최근 덱을 첫 쪽 미리보기 카드로 깐다.
// 창 어디에 놓아도 PPTX · CPPT · 프로젝트 폴더를 연다.
// 2026.11.18 : 최근 목록을 오른쪽 글자 줄에서 화면 대부분을 쓰는 카드로 바꿨다 — 가장 잦은 일이 지난 덱을 여는 것이고, 덱은 모양으로 알아본다.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, deckUrl, type LibItem } from "../lib/api";
import { openAny, startNew } from "../lib/flows";
import { useT } from "../lib/i18n";
import { useSettings } from "../lib/settings";
import { useDeck } from "../lib/store";

export function useFileDrop(onPaths: (p: string[]) => void) {
	const [over, setOver] = useState(false);
	useEffect(() => {
		const un = getCurrentWebview().onDragDropEvent((e) => {
			if (e.payload.type === "enter" || e.payload.type === "over") setOver(true);
			else if (e.payload.type === "leave") setOver(false);
			else if (e.payload.type === "drop") { setOver(false); onPaths(e.payload.paths); }
		});
		return () => { un.then((f) => f()); };
	}, [onPaths]);
	return over;
}

export default function Home() {
	const t = useT();
	const s = useSettings((x) => x.s);
	const busy = useDeck((x) => x.busy);
	const [brief, setBrief] = useState("");
	const [items, setItems] = useState<LibItem[]>([]);
	const [working, setWorking] = useState(false);

	useEffect(() => {
		(async () => {
			const lib = await api.library(s.library).catch(() => []);
			const extra: LibItem[] = [];
			for (const d of s.recent) {
				if (lib.some((l) => l.dir.toLowerCase() === d.toLowerCase())) continue;
				try { extra.push({ dir: d, deck: JSON.parse(await api.readText(d, "deck.json")), modified: 0 }); } catch {}
			}
			const rank = (d: string) => { const i = s.recent.findIndex((r) => r.toLowerCase() === d.toLowerCase()); return i < 0 ? 999 : i; };
			setItems([...lib, ...extra].sort((a, b) => rank(a.dir) - rank(b.dir) || b.modified - a.modified));
		})();
	}, [s.library, s.recent]);

	const over = useFileDrop((paths) => { if (paths[0]) openAny(paths[0]); });

	const go = async () => {
		if (working) return;
		setWorking(true);
		try { await startNew(brief); } catch (e) { useDeck.getState().notify(String(e), "err"); }
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
							onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); } }}
						/>
						<button className="send" onClick={go} disabled={working}>{brief.trim() ? t("start") : t("new")}<kbd>↵</kbd></button>
					</div>
				</div>
				<div className="home-acts">
					<button onClick={pickPptx}>{t("openPptx")}<kbd>Ctrl O</kbd></button>
					<button onClick={pickDeck}>{t("openDeck")}<kbd>Ctrl ⇧ O</kbd></button>
				</div>
			</section>
			<section className="home-decks" aria-label={t("recentDecks")}>
				<div className="side-head">{t("recentDecks")}<span>{items.length || ""}</span></div>
				{items.length === 0 ? (
					<div className="decks-empty">{t("decksEmpty")}</div>
				) : (
					<div className="decks">
						{items.map((it) => (
							<button key={it.dir} className="deck-card" onClick={() => openAny(it.dir)} title={it.dir}>
								<DeckThumb item={it} />
								<span className="t">{it.deck?.title || it.dir.split(/[\\/]/).pop()}</span>
								<span className="n">{it.deck?.slides?.length ?? 0}{t("slideN") === "쪽" ? "쪽" : " sl"}</span>
							</button>
						))}
					</div>
				)}
			</section>
			{over && <div className="dropzone">{t("drop")}</div>}
		</main>
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
