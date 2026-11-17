// 슬라이드 iframe(런타임 rt.js)과 주고받는 말. 슬라이드는 deck:// 의 다른 출처라 postMessage 로만 닿는다.
import { deckUrl } from "./api";

type Msg = { __deck: 1; t: string; req?: string; [k: string]: any };
const waiting = new Map<string, (m: Msg) => void>();
const subs = new Set<(m: Msg, src: MessageEventSource | null) => void>();

window.addEventListener("message", (e) => {
	const m = e.data as Msg;
	if (!m || !m.__deck) return;
	if (m.req && waiting.has(m.req)) {
		waiting.get(m.req)!(m);
		waiting.delete(m.req);
		return;
	}
	for (const f of subs) f(m, e.source);
});

export const onFrame = (f: (m: Msg, src: MessageEventSource | null) => void) => {
	subs.add(f);
	return () => void subs.delete(f);
};

export const tell = (win: Window | null | undefined, msg: Record<string, unknown>) => win?.postMessage({ __deck: 1, ...msg }, "*");

export function ask<T = Msg>(win: Window, msg: Record<string, unknown>, ms = 20000): Promise<T> {
	const req = Math.random().toString(36).slice(2);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { waiting.delete(req); reject(new Error("슬라이드가 답하지 않는다")); }, ms);
		waiting.set(req, (m) => { clearTimeout(timer); resolve(m as T); });
		win.postMessage({ __deck: 1, ...msg, req }, "*");
	});
}

/** 화면 밖에 1:1 크기 iframe 을 띄워 런타임이 준비되면 넘긴다. 내보내기 · 썸네일 굽기에 쓴다. */
export function offscreen(id: string, file: string, w: number, h: number): Promise<{ win: Window; dispose: () => void }> {
	return new Promise((resolve, reject) => {
		const f = document.createElement("iframe");
		f.style.cssText = `position:fixed;left:-${w + 200}px;top:0;width:${w}px;height:${h}px;border:0;visibility:hidden;pointer-events:none`;
		const dispose = () => { off(); f.remove(); };
		const timer = setTimeout(() => { dispose(); reject(new Error(`${file} 을 열지 못했다`)); }, 20000);
		const off = onFrame((m, src) => {
			if (m.t === "ready" && src === f.contentWindow) {
				clearTimeout(timer);
				off();
				resolve({ win: f.contentWindow!, dispose: () => f.remove() });
			}
		});
		f.src = deckUrl(id, file) + "?x=" + Date.now();
		document.body.appendChild(f);
	});
}
