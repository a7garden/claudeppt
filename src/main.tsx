import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/app.css";

createRoot(document.getElementById("root")!).render(<App />);

// 개발 실행에서만 — tools/cdp.mjs 로 화면을 시험할 때 상태에 닿는 길
if (import.meta.env.DEV) {
	Promise.all([import("./lib/store"), import("./lib/settings"), import("./lib/flows"), import("./lib/api")]).then(([st, se, fl, api]) => {
		(window as any).__app = { deck: st.useDeck, settings: se.useSettings, flows: fl, api: api.api };
	});
}
