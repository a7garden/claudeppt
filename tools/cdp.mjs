// 개발용 — WebView2 원격 디버깅(9333)에 붙어 앱 화면에서 JS 를 돌리거나 화면을 찍는다.
// 쓰는 법: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 npm run tauri dev
//         node tools/cdp.mjs eval "<js>"        결과를 JSON 으로
//         node tools/cdp.mjs shot <out.png>     화면 찍기
//         node tools/cdp.mjs click "x,y" · rclick "x,y" · drag "x0,y0,x1,y1" · type "글"  누르기 · 우클릭 · 끌기 · 글 넣기
import fs from "node:fs";
const [cmd, raw] = process.argv.slice(2);
const arg = raw?.startsWith("@") ? fs.readFileSync(raw.slice(1), "utf8") : raw;
const list = await (await fetch("http://127.0.0.1:9333/json")).json();
// CDP_TARGET=<주소 조각> 이면 그 주소의 대상(슬라이드 iframe 등)에 붙는다
const want = process.env.CDP_TARGET;
const page = want ? list.find((p) => p.url.includes(want)) : list.find((p) => p.type === "page" && /localhost:1424|tauri\.localhost/.test(p.url)) || list.find((p) => p.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const call = (method, params = {}) => new Promise((resolve) => {
	const my = ++id;
	const on = (e) => { const m = JSON.parse(e.data); if (m.id === my) { ws.removeEventListener("message", on); resolve(m); } };
	ws.addEventListener("message", on);
	ws.send(JSON.stringify({ id: my, method, params }));
});
if (cmd === "eval") {
	const r = await call("Runtime.evaluate", { expression: arg, awaitPromise: true, returnByValue: true });
	console.log(JSON.stringify(r.result?.result?.value ?? r.result, null, 1));
} else if (cmd === "click" || cmd === "rclick") {
	// node tools/cdp.mjs click "x,y" — 실제 마우스 누름 · rclick 은 오른쪽 단추(우클릭 메뉴 시험)
	const [x, y] = arg.split(",").map(Number);
	const button = cmd === "rclick" ? "right" : "left";
	for (const type of ["mousePressed", "mouseReleased"]) await call("Input.dispatchMouseEvent", { type, x, y, button, clickCount: 1 });
} else if (cmd === "drag") {
	// node tools/cdp.mjs drag "x0,y0,x1,y1" — 눌러서 끌고 놓기 (표시 긋기 시험). 사이를 12걸음으로 나눠 움직인다
	const [x0, y0, x1, y1] = arg.split(",").map(Number);
	await call("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", buttons: 1, clickCount: 1 });
	for (let k = 1; k <= 12; k++) await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0 + ((x1 - x0) * k) / 12, y: y0 + ((y1 - y0) * k) / 12 + Math.sin(k / 2) * 8, button: "left", buttons: 1 });
	await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", buttons: 0, clickCount: 1 });
} else if (cmd === "type") {
	await call("Input.insertText", { text: arg });
} else if (cmd === "shot") {
	const r = await call("Page.captureScreenshot", { format: "png" });
	fs.writeFileSync(arg, Buffer.from(r.result.data, "base64"));
	console.log(arg);
}
ws.close();
