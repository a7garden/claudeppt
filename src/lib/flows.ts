// 프로젝트를 들이는 길 — 새로 만들기 · PPTX 가져오기 · 폴더나 .cppt 열기. 처음 화면과 끌어 놓기가 함께 쓴다.
import { api, join } from "./api";
import { createDeck, readDeck, safeName, writeDeck } from "./deck";
import { importPptx } from "./importPptx";
import { useSettings } from "./settings";
import { useDeck } from "./store";
import { tNow } from "./i18n";

async function freeDir(name: string) {
	const lib = useSettings.getState().s.library;
	let n = safeName(name), i = 2;
	const base = n;
	while (await api.exists(lib, n)) n = `${base} ${i++}`;
	return join(lib, n);
}

const titleOf = (brief: string) => {
	const line = brief.trim().split(/\r?\n/)[0];
	return line.length > 48 ? line.slice(0, 46) + "…" : line;
};

export async function startNew(brief: string) {
	const s = useSettings.getState().s;
	const title = brief.trim() ? titleOf(brief) : tNow("untitled");
	const dir = await freeDir(title);
	await createDeck(dir, title, s);
	await useDeck.getState().openProject(dir);
	if (brief.trim()) useDeck.getState().send(brief.trim());
}

export async function importFile(path: string) {
	const st = useDeck.getState();
	const name = path.split(/[\\/]/).pop()!.replace(/\.pptx$/i, "");
	const dir = await freeDir(name);
	useDeck.setState({ busy: tNow("importing") });
	try {
		const bytes = Uint8Array.from(atob(await api.absRead(path)), (c) => c.charCodeAt(0));
		const { deck: imported, warnings } = await importPptx(bytes, dir, name, useSettings.getState().s, (i, n) => useDeck.setState({ busy: `${tNow("importing")} ${i}/${n}` }));
		await st.openProject(dir);
		if (warnings.length) {
			const ko = useSettings.getState().s.lang === "ko";
			const names: Record<string, [string, string]> = { emf: ["EMF 그림", "EMF images"], chart: ["차트", "charts"], object: ["개체", "objects"], custGeom: ["자유형 도형", "freeform shapes"] };
			st.notify((ko ? "원본과 다를 수 있음 — " : "May differ from original — ") + warnings.map((w) => names[w]?.[ko ? 0 : 1] || w).join(" · "));
		}
		// 원본 쪽 그림 — PowerPoint 가 있으면 뒤에서 뽑는다. 없으면 조용히 넘어간다
		api.pptSnapshot(join(dir, "source", "original.pptx"), join(dir, "source", "pages"), imported.size.w, imported.size.h).then(async (pages) => {
			if (!pages) return;
			const deck = await readDeck(dir);
			deck.source = { ...(deck.source || { kind: "pptx" }), pages };
			await writeDeck(dir, deck);
			await api.commit(dir, "원본 쪽 그림을 남긴다");
			useDeck.getState().refreshVersions();
		}, () => {});
	} catch (e) {
		st.notify(String(e), "err");
	} finally {
		useDeck.setState({ busy: null });
	}
}

export async function openAny(path: string) {
	const st = useDeck.getState();
	try {
		if (/\.pptx$/i.test(path)) return await importFile(path);
		if (/\.cppt$/i.test(path)) {
			const name = path.split(/[\\/]/).pop()!.replace(/\.cppt$/i, "");
			const dir = await api.unpack(path, await freeDir(name));
			return await st.openProject(dir);
		}
		const dir = /deck\.json$/i.test(path) ? path.replace(/[\\/]deck\.json$/i, "") : path;
		await st.openProject(dir);
	} catch (e) {
		st.notify(String(e), "err");
	}
}
