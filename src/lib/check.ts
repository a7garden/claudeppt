// 웹 ↔ PPT 비교 검사 — 내보낸 PPTX 를 PowerPoint 가 그린 쪽 그림과, 웹이 그린 슬라이드를 1:1 픽셀로 견준다.
//
//   1. 지금 덱을 PPTX 로 만든다 (.claudeppt/check/check.pptx)
//   2. PowerPoint 로 쪽마다 덱 크기 그대로 그린다 (.claudeppt/check/ppt/<n>.png)
//   3. 웹 슬라이드를 런타임이 1:1 로 굽는다 (.claudeppt/check/web/<id>.png)
//   4. 픽셀마다 견주어 다른 곳을 빨갛게 칠한 그림과 차이 비율을 남긴다 (.claudeppt/check/diff/<id>.png · report.json)
//
// 글자 가장자리의 흐림(안티에일리어싱)과 1px 어긋남은 차이로 세지 않는다 — 주변 3×3 안에 같은 색이 있으면 같다고 본다.
// 그래도 남는 1px 너비의 선(글자 획 가장자리 — 두 엔진의 힌팅 차이)도 뺀다: 이웃 8칸 중 4칸 넘게 다른 점만 센다.
// 그래야 남는 차이가 사람 눈에 보이는 차이(빠진 도형 · 다른 색 · 2px 넘게 어긋난 글자)다.
// 2026.11.17 : Pretendard 덱에서 위치 · 크기 · 줄바꿈이 다 맞은 뒤에도 획 가장자리만으로 0.2~0.3% 가 남아 이 거름을 더했다.
import { api, deckUrl, join } from "./api";
import type { Deck } from "./deck";
import { buildPptx } from "./exportPptx";
import { ask, offscreen } from "./frames";

export interface SlideCheck { id: string; no: number; score: number; web: string; ppt: string; diff: string }
export interface Report { at: string; version: number; slides: SlideCheck[]; missingFonts: string[] }

const BASE = ".claudeppt/check";
/** 채널 차이가 이보다 크면 다른 픽셀 */
const THRESHOLD = 48;

async function load(src: string) {
	const im = new Image();
	im.crossOrigin = "anonymous";
	im.src = src;
	await im.decode();
	return im;
}

function pixels(im: HTMLImageElement, w: number, h: number) {
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	const g = c.getContext("2d", { willReadFrequently: true })!;
	g.fillStyle = "#fff";
	g.fillRect(0, 0, w, h);
	g.drawImage(im, 0, 0, w, h);
	return g.getImageData(0, 0, w, h).data;
}

/** 두 그림의 차이 — 다른 픽셀 비율(%)과 빨간 덧칠 그림(data URL) */
export function compare(a: Uint8ClampedArray, b: Uint8ClampedArray, w: number, h: number) {
	const out = new ImageData(w, h);
	const raw = new Uint8Array(w * h);
	let count = 0;
	const near = (i: number, x: number, y: number) => {
		for (let dy = -1; dy <= 1; dy++) {
			const yy = y + dy;
			if (yy < 0 || yy >= h) continue;
			for (let dx = -1; dx <= 1; dx++) {
				const xx = x + dx;
				if (xx < 0 || xx >= w) continue;
				const j = (yy * w + xx) * 4;
				if (Math.max(Math.abs(a[i] - b[j]), Math.abs(a[i + 1] - b[j + 1]), Math.abs(a[i + 2] - b[j + 2])) <= THRESHOLD) return true;
			}
		}
		return false;
	};
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
			if (d <= THRESHOLD || near(i, x, y)) continue;
			raw[y * w + x] = 1;
		}
	}
	for (let y = 1; y < h - 1; y++) {
		for (let x = 1; x < w - 1; x++) {
			const k = y * w + x;
			if (!raw[k]) continue;
			const n = raw[k - w - 1] + raw[k - w] + raw[k - w + 1] + raw[k - 1] + raw[k + 1] + raw[k + w - 1] + raw[k + w] + raw[k + w + 1];
			if (n <= 4) continue;
			count++;
			const i = k * 4;
			out.data[i] = 232;
			out.data[i + 1] = 40;
			out.data[i + 2] = 30;
			out.data[i + 3] = 220;
		}
	}
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	c.getContext("2d")!.putImageData(out, 0, 0);
	return { score: Math.round((count / (w * h)) * 10000) / 100, mask: c.toDataURL("image/png") };
}

export async function runCheck(dir: string, id: string, deck: Deck, version: number, step: (msg: string) => void): Promise<Report> {
	const { w, h } = deck.size;
	step("PPTX");
	const built = await buildPptx(deck, id, (i, n) => step(`PPTX ${i}/${n}`));
	await api.writeBytes(dir, `${BASE}/check.pptx`, built.data);
	step("PowerPoint");
	const pages = await api.pptSnapshot(join(dir, ".claudeppt", "check", "check.pptx"), join(dir, ".claudeppt", "check", "ppt"), w, h);
	if (!pages) throw new Error("PowerPoint 로 쪽 그림을 뽑지 못했다");
	const slides: SlideCheck[] = [];
	const stamp = Date.now();
	for (let i = 0; i < deck.slides.length; i++) {
		const ref = deck.slides[i];
		step(`${i + 1}/${deck.slides.length}`);
		const { win, dispose } = await offscreen(id, ref.file, w, h);
		let snap: any;
		try { snap = await ask(win, { t: "snapshot", scale: 1 }, 60000); } finally { dispose(); }
		if (snap.error) throw new Error(`${i + 1}쪽: ${snap.error}`);
		const web = `${BASE}/web/${ref.id}.png`, ppt = `${BASE}/ppt/${i + 1}.png`, diff = `${BASE}/diff/${ref.id}.png`;
		await api.writeB64(dir, web, snap.data.split(",")[1]);
		const [wi, pi] = await Promise.all([load(snap.data), load(deckUrl(id, ppt) + "?t=" + stamp)]);
		const r = compare(pixels(wi, w, h), pixels(pi, w, h), w, h);
		await api.writeB64(dir, diff, r.mask.split(",")[1]);
		slides.push({ id: ref.id, no: i + 1, score: r.score, web, ppt, diff });
	}
	const report: Report = { at: new Date().toISOString(), version, slides, missingFonts: built.missingFonts };
	await api.writeText(dir, `${BASE}/report.json`, JSON.stringify(report, null, 1));
	return report;
}

export async function readReport(dir: string): Promise<Report | null> {
	try { return JSON.parse(await api.readText(dir, `${BASE}/report.json`)); } catch { return null; }
}

/** 차이가 이보다 작으면 같다고 본다(%) — 글자 가장자리 몇 점 */
export const SAME = 0.05;
