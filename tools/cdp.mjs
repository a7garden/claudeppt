// 개발용 — WebView2 원격 디버깅(9333)에 붙어 앱 화면에서 JS 를 돌리거나 화면을 찍는다.
// 쓰는 법: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 npm run tauri dev
//         node tools/cdp.mjs eval "<js>"        결과를 JSON 으로
//         node tools/cdp.mjs shot <out.png>     화면 찍기
//         node tools/cdp.mjs click "x,y" · type "글"  누르기 · 글 넣기
import fs from "node:fs";
const [cmd, raw] = process.argv.slice(2);
const arg = raw?.startsWith("@") ? fs.readFileSync(raw.slice(1), "utf8") : raw;
const list = await (await fetch("http://127.0.0.1:9333/json")).json();
const page = list.find((p) => p.type === "page" && /localhost:1424|tauri\.localhost/.test(p.url)) || list.find((p) => p.type === "page");
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
} else if (cmd === "click") {
	// node tools/cdp.mjs click "x,y" — 실제 마우스 누름
	const [x, y] = arg.split(",").map(Number);
	for (const type of ["mousePressed", "mouseReleased"]) await call("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
} else if (cmd === "type") {
	await call("Input.insertText", { text: arg });
} else if (cmd === "shot") {
	const r = await call("Page.captureScreenshot", { format: "png" });
	fs.writeFileSync(arg, Buffer.from(r.result.data, "base64"));
	console.log(arg);
}
ws.close();
