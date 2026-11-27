// 직접 편집을 원본 HTML 에 되쓴다. 런타임이 보낸 「자식 번호 길」로 원본 DOM 에서 같은 요소를 찾는다.
// 화면의 DOM 과 원본을 DOMParser 로 읽은 DOM 은 같은 HTML 에서 나와 길이 맞는다 (런타임 스크립트는 .slide 밖 맨 끝에 붙는다).
//   edit    글자를 고쳤다 (innerHTML)          patch   서식 · 자리 · 크기 (style 속성, 빈 값은 지운다)
//   remove  지웠다                            append  쪽 맨 위(마지막 자식)에 새 요소 — 서식 띠의 삽입 · 붙여 넣기
//   after   그 요소 바로 뒤에 새 요소 — 복제     order   같은 부모 안에서 자리(z 순서)를 바꾼다
//   batch   여러 요소를 한 번에 (여러 개 고르고 옮기기 · 맞춤 · 묶기). 파일 한 번 쓰기 · 되돌리기 한 칸.
//           ops 는 런타임이 한 것과 같은 차례로 적용한다. 길은 앞의 op 가 적용된 뒤의 문서에서 잰 것이라 차례가 맞으면 지우기 · 넣기가 섞여도 같은 요소를 찾는다
import { api } from "./api";

export type Op =
	| { t: "edit"; html: string }
	| { t: "patch"; style: Record<string, string> }
	| { t: "remove" }
	| { t: "append"; html: string }
	| { t: "after"; html: string }
	| { t: "order"; to: number }
	| { t: "batch"; ops: { path: number[] | null; op: Op }[] };

/** 글 줄 안에 드는 꾸밈 요소 — 핀이 낱말 하나에 꽂혀도 그 낱말을 감싼 것이 아니라 그 문단 · 제목을 가리키게 */
const INLINE = new Set(["SPAN", "B", "STRONG", "I", "EM", "U", "A", "BR", "SUP", "SUB", "CODE", "SMALL", "MARK", "S", "DEL", "INS", "LABEL", "ABBR", "Q"]);

/**
 * 핀이 가리킨 요소를 원본 HTML 에서 찾아 Claude 가 바로 찾아갈 꼴로 — CSS 경로(nth-child)와 그 요소의 HTML 조각 (2026.11.27).
 * 전에는 「<div> "글"」만 넘겨, 같은 글이 여럿이거나 글 없는 요소(그림 · 도형 · 상자)면 Claude 가 쪽 전체를 보고 짐작했다.
 * label 은 핀을 꽂을 때 그 요소의 글 — 그 뒤 쪽이 바뀌어 같은 길이 다른 요소를 가리키면(글이 안 맞으면) 돌려주지 않는다
 */
export function locate(src: string, path: number[] | null, label = ""): { css: string; html: string } | null {
	if (!path?.length) return null;
	const doc = new DOMParser().parseFromString(src, "text/html");
	const root = doc.querySelector(".slide") || doc.body;
	const chain: Element[] = [];
	let el: Element | null = root;
	for (const i of path) {
		el = el?.children[i] ?? null;
		if (!el) return null;
		chain.push(el);
	}
	// 핀의 글은 화면에 보인 글(innerText · 대문자 꾸밈) 또는 그림의 alt, 60자에서 잘린다 — 앞부분만 대소문자 없이 견준다
	const want = label.replace(/\s+/g, " ").replace(/…$/, "").trim().slice(0, 24).toLowerCase();
	const have = `${el!.textContent ?? ""} ${el!.getAttribute("alt") ?? ""}`.replace(/\s+/g, " ").toLowerCase();
	if (want && !have.includes(want)) return null;
	// 낱말을 감싼 꾸밈 요소면 그것을 담은 덩어리까지 올라간다
	while (chain.length > 1 && INLINE.has(chain[chain.length - 1].tagName)) chain.pop();
	const head = root.tagName.toLowerCase() + (root.classList[0] ? `.${root.classList[0]}` : "");
	const css = [head, ...chain.map((e) => `${e.tagName.toLowerCase()}:nth-child(${[...e.parentElement!.children].indexOf(e) + 1})`)].join(" > ");
	const html = chain[chain.length - 1].outerHTML.replace(/\s+/g, " ");
	return { css, html: html.length > 700 ? html.slice(0, 700) + " …" : html };
}

export async function applyOp(dir: string, file: string, p: number[] | null, op: Op) {
	const src = await api.readText(dir, file);
	const doc = new DOMParser().parseFromString(src, "text/html");
	const root = doc.querySelector(".slide") || doc.body;
	const ok = op.t === "batch" ? op.ops.length > 0 && op.ops.every((x) => x.op.t !== "batch" && applyOne(root, x.path, x.op)) : applyOne(root, p, op);
	// 묶음의 한 op 라도 길을 못 찾으면 쓰지 않는다: 반만 적용된 쪽은 화면과 원본이 어긋난다
	if (!ok) return false;
	const doctype = /^\s*<!doctype[^>]*>/i.exec(src)?.[0] ?? "<!doctype html>";
	await api.writeText(dir, file, doctype + "\n" + doc.documentElement.outerHTML + "\n");
	return true;
}

function applyOne(root: Element, p: number[] | null, op: Op) {
	if (!p) return false;
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
	} else if (op.t === "remove") el.remove();
	else return false;
	return true;
}
