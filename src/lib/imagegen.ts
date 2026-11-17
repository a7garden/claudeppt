// Claude 가 남긴 그림 자리(<img data-gen="…">, src 없음)를 설정의 그림 공급자로 채운다. 턴이 끝난 뒤 판을 남기기 전에 돈다.
import { api, join } from "./api";
import type { Deck } from "./deck";
import type { Settings } from "./settings";

export async function fillGenerated(dir: string, deck: Deck, s: Settings, onStep: (msg: string) => void): Promise<string[]> {
	if (s.image.provider === "svg") return [];
	const errors: string[] = [];
	for (const ref of deck.slides) {
		let src: string;
		try { src = await api.readText(dir, ref.file); } catch { continue; }
		if (!src.includes("data-gen")) continue;
		const doc = new DOMParser().parseFromString(src, "text/html");
		const todo = [...doc.querySelectorAll<HTMLImageElement>("img[data-gen]")].filter((i) => !i.getAttribute("src"));
		if (!todo.length) continue;
		for (const img of todo) {
			const prompt = img.getAttribute("data-gen")!;
			onStep(prompt.slice(0, 60));
			const name = `gen-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.png`;
			try {
				await api.imageGenerate({
					provider: s.image.provider,
					prompt: s.image.style ? `${prompt}\n\nStyle: ${s.image.style}` : prompt,
					out: join(dir, "assets", name),
					apiKey: s.image.provider === "openai" ? s.image.openaiKey : s.image.provider === "gemini" ? s.image.geminiKey : "",
					model: s.image.provider === "openai" ? s.image.openaiModel : s.image.provider === "gemini" ? s.image.geminiModel : "",
					size: img.getAttribute("data-gen-size") || "",
				});
				img.setAttribute("src", `../assets/${name}`);
			} catch (e) {
				errors.push(String(e));
			}
		}
		const doctype = /^\s*<!doctype[^>]*>/i.exec(src)?.[0] ?? "<!doctype html>";
		await api.writeText(dir, ref.file, doctype + "\n" + doc.documentElement.outerHTML + "\n");
	}
	return errors;
}
