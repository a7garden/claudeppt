import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(() => ({
	plugins: [react()],
	resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
	clearScreen: false,
	build: { chunkSizeWarningLimit: 1600 },
	server: {
		// Tauri 가 고정 포트를 기다린다 — 포트가 차 있으면 다른 포트로 넘어가지 않고 실패해야 한다.
		port: 1424,
		strictPort: true,
		host: host || false,
		hmr: host ? { protocol: "ws", host, port: 1425 } : undefined,
		watch: { ignored: ["**/src-tauri/**"] },
	},
}));
