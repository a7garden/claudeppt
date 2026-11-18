import { useEffect, useState } from "react";
import Home from "./components/Home";
import Settings from "./components/Settings";
import TitleBar from "./components/TitleBar";
import Workspace from "./components/Workspace";
import { useT } from "./lib/i18n";
import { useSettings } from "./lib/settings";
import { useDeck } from "./lib/store";
import { useAutoUpdate, useUpdate } from "./lib/updater";

function useTheme() {
	const theme = useSettings((s) => s.s.theme);
	useEffect(() => {
		const mq = matchMedia("(prefers-color-scheme: light)");
		const apply = () => {
			const t = theme === "system" ? (mq.matches ? "light" : "dark") : theme;
			document.documentElement.dataset.theme = t;
			try { localStorage.setItem("theme-resolved", t); } catch {}
		};
		apply();
		mq.addEventListener("change", apply);
		return () => mq.removeEventListener("change", apply);
	}, [theme]);
}

export default function App() {
	const loaded = useSettings((s) => s.loaded);
	const load = useSettings((s) => s.load);
	const lang = useSettings((s) => s.s.lang);
	const open = useDeck((s) => !!s.deck);
	const [settings, setSettings] = useState(false);
	useEffect(() => { load(); }, [load]);
	useEffect(() => { document.documentElement.lang = lang; }, [lang]);
	useTheme();
	useAutoUpdate(loaded);
	useEffect(() => {
		const k = (e: KeyboardEvent) => {
			if (e.ctrlKey && e.key === ",") { e.preventDefault(); setSettings((v) => !v); }
			if (e.key === "Escape" && settings) setSettings(false);
		};
		addEventListener("keydown", k);
		return () => removeEventListener("keydown", k);
	}, [settings]);
	// 설치본에서 WebView 기본 우클릭 메뉴(뒤로 · 새로 고침)를 막는다. 입력칸은 그대로 둔다
	useEffect(() => {
		const k = (e: MouseEvent) => { if (!import.meta.env.DEV && !(e.target as Element).closest("input, textarea, [contenteditable]")) e.preventDefault(); };
		addEventListener("contextmenu", k);
		return () => removeEventListener("contextmenu", k);
	}, []);
	if (!loaded) return <div className="app" />;
	return (
		<div className="app">
			<TitleBar onSettings={() => setSettings((v) => !v)} settingsOpen={settings} />
			{open ? <Workspace /> : <Home />}
			{settings && <Settings onClose={() => setSettings(false)} />}
			<Toasts />
		</div>
	);
}

function Toasts() {
	const toast = useDeck((s) => s.toast);
	const busy = useDeck((s) => s.busy);
	const jobs = useDeck((s) => s.jobs);
	const up = useUpdate();
	const t = useT();
	return (
		<>
			{busy && <div className="busy" role="status">{busy}<div className="progress-line" /></div>}
			{toast && !busy && (
				<div className={"toast " + toast.kind} role="status">
					<span>{toast.text}</span>
					{toast.action && <button onClick={() => { toast.action!.run(); useDeck.setState({ toast: null }); }}>{toast.action.label}</button>}
					{toast.sticky && <button className="dim" onClick={() => useDeck.setState({ toast: null })} aria-label={t("close")}>{t("close")}</button>}
				</div>
			)}
			{jobs.length > 0 && (
				<div className="jobs" role="status" aria-live="polite">
					{jobs.map((j) => (
						<div className="job" key={j.id}>
							<div className="head">
								<span className="label" title={j.label}>{j.label}</span>
								<span className="mono">{j.n ? `${j.i}/${j.n}${t("slideN") === "쪽" ? "쪽" : ""}` : j.note ? "" : t("importRead")}</span>
							</div>
							<div className={"bar" + (j.n ? "" : " unknown")} role="progressbar" aria-label={`${t("importing")} ${j.label}`} aria-valuemin={0} aria-valuemax={j.n || undefined} aria-valuenow={j.n ? j.i : undefined}>
								<i style={j.n ? { width: `${(j.i / j.n) * 100}%` } : undefined} />
							</div>
							{j.note && <div className="detail" title={j.note}>{j.note}</div>}
						</div>
					))}
				</div>
			)}
			{up.phase === "available" && up.notified && !busy && (
				<div className="toast" role="status">
					<span>{t("update")} <span className="mono">{up.version}</span></span>
					<button onClick={up.install}>{t("install")}</button>
					<button className="dim" onClick={up.dismiss}>{t("close")}</button>
				</div>
			)}
		</>
	);
}
