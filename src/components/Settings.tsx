// 설정 — 오른쪽에서 펴는 판. 왼쪽 낱말 머리로 갈래를 고르고, 오른쪽은 「이름 · 값」 줄.
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api, type Tool } from "../lib/api";
import { type Key, useT } from "../lib/i18n";
import { BASE_PROMPT } from "../lib/prompt";
import { type ImageProvider, type Settings as S, useSettings } from "../lib/settings";
import { useDeck } from "../lib/store";
import { useUpdate } from "../lib/updater";

type Tab = "general" | "claude" | "image" | "shapes" | "update";

function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
	return (
		<div className="seg" role="group">
			{options.map((o) => <button key={String(o.v)} aria-pressed={o.v === value} onClick={() => onChange(o.v)}>{o.label}</button>)}
		</div>
	);
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
	return <div className="row"><div className="k">{k}</div><div className="v">{children}</div></div>;
}

export default function Settings({ onClose }: { onClose: () => void }) {
	const t = useT();
	const [tab, setTab] = useState<Tab>("general");
	const tabs: Tab[] = ["general", "claude", "image", "shapes", "update"];
	const names: Record<Tab, Key> = { general: "general", claude: "claude", image: "image", shapes: "shapes", update: "update" };
	return (
		<div className="settings" role="dialog" aria-label={t("settings")}>
			<nav>
				{tabs.map((x) => <button key={x} className={tab === x ? "on" : ""} onClick={() => setTab(x)}>{t(names[x])}</button>)}
				<button className="close" onClick={onClose}>{t("close")} <span className="mono" style={{ fontSize: 10 }}>Esc</span></button>
			</nav>
			<div className="pane">
				<h3>{t(names[tab])}</h3>
				{tab === "general" && <General />}
				{tab === "claude" && <Claude />}
				{tab === "image" && <Images />}
				{tab === "shapes" && <Shapes />}
				{tab === "update" && <Update />}
			</div>
		</div>
	);
}

