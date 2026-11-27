// 슬라이드 iframe(런타임 rt.js)과 주고받는 말. 슬라이드는 deck:// 의 다른 출처라 postMessage 로만 닿는다.
import { deckUrl } from "./api";

/** 슬라이드 iframe 의 sandbox — 스크립트만 허락하고 출처는 이름 없는 것으로. 앱 창의 쪽 · 화면 밖 쪽(내보내기 · 썸네일) 모두 같다 (Workspace.tsx SlideFrame) */
export const SLIDE_SANDBOX = "allow-scripts";

type Msg = { __deck: 1; t: string; req?: string; [k: string]: any };
const waiting = new Map<string, (m: Msg) => void>();
const kept = new Map<string, unknown>();
const subs = new Set<(m: Msg, src: MessageEventSource | null) => void>();

window.addEventListener("message", (e) => {
	const m = e.data as Msg;
	if (!m || !m.__deck) return;
	if (m.t === "menu") return refire(m, e.source);
	// 고친 요소의 길을 다시 뜬 쪽에 넘긴다 (rt.js keep). 슬라이드는 sandbox 라 sessionStorage 를 못 쓴다
	if (m.t === "keep") return void kept.set(m.key, m.k);
	if (m.t === "keepAsk") {
		const k = kept.get(m.key) ?? null;
		kept.delete(m.key);
		return void (e.source as Window | null)?.postMessage({ __deck: 1, t: "keepIs", k }, "*");
	}
	if (m.req && waiting.has(m.req)) {
		waiting.get(m.req)!(m);
		waiting.delete(m.req);
		return;
	}
	for (const f of subs) f(m, e.source);
});

/** 슬라이드 창 안의 우클릭을 그 iframe 에 다시 쏜다 — 앱의 onContextMenu 들이 보통 우클릭처럼 받는다.
 *  창이 잰 자리(1:1 슬라이드 픽셀)와 그 자리 요소는 사건의 __deck 에 붙인다. iframe 은 transform 으로 줄여 그리므로 배율을 곱한다 */
function refire(m: Msg, src: MessageEventSource | null) {
	for (const f of document.querySelectorAll("iframe")) {
		if (f.contentWindow !== src) continue;
		const r = f.getBoundingClientRect();
		const k = r.width / (f.offsetWidth || r.width);
		const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + m.x * k, clientY: r.top + m.y * k });
		(ev as MouseEvent & { __deck?: Msg }).__deck = m;
		f.dispatchEvent(ev);
		return;
	}
}

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

/** 화면 밖에 1:1 크기 iframe 을 띄워 런타임이 준비되면 넘긴다. 내보내기 · 썸네일 굽기 · 판 비교에 쓴다. rev 를 주면 그 판의 쪽이다. */
export function offscreen(id: string, file: string, w: number, h: number, rev?: string): Promise<{ win: Window; dispose: () => void }> {
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
		f.setAttribute("sandbox", SLIDE_SANDBOX);
		f.src = deckUrl(id, file, rev) + "?x=" + Date.now();
		document.body.appendChild(f);
	});
}
