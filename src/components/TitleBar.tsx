// 사용자 제목 줄 — 끌어서 창 옮기기 · 두 번 눌러 최대화. 가운데에 무대 모드, 오른쪽에 내보내기 · 릴리즈 · 설정 · 창 단추.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { type Mode, useDeck } from "../lib/store";
import DeckActions from "./DeckActions";

export const Mark = () => (
	<svg className="mark" viewBox="0 0 16 16" aria-hidden>
		<rect x="1.5" y="4" width="11" height="7.5" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
		<circle cx="12.6" cy="4.2" r="2.6" fill="var(--accent)" />
	</svg>
);

export default function TitleBar({ onSettings, settingsOpen }: { onSettings: () => void; settingsOpen: boolean }) {
	const t = useT();
	const deck = useDeck((s) => s.deck);
	const versions = useDeck((s) => s.versions);
	const releases = useDeck((s) => s.releases);
	const mode = useDeck((s) => s.mode);
	const setMode = useDeck((s) => s.setMode);
	const close = useDeck((s) => s.closeProject);
	const saveDeck = useDeck((s) => s.saveDeck);
	const win = getCurrentWindow();
	const [max, setMax] = useState(false);
	useEffect(() => {
		win.isMaximized().then(setMax);
		const un = win.onResized(() => win.isMaximized().then(setMax));
		return () => { un.then((f) => f()); };
	}, []);
	const head = versions[0];
	const lastRel = releases[releases.length - 1];
	const titleRef = useRef<HTMLInputElement>(null);

	const modes: { m: Mode; k: string; label: string }[] = [
		{ m: "view", k: "V", label: t("view") },
		{ m: "pin", k: "P", label: t("mark") },
		{ m: "edit", k: "E", label: t("edit") },
	];

	return (
		<header className="titlebar" data-tauri-drag-region onDoubleClick={(e) => { if (e.target === e.currentTarget) win.toggleMaximize(); }}>
			<div className="left" data-tauri-drag-region>
				<Mark />
				<div className="crumb">
					{deck ? (
						<>
							<button className="crumb-home" onClick={close}>{t("home")}</button>
							<span className="dim">/</span>
							<input
								ref={titleRef}
								className="title"
								defaultValue={deck.title}
								key={deck.title}
								size={Math.max(4, deck.title.length + 1)}
								aria-label={t("name")}
								onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { (e.target as HTMLInputElement).value = deck.title; (e.target as HTMLInputElement).blur(); } }}
								onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== deck.title) saveDeck({ ...deck, title: v }); }}
							/>
							{head && (
								<span className="stamp">
									<b>v{head.n}</b>
									{lastRel && <> · <i>{lastRel.tag}</i>{head.n - lastRel.n > 1 ? `+${head.n - lastRel.n - 1}` : ""}</>}
								</span>
							)}
						</>
					) : (
						<span className="title" style={{ fontWeight: 600 }}>ClaudePPT</span>
					)}
				</div>
			</div>
			<div className="modes" role="group" aria-label="mode">
				{deck && modes.map(({ m, k, label }) => (
					<button key={m} className={m} aria-pressed={mode === m} onClick={() => setMode(m)} title={label + " (" + k + ")"}>
						{label}<kbd>{k}</kbd>
					</button>
				))}
			</div>
			<div className="right" data-tauri-drag-region>
				{deck && <DeckActions />}
				<button className={"tb-btn" + (settingsOpen ? " on" : "")} onClick={onSettings} title={t("settings") + " (Ctrl+,)"} aria-label={t("settings")}>
					<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden><path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><circle cx="10.5" cy="4.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" /><circle cx="5.5" cy="11.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
				</button>
				<div className="win">
					<button onClick={() => win.minimize()} aria-label={t("minimize")}><svg width="10" height="10" aria-hidden><path d="M0 5.5h10" stroke="currentColor" /></svg></button>
					<button onClick={() => win.toggleMaximize()} aria-label={t("maximize")}>
						{max ? <svg width="10" height="10" aria-hidden><path d="M2.5.5h7v7M.5 2.5h7v7h-7z" fill="none" stroke="currentColor" /></svg> : <svg width="10" height="10" aria-hidden><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor" /></svg>}
					</button>
					<button className="x" onClick={() => win.close()} aria-label={t("quit")}><svg width="10" height="10" aria-hidden><path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" /></svg></button>
				</div>
			</div>
		</header>
	);
}