function General() {
	const t = useT();
	const { s, set } = useSettings();
	return (
		<>
			<Row k={t("language")}><Seg value={s.lang} options={[{ v: "ko", label: "한국어" }, { v: "en", label: "English" }]} onChange={(lang) => set((x) => ({ ...x, lang }))} /></Row>
			<Row k={t("theme")}><Seg value={s.theme} options={[{ v: "system", label: t("themeSystem") }, { v: "dark", label: t("themeDark") }, { v: "light", label: t("themeLight") }]} onChange={(theme) => set((x) => ({ ...x, theme }))} /></Row>
			<Row k={t("libraryDir")}>
				<span className="mono" style={{ fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.library}</span>
				<button className="ghost" onClick={async () => { const p = await open({ directory: true, defaultPath: s.library }); if (typeof p === "string") set((x) => ({ ...x, library: p })); }}>{t("change")}</button>
			</Row>
		</>
	);
}

function Claude() {
	const t = useT();
	const { s, set } = useSettings();
	const c = s.claude;
	const put = (p: Partial<S["claude"]>) => set((x) => ({ ...x, claude: { ...x.claude, ...p } }));
	const [found, setFound] = useState<{ path: string; version: string } | null | undefined>(undefined);
	// 경로 칸을 칠 때마다 찾지 않는다 — 멈춘 뒤에 한 번
	useEffect(() => {
		setFound(undefined);
		const t = setTimeout(() => api.claudeDetect(c.path).then(setFound, () => setFound(null)), 400);
		return () => clearTimeout(t);
	}, [c.path]);
	return (
		<>
			<Row k={t("path")}>
				<input className="field mono" style={{ fontSize: 12 }} placeholder={t("auto")} value={c.path} onChange={(e) => put({ path: e.target.value })} />
				<span className={"note" + (found ? " ok" : "")}>{found === undefined ? "…" : found ? found.version.split(" ")[0] : t("noClaude")}</span>
			</Row>
			<Row k={t("model")}>
				<Seg value={["", "opus", "sonnet", "haiku", "fable"].includes(c.model) ? c.model : "custom"} options={[{ v: "", label: t("auto") }, { v: "opus", label: "Opus" }, { v: "sonnet", label: "Sonnet" }, { v: "haiku", label: "Haiku" }, { v: "fable", label: "Fable" }]} onChange={(model) => put({ model })} />
			</Row>
			<Row k={t("effort")}>
				<Seg value={c.effort} options={[{ v: "", label: t("auto") }, { v: "low", label: "low" }, { v: "medium", label: "medium" }, { v: "high", label: "high" }, { v: "xhigh", label: "xhigh" }, { v: "max", label: "max" }]} onChange={(effort) => put({ effort })} />
			</Row>
			<Row k={t("isolation")}><span className="note ok" style={{ whiteSpace: "normal" }}>{t("isolationOn")}</span></Row>
			<Row k={t("promptExtra")}>
				<textarea className="field" rows={4} value={c.extra} onChange={(e) => put({ extra: e.target.value })} />
			</Row>
			<div className="row" style={{ alignItems: "start" }}>
				<div className="k">{t("prompt")}</div>
				<div className="v" style={{ flexDirection: "column", alignItems: "stretch" }}>
					<textarea className="field" rows={16} value={c.prompt || BASE_PROMPT} onChange={(e) => put({ prompt: e.target.value === BASE_PROMPT ? "" : e.target.value })} />
					<div style={{ display: "flex", justifyContent: "space-between" }}>
						<span className="note">{c.prompt ? "custom" : "default"}</span>
						{c.prompt && <button className="ghost" onClick={() => put({ prompt: "" })}>default</button>}
					</div>
				</div>
			</div>
		</>
	);
}

function Images() {
	const t = useT();
	const { s, set } = useSettings();
	const im = s.image;
	const put = (p: Partial<S["image"]>) => set((x) => ({ ...x, image: { ...x.image, ...p } }));
	const [tools, setTools] = useState<Tool[] | null>(null);
	useEffect(() => { api.toolsDetect().then(setTools, () => setTools([])); }, []);
	const tool = (n: string) => tools?.find((x) => x.name === n);
	const list: { v: ImageProvider; label: Key; st: string; ok: boolean }[] = [
		{ v: "svg", label: "svg", st: "Claude", ok: true },
		{ v: "codex-cli", label: "codexCli", st: tools ? (tool("codex")?.path ? tool("codex")!.version.replace(/^codex-cli\s*/, "") || t("detected") : t("missing")) : "…", ok: !!tool("codex")?.path },
		{ v: "gemini-cli", label: "geminiCli", st: tools ? (tool("gemini")?.path ? tool("gemini")!.version || t("detected") : t("missing")) : "…", ok: !!tool("gemini")?.path },
		{ v: "openai", label: "openaiApi", st: im.openaiKey ? "key" : "", ok: !!im.openaiKey },
		{ v: "gemini", label: "geminiApi", st: im.geminiKey ? "key" : "", ok: !!im.geminiKey },
	];
	return (
		<>
			<div className="row" style={{ alignItems: "start" }}>
				<div className="k" style={{ paddingTop: 8 }}>{t("provider")}</div>
				<div className="v">
					<div className="providers">
						{list.map((p) => (
							<div key={p.v}>
								<button className="provider" aria-pressed={im.provider === p.v} onClick={() => put({ provider: p.v })} style={{ width: "100%" }}>
									<span className="r" /><span>{t(p.label)}</span><span className={"st" + (p.ok ? " ok" : "")}>{p.st}</span>
								</button>
								{im.provider === p.v && p.v === "openai" && (
									<div className="provider-extra">
										<input className="field mono" type="password" placeholder={t("apiKey")} value={im.openaiKey} onChange={(e) => put({ openaiKey: e.target.value })} />
										<input className="field mono" placeholder={t("model")} value={im.openaiModel} onChange={(e) => put({ openaiModel: e.target.value })} />
									</div>
								)}
								{im.provider === p.v && p.v === "gemini" && (
									<div className="provider-extra">
										<input className="field mono" type="password" placeholder={t("apiKey")} value={im.geminiKey} onChange={(e) => put({ geminiKey: e.target.value })} />
										<input className="field mono" placeholder={t("model")} value={im.geminiModel} onChange={(e) => put({ geminiModel: e.target.value })} />
									</div>
								)}
							</div>
						))}
					</div>
				</div>
			</div>
			<Row k={t("style")}><input className="field" placeholder="flat editorial illustration, muted palette" value={im.style} onChange={(e) => put({ style: e.target.value })} disabled={im.provider === "svg"} /></Row>
		</>
	);
}

const FONTS = ["Pretendard", "Malgun Gothic", "Noto Sans KR", "KoPubWorld돋움체 Medium", "Nanum Gothic", "Segoe UI"];

function Shapes() {
	const t = useT();
	const { s, set } = useSettings();
	const sh = s.shape;
	const put = (p: Partial<S["shape"]>) => set((x) => ({ ...x, shape: { ...x.shape, ...p } }));
	const deck = useDeck((x) => x.deck);
	const dir = useDeck((x) => x.dir);
	const notify = useDeck((x) => x.notify);
	const applyToDeck = async () => {
		// 열린 덱의 theme.css 에서 :root 변수만 바꾼다 — 나머지 서식은 그대로 둔다
		let css = await api.readText(dir, "theme.css");
		const vars: Record<string, string> = { "--ink": sh.ink, "--paper": sh.paper, "--accent": sh.accent, "--radius": sh.radius + "px", "--stroke": sh.stroke + "px", "--font": `"${sh.font}", "Malgun Gothic", sans-serif` };
		for (const [k, v] of Object.entries(vars)) css = css.replace(new RegExp(`(${k}\\s*:\\s*)[^;]+;`), `$1${v};`);
		await api.writeText(dir, "theme.css", css);
		notify("theme.css");
	};
	return (
		<>
			<Row k={t("font")}>
				<select className="field" value={FONTS.includes(sh.font) ? sh.font : ""} onChange={(e) => e.target.value && put({ font: e.target.value })}>
					{FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
					<option value="">…</option>
				</select>
				<input className="field" style={{ maxWidth: 160 }} value={sh.font} onChange={(e) => put({ font: e.target.value })} />
			</Row>
			<Row k={t("palette")}>
				{(["ink", "paper", "accent"] as const).map((k) => (
					<label key={k} style={{ display: "flex", gap: 6, alignItems: "center", marginRight: 10 }}>
						<span className="swatch" style={{ background: sh[k] }}><input type="color" value={sh[k]} onChange={(e) => put({ [k]: e.target.value.toUpperCase() })} aria-label={t(k)} /></span>
						<span className="note">{t(k)}</span>
					</label>
				))}
			</Row>
			<Row k={t("radius")}><div className="range"><input type="range" min={0} max={32} value={sh.radius} onChange={(e) => put({ radius: +e.target.value })} /><span>{sh.radius}px</span></div></Row>
			<Row k={t("stroke")}><div className="range"><input type="range" min={0.5} max={4} step={0.5} value={sh.stroke} onChange={(e) => put({ stroke: +e.target.value })} /><span>{sh.stroke}px</span></div></Row>
			<Row k={t("shadow")}><Seg value={sh.shadow} options={[{ v: "none", label: t("none") }, { v: "soft", label: t("soft") }]} onChange={(shadow) => put({ shadow })} /></Row>
			<Row k={t("iconStyle")}><Seg value={sh.icon} options={[{ v: "line", label: t("line") }, { v: "solid", label: t("solid") }]} onChange={(icon) => put({ icon })} /></Row>
			<Specimen sh={sh} />
			{deck && <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}><button className="ghost" onClick={applyToDeck}>theme.css ← {deck.title}</button></div>}
		</>
	);
}

/** 지금 설정으로 그린 작은 견본 쪽 — 바꾸는 즉시 따라 바뀐다 */
function Specimen({ sh }: { sh: S["shape"] }) {
	const sw = sh.stroke;
	const icon = (d: string) => sh.icon === "line"
		? <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={sh.ink} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
		: <svg width="26" height="26" viewBox="0 0 24 24" fill={sh.ink}><path d={d} /></svg>;
	return (
		<div className="specimen" style={{ background: sh.paper, color: sh.ink, fontFamily: `"${sh.font}", "Malgun Gothic", sans-serif` }}>
			<div style={{ position: "absolute", left: "6%", top: "14%", fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>Aa 가나 123</div>
			<div style={{ position: "absolute", left: "6%", top: "34%", fontSize: 11, opacity: 0.6 }}>{sh.font}</div>
			<div style={{ position: "absolute", left: "6%", bottom: "14%", display: "flex", gap: 10 }}>
				{[0, 1, 2].map((i) => (
					<div key={i} style={{ width: 70, height: 46, borderRadius: sh.radius * 0.5, border: `${sw}px solid ${i === 1 ? sh.accent : "color-mix(in srgb, " + sh.ink + " 18%, " + sh.paper + ")"}`, background: i === 1 ? `color-mix(in srgb, ${sh.accent} 10%, ${sh.paper})` : "transparent", boxShadow: sh.shadow === "soft" ? "0 4px 12px rgba(0,0,0,.10)" : "none" }} />
				))}
			</div>
			<div style={{ position: "absolute", right: "6%", top: "16%", display: "flex", gap: 12 }}>
				{icon("M4 12h16M12 4v16")}
				{icon("M12 3l8 4.5v9L12 21l-8-4.5v-9z")}
				{icon("M5 19V9m7 10V5m7 14v-7")}
			</div>
			<div style={{ position: "absolute", right: "6%", bottom: "14%", width: 120, height: 8, borderRadius: 4, background: sh.accent }} />
		</div>
	);
}

function Update() {
	const t = useT();
	const { s, set } = useSettings();
	const u = useUpdate();
	const [ver, setVer] = useState("");
	useEffect(() => { getVersion().then(setVer); }, []);
	return (
		<>
			<Row k={t("version")}><span className="mono">{ver}</span></Row>
			<Row k={t("autoCheck")}><Seg value={s.update.auto ? 1 : 0} options={[{ v: 1, label: "on" }, { v: 0, label: "off" }]} onChange={(v) => set((x) => ({ ...x, update: { auto: !!v } }))} /></Row>
			<Row k={t("check")}>
				<button className="ghost" onClick={() => u.run()} disabled={u.phase === "checking" || u.phase === "downloading"}>{t("check")}</button>
				{u.phase === "latest" && <span className="note ok">{t("latest")}</span>}
				{u.phase === "checking" && <span className="note">…</span>}
				{u.phase === "available" && <><span className="mono">{u.version}</span><button className="send" onClick={u.install}>{t("install")}</button></>}
				{u.phase === "downloading" && <span className="mono">{Math.round(u.progress * 100)}%</span>}
				{u.phase === "error" && <span className="note" style={{ color: "var(--err)", whiteSpace: "normal" }}>{u.error}</span>}
			</Row>
			{u.notes && <Row k={t("notes")}><span style={{ whiteSpace: "pre-wrap" }}>{u.notes}</span></Row>}
		</>
	);
}
