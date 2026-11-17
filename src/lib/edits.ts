// 직접 편집을 원본 HTML 에 되쓴다. 런타임이 보낸 「자식 번호 길」로 원본 DOM 에서 같은 요소를 찾는다.
// 화면의 DOM 과 원본을 DOMParser 로 읽은 DOM 은 같은 HTML 에서 나와 길이 맞는다 (런타임 스크립트는 .slide 밖 맨 끝에 붙는다).
import { api } from "./api";

export type Op = { t: "edit"; html: string } | { t: "patch"; style: Record<string, string> } | { t: "remove" };

export async function applyOp(dir: string, file: string, p: number[] | null, op: Op) {
	if (!p) return false;
	const src = await api.readText(dir, file);
	const doc = new DOMParser().parseFromString(src, "text/html");
	const root = doc.querySelector(".slide") || doc.body;
	let el: Element | null = root;
	for (const i of p) el = el?.children[i] ?? null;
	if (!el || el === root) return false;
	if (op.t === "edit") el.innerHTML = op.html;
	else if (op.t === "patch") for (const [k, v] of Object.entries(op.style)) (el as HTMLElement).style.setProperty(k, v);
	else el.remove();
	const doctype = /^\s*<!doctype[^>]*>/i.exec(src)?.[0] ?? "<!doctype html>";
	await api.writeText(dir, file, doctype + "\n" + doc.documentElement.outerHTML + "\n");
	return true;
}
