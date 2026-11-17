// 처음 화면 — 주제 한 줄을 쓰면 바로 Claude 가 짓기 시작한다. 가져오기 · 열기는 그 아래 한 줄, 최근 프로젝트는 오른쪽.
// 창 어디에 놓아도 PPTX · CPPT · 프로젝트 폴더를 연다.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api, type LibItem } from "../lib/api";
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
			<section className="home-main">
				<div className="brief">
					<label htmlFor="brief">{t("brief")}</label>
					<div className="line">
						<textarea
							id="brief"
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
			<aside className="home-side">
				<div className="side-head"><span>{t("recent")}</span><span>{items.length || ""}</span></div>
				<div className="recent">
					{items.length === 0 && <div className="dim" style={{ padding: "10px 12px" }}>{t("drop")}</div>}
					{items.map((it) => (
						<button key={it.dir} onClick={() => openAny(it.dir)} title={it.dir}>
							<span className="t">{it.deck?.title || it.dir.split(/[\\/]/).pop()}</span>
							<span className="n">{it.deck?.slides?.length ?? 0}{t("slideN") === "쪽" ? "쪽" : " sl"}</span>
							<span className="p">{it.dir}</span>
						</button>
					))}
				</div>
			</aside>
			{over && <div className="dropzone">{t("drop")}</div>}
		</main>
	);
}
