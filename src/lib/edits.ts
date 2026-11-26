// 직접 편집을 원본 HTML 에 되쓴다. 런타임이 보낸 「자식 번호 길」로 원본 DOM 에서 같은 요소를 찾는다.
// 화면의 DOM 과 원본을 DOMParser 로 읽은 DOM 은 같은 HTML 에서 나와 길이 맞는다 (런타임 스크립트는 .slide 밖 맨 끝에 붙는다).
//   edit    글자를 고쳤다 (innerHTML)          patch   서식 · 자리 · 크기 (style 속성, 빈 값은 지운다)
//   remove  지웠다                            append  쪽 맨 위(마지막 자식)에 새 요소 — 서식 띠의 삽입 · 붙여 넣기
//   after   그 요소 바로 뒤에 새 요소 — 복제     order   같은 부모 안에서 자리(z 순서)를 바꾼다
import { api } from "./api";

export type Op =
	| { t: "edit"; html: string }
	| { t: "patch"; style: Record<string, string> }
	| { t: "remove" }
	| { t: "append"; html: string }
	| { t: "after"; html: string }
	| { t: "order"; to: number };

export async function applyOp(dir: string, file: string, p: number[] | null, op: Op) {
	if (!p) return false;
	const src = await api.readText(dir, file);
	const doc = new DOMParser().parseFromString(src, "text/html");
	const root = doc.querySelector(".slide") || doc.body;
	let el: Element | null = root;
	for (const i of p) el = el?.children[i] ?? null;
	if (!el) return false;
	// 쪽 뿌리에 할 수 있는 것은 덧붙이기뿐이다 — 뿌리를 지우거나 고치면 쪽이 통째로 사라진다
	if (op.t === "append") el.insertAdjacentHTML("beforeend", op.html);
	else if (el === root) return false;
	else if (op.t === "edit") el.innerHTML = op.html;
	else if (op.t === "patch") for (const [k, v] of Object.entries(op.style)) (el as HTMLElement).style.setProperty(k, v);
	else if (op.t === "after") el.insertAdjacentHTML("afterend", op.html);
	else if (op.t === "order") {
		const parent = el.parentElement!;
		el.remove();
		parent.insertBefore(el, parent.children[op.to] ?? null);
	} else el.remove();
	const doctype = /^\s*<!doctype[^>]*>/i.exec(src)?.[0] ?? "<!doctype html>";
	await api.writeText(dir, file, doctype + "\n" + doc.documentElement.outerHTML + "\n");
	return true;
}
