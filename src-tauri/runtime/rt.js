// 슬라이드 런타임 — deck:// 이 슬라이드 HTML 을 내줄 때 </body> 앞에 끼워 넣는다 (원본 파일에는 없다).
// 앱 화면(부모 창)과 postMessage 로만 말한다. 슬라이드 좌표는 늘 1:1 픽셀(보통 1280×720)이다 — 확대 · 축소는 부모가 한다.
//
// 목차
//   pathOf · label        요소 ↔ 자식 번호 길 (원본 HTML 에 되쓸 때 같은 요소를 찾는다)
//   편집                  고르기 · 글자 고치기 · 옮기기 · 크기 손잡이 · 넣기 · 순서 · 맞춤 · 복제 · 복사 · 서식 (서식 띠 명령 cmd)
//                         · 글머리 기호 · 번호 · 표 넣기와 행 · 열 · 서식 복사 · 서식 지우기 · 기호
//   message               부모 창이 보낸 말 처리
//   굽기                  bake — 브라우저가 그린 그대로 PNG (PowerPoint 가 같게 못 그리는 것 · 비교 검사)
//   PPTX 좌표 뽑기        color · runsOf(글자 조각과 줄 바꿈 자리) · extract — 도형으로 같게 그릴 수 있으면 도형, 아니면 굽기
//
// 받는 말                         보내는 말
//   css                 CSS 만 다시 읽기       ready {w,h}
//   mode {mode}         view · pin · edit      hit {req, path, tag, text}
//   hit {req,x,y}       그 자리 요소 찾기       edit {path, html}         글자를 고쳤다
//   extract {req}       PPTX 용 좌표 뽑기      patch {path, style}       끌어 옮겼다 · 크기를 바꿨다
//   snapshot {req}      슬라이드 전체 굽기     snapshot {req, data}
//   audit {req}         감사용 서식 재기       audited {req, data}
//                                              remove {path}             지웠다
//                                              extracted {req, data}
//                                              wheel {dy} · key {key}    휠 · 쪽 넘김 키 (무대가 쪽을 넘긴다)
//                                              menu {x, y, path, tag, text}  우클릭 — 앱이 그 자리에 메뉴를 연다
//   cmd {cmd, v}        서식 띠 명령           sel {info}                고른 것의 서식 (없으면 null)
//                                              placing {kind}            넣기 중인 것 (끝나면 null)
//                                              append {html} · after {path, html} · order {path, to}  넣었다 · 복제했다 · 순서를 바꿨다
//                                              copy {html} · pasteReq    복사 · 붙여 넣기 (앱이 복사한 요소를 들고 있다)
(() => {
	const root = document.querySelector(".slide") || document.body;
	// 여러 요소를 한 번에 고치는 동안(together) 편집 메시지를 모았다가 batch 하나로 보낸다 — 파일 한 번 쓰기 · 되돌리기 한 칸 (2026.11.27)
	const EDITS = new Set(["edit", "patch", "remove", "append", "after", "order"]);
	let batch = null;
	const post = (m) => { if (batch && EDITS.has(m.t)) batch.push(m); else parent.postMessage({ __deck: 1, ...m }, "*"); };
	const together = (fn) => {
		if (batch) return fn();
		batch = [];
		try { return fn(); }
		finally { const ops = batch; batch = null; if (ops.length === 1) post(ops[0]); else if (ops.length) post({ t: "batch", ops }); }
	};
	const css = (el) => getComputedStyle(el);
	document.documentElement.style.overflow = "hidden";

	// 요소 → 슬라이드 뿌리부터의 자식 번호 길. 부모가 원본 HTML 을 DOMParser 로 읽어 같은 길로 찾아간다.
	const pathOf = (el) => {
		const p = [];
		for (let e = el; e && e !== root; e = e.parentElement) {
			if (!e.parentElement) return null;
			p.unshift([...e.parentElement.children].indexOf(e));
		}
		return p;
	};
	const atPath = (p) => p.reduce((e, i) => e?.children[i] ?? null, root);
	// 고친 요소를 다시 그린 뒤에도 고른 채로 — 원본에 되쓰면 앱이 이 쪽을 새로 읽어(핫 리로드) 고른 것 · 키보드 자리가 사라진다.
	// 그러면 Enter 로 마친 뒤 Enter · F2 로 이어 고치지 못한다. 되쓰기 직전에 길을 적어 두고, 다시 뜬 무대 쪽이 edit 모드를 받으면 되살린다.
	// 쪽 목록 미리보기는 view 모드를 받으므로 되살리지 않는다 (2026.11.25)
	const KEEP = "deck-keep:" + location.pathname;
	// 여러 개를 골랐으면 함께 고른 것도 적는다 — 옮긴 뒤 다시 읽은 쪽에서 하나만 남으면 이어서 맞춤 · 채우기를 할 수 없다
	const keep = (el, others = el === sel ? more : []) => { try { sessionStorage.setItem(KEEP, JSON.stringify({ path: pathOf(el), more: others.filter((x) => x.isConnected).map(pathOf), at: Date.now() })); } catch {} };
	const label = (el) => {
		const t = (el.innerText || el.getAttribute("alt") || "").replace(/\s+/g, " ").trim();
		return t.length > 60 ? t.slice(0, 60) + "…" : t;
	};

	// ── 편집 ── 서식 띠(앱 Ribbon.tsx)와 함께 PowerPoint 의 「홈 · 삽입」 도구 노릇을 한다
	//   고르기          상자(절대 위치 요소) 안을 눌러도 처음에는 상자를 고른다. 고른 상자를 다시 누르면 누른 자리 글 고치기 · 글이 없는 자리면 그 안의 요소 고르기
	//   글 고치기       두 번 누르기(누른 낱말이 골라진다) · 고른 상자를 한 번 더 누르기(누른 자리에 커서) · 고른 요소에서 Enter · F2(글 전체를 고른다)
	//   마치기 · 취소   Enter 또는 밖을 누르면 원본에 되쓴다 · Esc 는 고치기 전으로 · Shift+Enter 는 줄 바꿈(<br>)
	//   붙여 넣기       글자만 — 다른 문서의 서식(style · 글꼴 · 색)이 섞이면 PPTX 로 나갈 때 모양이 틀어진다
	//   옮기기 · 크기   끌기 · 방향키 1px(Shift 10px) · 손잡이 8개(모서리 + Shift 는 비율 지킴, 그림은 늘 지킴)
	//   넣기            서식 띠가 place 를 보내면 끌어서 글상자 · 도형 · 선을 그린다(누르기만 하면 기본 크기). 그림은 쪽 가운데에 바로
	//   요소            Delete 지우기 · Ctrl+D 복제 · Ctrl+C · Ctrl+V 복사 · 붙여 넣기(다른 쪽에도) · Ctrl+B · I · U
	// 2026.11.25 : 두 번 누르기만 있었고 Enter 가 <div> 를 끼워 넣고 Esc 도 저장했다 — 제목을 고치다 Enter 로 마치려 하면 구조가 깨졌다
	// 2026.11.25 : 서식 띠 · 넣기 · 손잡이 · 복제 · 복사를 더했다. 상자를 먼저 고르게 바꿨다 — 누른 글 조각만 골라져 도형 · 카드를 끌 수 없었다
	let mode = "view", sel = null, drag = null, edit = null, picked = 0, place = null, size = null, fresh = null, band = null, turn = null;
	// 함께 고른 다른 요소들 (sel 말고). 여러 개 고르기 (2026.11.27)
	let more = [];
	// 서식 복사: 띠의 붓을 누르면 고른 것의 서식을 들고 있다가, 다음에 누른 요소에 입힌다 (PowerPoint 서식 복사와 같이 한 번만)
	let painter = null;
	// 마지막으로 고친 표 칸 · 고치다 마친 자리에서 골라 둔 글자: 띠의 입력칸 · 메뉴를 누르면 고치기가 끝나(포커스가 떠나) 칸 · 고른 글자를 잃는다.
	// 그 뒤에 온 표 · 글꼴 명령이 그 자리에 닿게 기억해 둔다. 쪽을 다시 누르거나 다른 것을 고르면 버린다 (2026.11.27)
	let lastCell = null, lastRange = null;
	// 글을 고치는 동안 서식 띠가 바꾼 서식 (요소 → style). 고치는 중에 파일을 쓰면 앱이 쪽을 다시 읽어 고치던 글이 끊긴다 — 마칠 때 함께 쓴다
	const pending = new Map();
	const style = document.createElement("style");
	style.textContent = `
		[data-deck-edit] .slide *:hover { outline: 1px solid rgba(229,72,45,.32); outline-offset: 1px; cursor: default }
		[data-deck-edit] [data-deck-sel] { outline: 1.5px solid #e5482d !important; outline-offset: 1px }
		[data-deck-edit] [contenteditable=true] { outline: 1.5px solid #e5482d !important; cursor: text }
		[data-deck-place], [data-deck-place] * { cursor: crosshair !important }
		[data-deck-paint], [data-deck-paint] * { cursor: copy !important }
		#deck-ui { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none }
		#deck-ui .h { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; box-sizing: border-box; background: #fff; border: 1.5px solid #e5482d; border-radius: 2px; pointer-events: auto }
		#deck-ui .guide { position: absolute; background: #d6336c; display: none }
		#deck-ui .guide.v { width: 1.5px !important } #deck-ui .guide.h { height: 1.5px !important }
		#deck-ui .ghost { position: absolute; box-sizing: border-box; border: 1.5px dashed #e5482d; background: rgba(229,72,45,.06) }
		#deck-ui .spin { border-radius: 50%; cursor: grab }
		::highlight(deck-find) { background-color: #ffd84d; color: #111 }
		#deck-ui .spin:active { cursor: grabbing }`;
	document.head.appendChild(style);
	// 손잡이 · 그리는 틀은 .slide 밖(<html> 바로 밑)에 둔다 — 쪽 안에 두면 자식 번호 길이 원본과 어긋나고 굽기 · 뽑기에 섞인다
	const ui = document.createElement("div");
	ui.id = "deck-ui";
	const DIRS = { nw: "nwse", n: "ns", ne: "nesw", e: "ew", se: "nwse", s: "ns", sw: "nesw", w: "ew" };
	const handles = Object.entries(DIRS).map(([d, c]) => {
		const h = document.createElement("div");
		h.className = "h";
		h.dataset.dir = d;
		h.style.cursor = c + "-resize";
		h.style.display = "none";
		ui.appendChild(h);
		return h;
	});
	const ghost = document.createElement("div");
	ghost.className = "ghost";
	ghost.style.display = "none";
	ui.appendChild(ghost);
	const spin = document.createElement("div");
	spin.className = "h spin";
	spin.style.display = "none";
	ui.appendChild(spin);
	// 붙기 안내선 — 세로 하나 · 가로 하나
	const [gx, gy] = ["v", "h"].map((k) => { const g = document.createElement("div"); g.className = "guide " + k; ui.appendChild(g); return g; });
	document.documentElement.appendChild(ui);
	const P = (v) => Math.round(v) + "px";

	const select = (el, others = []) => {
		if (sel) sel.removeAttribute("data-deck-sel");
		for (const x of more) x.removeAttribute("data-deck-sel");
		lastRange = null;
		if (lastCell && !(el && (el === lastCell || el.contains(lastCell)))) lastCell = null;
		sel = el;
		more = el ? others.filter((x) => x !== el && x.isConnected) : [];
		if (sel) sel.setAttribute("data-deck-sel", "");
		for (const x of more) x.setAttribute("data-deck-sel", "");
		placeHandles();
		announce();
	};
	// ── 여러 개 고르기 ── Shift · Ctrl 누르기로 더하고 빼기 · 빈 곳에서 끌어 범위 고르기 · Ctrl+A. 첫째(sel)가 서식 띠에 보이는 기준이다
	/** 고른 것 모두 (첫째가 맨 앞). 하나만 골랐으면 [sel] */
	const picks = () => (sel ? [sel, ...more.filter((x) => x.isConnected && x !== sel)] : []);
	/** 누른 요소를 고른 것에 더하거나 뺀다 */
	const togglePick = (el) => {
		if (!sel) return select(el);
		const all = picks();
		if (all.includes(el)) { const rest = all.filter((x) => x !== el); return select(rest[0] || null, rest.slice(1)); }
		// 한 요소와 그 안의 요소를 함께 고르면 옮길 때 두 번 옮겨진다 — 감싼 쪽만 남긴다
		const keepOut = all.filter((x) => !x.contains(el) && !el.contains(x));
		if (!keepOut.length) return select(el);
		select(keepOut[0], [...keepOut.slice(1), el]);
	};
	/** 범위 안에 통째로 든 요소 중 가장 바깥 것들. 범위에 걸치기만 한 요소는 그 안을 더 본다 (PowerPoint 범위 고르기) */
	const inside = (R) => {
		const S = root.getBoundingClientRect(), out = [];
		const walk = (p) => {
			for (const c of p.children) {
				if (c.id === "deck-ui" || !visible(c)) continue;
				const r = c.getBoundingClientRect();
				if (r.width < 1 && r.height < 1) continue;
				const x = r.left - S.left, y = r.top - S.top;
				const full = x >= R.x - 0.5 && y >= R.y - 0.5 && x + r.width <= R.x + R.w + 0.5 && y + r.height <= R.y + R.h + 0.5;
				const hit = x < R.x + R.w && x + r.width > R.x && y < R.y + R.h && y + r.height > R.y;
				if (full && canMove(c)) out.push(groupOf(c));
				else if (hit) walk(c);
			}
		};
		walk(root);
		return [...new Set(out)];
	};
	/** 모두 고르기 — 쪽을 가득 덮는 틀 하나뿐이면(Claude 가 짓는 쪽에 흔하다) 그 안의 요소들을 고른다 */
	const selectAll = () => {
		const S = root.getBoundingClientRect();
		let all = inside({ x: 0, y: 0, w: S.width, h: S.height });
		while (all.length === 1 && [...all[0].children].filter((c) => canMove(c) && visible(c)).length > 1 && !all[0].hasAttribute("data-group")) all = [...all[0].children].filter((c) => canMove(c) && visible(c));
		if (all.length) select(all[0], all.slice(1));
	};
	/** 요소가 든 묶음 중 가장 바깥 묶음 (묶음 안 요소를 누르면 묶음째 고른다) */
	const groupOf = (el) => { let g = el; for (let e = el; e && e !== root; e = e.parentElement) if (e.hasAttribute?.("data-group")) g = e; return g; };
	const movable = (el) => !!el && el !== root && el.nodeType === 1 && ["absolute", "fixed"].includes(css(el).position);
	/** 끌어 옮기고 크기를 바꿀 수 있는 요소 — 절대 위치 상자, 그리고 흐름 배치(flex · grid · 보통 흐름)의 덩이 요소.
	 *  흐름 요소는 position: relative 와 left · top 어긋남으로 옮긴다. 이웃 요소의 자리는 그대로이고, 내보내기는 그린 자리를 재므로 PPTX 도 같다.
	 *  2026.11.25 : Claude 가 짓는 쪽은 대부분 흐름 배치라 절대 위치만 옮기게 하면 끌어 옮기기가 거의 먹지 않았다 */
	const canMove = (el) => {
		if (!el || el === root || el.nodeType !== 1 || !root.contains(el)) return false;
		if (movable(el)) return true;
		const s = css(el);
		return s.display !== "inline" && s.display !== "contents" && !s.display.startsWith("table") && ["static", "relative"].includes(s.position);
	};
	/** 옮기기 시작점 — 지금 left · top 과, 흐름 요소라 옮길 때 position: relative 를 붙여야 하는지 */
	const posOf = (el) => {
		const s = css(el), abs = movable(el);
		return { l: parseFloat(s.left) || (abs ? el.offsetLeft : 0), t: parseFloat(s.top) || (abs ? el.offsetTop : 0), rel: s.position === "static" };
	};
	/** 옮긴 뒤 원본에 쓸 style — 붙인 position: relative 도 함께 */
	const posPatch = (el, keys) => {
		const st = el.style.position ? { position: el.style.position } : {};
		for (const k of keys) st[k] = el.style[k];
		return st;
	};
	/** 상자 — 그 요소부터 위로 처음 만나는 절대 위치 요소. 글상자 · 도형 · 카드처럼 통째로 옮기는 단위 */
	const boxOf = (el) => { for (let e = el; e && e !== root && e !== document.body; e = e.parentElement) if (movable(e)) return groupOf(e); return null; };
	/** 채우기 · 윤곽선 · 세로 맞춤이 닿는 요소 — 도형 안 글(외동 자식)을 골랐거나 고치는 중이면 그 도형 */
	const shapeOf = (el) => { let x = el; while (!movable(x) && x.parentElement && x.parentElement !== root && x.parentElement.children.length === 1) x = x.parentElement; return x; };
	const NOTEXT = "img, svg, table, video, canvas, iframe";
	const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
	// 글을 고칠 수 있는 요소 — 그림 · 표처럼 글 상자로 다루지 않는 것을 품지 않고, 글이 있거나 비어 있는 것(빈 도형 · 새 글상자).
	// 비어 있어도 선 · 띠처럼 납작한 것은 뺀다 — 고르고 Enter 를 누르면 선 안에 커서가 서서 선이 부푼다
	const editable = (el) => !!el && el !== root && root.contains(el) && !el.matches(NOTEXT) && !el.querySelector(NOTEXT) &&
		(!!(el.innerText || "").trim() || (el.children.length === 0 && shapeOf(el).getBoundingClientRect().height >= 8));
	/** 누른 자리에서 고칠 글 덩이 — 글 조각(span · b …)이면 그것을 품은 덩이까지 오르고, 외동 자식만 둔 상자면 그 자식까지 내려간다 */
	const textAt = (t, lim) => {
		let x = t;
		while (x && x !== lim && x !== root && INLINE.has(x.tagName)) x = x.parentElement;
		while (x && x.children.length === 1 && !ownText(x) && !INLINE.has(x.children[0].tagName) && !x.children[0].matches(NOTEXT)) x = x.children[0];
		// 목록 문단이면 목록 전체를 고친다: Enter 로 다음 항목을 이어 쓰려면 문단들을 담은 그릇이 고치는 자리여야 한다
		const li = x?.closest?.("[data-li]");
		if (li && li.parentElement && li.parentElement !== root && root.contains(li) && editable(li.parentElement)) x = li.parentElement;
		return editable(x) ? x : null;
	};
	/** 원본에 쓸 HTML — 런타임이 붙인 표시(고름 · 고치는 중)를 걷는다 */
	const clean = (el) => {
		const c = el.cloneNode(true);
		for (const x of [c, ...c.querySelectorAll("*")]) { x.removeAttribute("data-deck-sel"); x.removeAttribute("contenteditable"); }
		return c;
	};

	/** 고른 것 · 고치는 글의 서식을 앱에 알린다 — 서식 띠가 눌린 단추 · 글자 크기 · 색을 보인다 */
	const announce = () => {
		const el = edit ? edit.el : sel;
		if (mode !== "edit" || !el || !el.isConnected) return post({ t: "sel", info: null });
		const b = shapeOf(el), s = css(el), bs = css(b);
		const side = ["Top", "Right", "Bottom", "Left"].find((k) => bs["border" + k + "Style"] !== "none" && parseFloat(bs["border" + k + "Width"]) > 0);
		// 크기 · 위치는 돌리기 전 상자로 잰다 (PowerPoint 의 크기 칸과 같다). 돌린 요소의 감싼 네모는 크기 칸에 넣으면 커진다
		const br = posBox(b), mk = listOf(el);
		post({ t: "sel", info: {
			font: s.fontFamily.split(",")[0].replace(/["']/g, "").trim(), strike: s.textDecorationLine.includes("line-through"),
			ls: Math.round((parseFloat(s.letterSpacing) || 0) * 0.75 * 10) / 10, tt: s.textTransform,
			list: mk ? (/\d/.test(mk.getAttribute("data-bu")) ? "num" : "bu") : null,
			w: Math.round(br.w), h: Math.round(br.h), radius: parseFloat(bs.borderTopLeftRadius) || 0, round: bs.borderTopLeftRadius.includes("%"),
			shadow: bs.boxShadow !== "none", opacity: Math.round((+bs.opacity || 1) * 100), dash: side ? bs["border" + side + "Style"] : null,
			cell: (!!el.closest?.("td, th") && root.contains(el.closest("td, th"))) || (!!lastCell && lastCell.isConnected && el.contains(lastCell)), painter: !!painter,
			text: !!edit || !!textAt(el, null), ranged: ranged() || !!lastRange,
			tag: el.tagName.toLowerCase(), editing: !!edit, box: canMove(b), abs: movable(b), flex: bs.display.includes("flex"), image: b.tagName === "IMG",
			geom: b.getAttribute?.("data-shape") || null, arrow: b.hasAttribute?.("data-arrow") || false,
			merged: (() => { const td = el.closest?.("td, th") || (lastCell?.isConnected && el.contains(lastCell) ? lastCell : null); return !!td && (td.colSpan > 1 || td.rowSpan > 1); })(),
			count: edit ? 1 : picks().length, groupable: !edit && canGroup(), grouped: !edit && !more.length && canUngroup(sel),
			x: Math.round(br.x), y: Math.round(br.y), rot: rotOf(b), flipH: flipOf(b, "x"), flipV: flipOf(b, "y"),
			size: parseFloat(s.fontSize), lh: Math.round((parseFloat(s.lineHeight) / parseFloat(s.fontSize)) * 100) / 100 || null, bold: +s.fontWeight >= 600, italic: s.fontStyle === "italic", underline: s.textDecorationLine.includes("underline"),
			color: color(s.color)?.hex || null, align: s.textAlign,
			// 세로 맞춤은 띠의 세 값으로 — 계산 값 표기가 엔진마다 다르다 (WebView2 는 flex-start 를 flow-start 로 돌려준다)
			valign: /end/.test(bs.alignItems) ? "flex-end" : /center/.test(bs.alignItems) ? "center" : "flex-start",
			fill: color(bs.backgroundColor)?.hex || null,
			line: side ? { hex: color(bs["border" + side + "Color"])?.hex || null, w: parseFloat(bs["border" + side + "Width"]) } : null,
		} });
	};
	const placeHandles = () => {
		for (const h of handles) h.style.display = "none";
		spin.style.display = "none";
		// 여러 개를 골랐으면 손잡이 없이 테두리만 — 크기는 하나씩, 자리는 함께 끌어 옮긴다
		if (mode !== "edit" || !sel || edit || !sel.isConnected || !canMove(sel) || more.length) return;
		const r = sel.getBoundingClientRect();
		// 회전 손잡이: 위 가운데에서 24px 위, 돌린 만큼 함께 돈다. 흐름 요소는 돌리면 이웃과 겹쳐 보이므로 절대 위치 상자만
		if (movable(sel) && r.width >= 8 && r.height >= 8) {
			const b = posBox(sel), a = (rotOf(sel) * Math.PI) / 180, S = root.getBoundingClientRect(), d = b.h / 2 + 24;
			spin.style.left = S.left + b.x + b.w / 2 + Math.sin(a) * d + "px";
			spin.style.top = S.top + b.y + b.h / 2 - Math.cos(a) * d + "px";
			spin.style.display = "";
		}
		// 돌린 요소의 크기 손잡이는 감싼 네모에 서서 끄는 방향이 어긋난다 — 크기는 서식 띠의 크기 칸으로 바꾼다
		if (rotOf(sel) % 360) return;
		// 선처럼 납작한 요소는 길이 손잡이만 — 두께는 서식 띠의 윤곽선 두께로 바꾼다
		const flatH = r.height < 8, flatW = r.width < 8;
		for (const h of handles) {
			const d = h.dataset.dir;
			if ((flatH && d !== "e" && d !== "w") || (flatW && d !== "n" && d !== "s")) continue;
			h.style.left = (d.includes("w") ? r.left : d.includes("e") ? r.right : (r.left + r.right) / 2) + "px";
			h.style.top = (d.includes("n") ? r.top : d.includes("s") ? r.bottom : (r.top + r.bottom) / 2) + "px";
			h.style.display = "";
		}
	};

	/** 서식을 바꾼다 — 고르는 중이면 바로 원본에 쓰고, 글을 고치는 중이면 마칠 때 함께 쓴다 */
	const setStyle = (el, st) => {
		// CSS 변수가 든 font 묶음(`font: 600 28px var(--font)`)은 먼저 낱 속성으로 푼다 — 크기 하나만 바꾸면 브라우저가
		// 나머지(글꼴 이름 · 굵기)를 빈 값으로 만들어 글꼴이 날아간다 (setLine 주석과 같은 까닭). 글꼴 이름의 변수는 그대로 살린다
		const raw = el.style.getPropertyValue("font");
		if (raw.includes("var(") && Object.keys(st).some((k) => k.startsWith("font-") || k === "line-height")) {
			const s = css(el);
			st = { font: "", "font-style": s.fontStyle, "font-weight": s.fontWeight, "font-size": s.fontSize, "line-height": s.lineHeight, "font-family": /(var\(--[^)]*\))\s*$/.exec(raw)?.[1] || s.fontFamily, ...st };
		}
		for (const [k, v] of Object.entries(st)) el.style.setProperty(k, v);
		if (edit) pending.set(el, { ...(pending.get(el) || {}), ...st });
		else { keep(sel || el); post({ t: "patch", path: pathOf(el), style: st }); }
		placeHandles();
		announce();
	};
	const flushPending = () => {
		for (const [el, st] of pending) if (el.isConnected) post({ t: "patch", path: pathOf(el), style: st });
		pending.clear();
	};

	/** 글 고치기를 시작한다. at 이 있으면 그 자리에 커서, all 이면 글 전체를 고른다. 둘 다 없으면 브라우저가 고른 그대로(두 번 누르기의 낱말) */
	const startEdit = (el, at, all) => {
		if (edit || place || !(el === fresh || editable(el))) return;
		edit = { el, before: el.innerHTML, cancel: false };
		select(null);
		// 빈 요소는 높이가 없어 커서가 서지 않는다 — 고치는 동안만 <br> 로 한 줄을 세운다 (마칠 때 글이 없으면 걷는다)
		if (!el.innerHTML.trim()) el.innerHTML = "<br>";
		el.contentEditable = "true";
		// 글머리 표지는 고치지 못하게: 표지 바로 뒤에 커서를 두고 글을 치면 웹뷰가 글을 표지 span 안에 넣는다 (마칠 때 걷는다)
		for (const m of el.querySelectorAll("[data-bu]")) m.contentEditable = "false";
		el.focus();
		const s = getSelection();
		const r = at ? document.caretRangeFromPoint(at.x, at.y) : all ? document.createRange() : null;
		if (r) {
			if (all) r.selectNodeContents(el);
			s.removeAllRanges();
			s.addRange(r);
		}
		el.addEventListener("blur", finishEdit, { once: true });
		announce();
	};
	const finishEdit = () => {
		if (!edit) return;
		const rg = ranged() ? getSelection().getRangeAt(0).cloneRange() : null;
		const { el, before, cancel } = edit;
		edit = null;
		el.removeAttribute("contenteditable");
		for (const m of el.querySelectorAll("[data-bu]")) m.removeAttribute("contenteditable");
		if (cancel) el.innerHTML = before;
		if (!(el.innerText || "").trim() && !el.querySelector(NOTEXT)) el.innerHTML = "";
		if (fresh) {
			// 새 글상자는 아직 원본에 없다 — 쓴 글 · 서식을 담아 통째로 덧붙인다. 아무것도 안 썼으면 걷는다
			const box = fresh;
			fresh = null;
			pending.clear();
			if (!box.innerHTML) { box.remove(); if (!sel) announce(); return; }
			keep(box);
			post({ t: "append", html: clean(box).outerHTML });
			if (!sel) select(box);
			return;
		}
		renumber(el);
		flushPending();
		// 상자(도형 · 글상자 · 카드) 안 글을 마쳤으면 그 상자를 고른 채로 둔다 — 이어서 채우기 · 옮기기를 한다 (PowerPoint 와 같다)
		const box = boxOf(el) || el;
		if (el.innerHTML !== before) { keep(box); post({ t: "edit", path: pathOf(el), html: el.innerHTML }); }
		// Enter · Esc 로 마쳤으면 그 요소를 고른 채로 둔다. 다른 요소를 눌러 마쳤으면 그 요소가 이미 골라져 있다 — 덮지 않는다
		if (!sel) select(box);
		// 칸 · 고른 글자는 고르기(select) 뒤에 적는다: select 가 지난 것을 버린다
		const td = el.closest("td, th");
		if (td && root.contains(td)) lastCell = td;
		if (rg && !cancel && el.innerHTML === before) lastRange = { el, range: rg };
		announce();
	};
	/** 글자만 끼운다 — 줄은 <br> 로 */
	const insertPlain = (text) => {
		const lines = text.replace(/\r\n?/g, "\n").split("\n");
		lines.forEach((l, i) => {
			if (i) document.execCommand("insertLineBreak");
			if (l) document.execCommand("insertText", false, l);
		});
	};
	// 고치는 중 고른 글자가 생기고 사라질 때 띠에 알린다: 잘라내기 · 복사 단추가 고른 글자가 있을 때만 켜진다
	let selTick = 0;
	document.addEventListener("selectionchange", () => { if (edit && !selTick) selTick = requestAnimationFrame(() => { selTick = 0; announce(); }); });
	addEventListener("paste", (e) => {
		if (!edit) return;
		e.preventDefault();
		insertPlain(e.clipboardData?.getData("text/plain") || "");
	});
	addEventListener("drop", (e) => {
		if (!edit) return;
		e.preventDefault();
		const t = e.dataTransfer?.getData("text/plain");
		if (!t) return;
		const r = document.caretRangeFromPoint(e.clientX, e.clientY);
		if (r) { getSelection().removeAllRanges(); getSelection().addRange(r); }
		insertPlain(t);
	});

	// ── 넣기 ── 서식 띠에서 고른 것을 끌어서 그린다
	const setPlace = (p) => {
		if (p && edit) edit.el.blur();
		place = p;
		document.documentElement.toggleAttribute("data-deck-place", !!p);
		ghost.style.display = "none";
		if (p) select(null);
		post({ t: "placing", kind: p ? p.kind : null });
	};
	const slideXY = (e) => { const S = root.getBoundingClientRect(); return [e.clientX - S.left, e.clientY - S.top]; };
	/** 그리는 틀 — 선은 가로 · 세로 중 긴 쪽으로 곧게, Shift 면 정사각형. 화살표는 아무 방향이나 (Shift 면 45° 씩) */
	const placeRect = (e) => {
		const [x, y] = slideXY(e), { x0, y0, kind } = place;
		let w = x - x0, h = y - y0;
		if (kind === "line") { if (Math.abs(w) >= Math.abs(h)) h = 0; else w = 0; }
		else if (kind === "arrow") {
			if (e.shiftKey) { const L = Math.hypot(w, h), a = Math.round(Math.atan2(h, w) / (Math.PI / 4)) * (Math.PI / 4); w = Math.cos(a) * L; h = Math.sin(a) * L; }
			return { x: Math.min(x0, x0 + w), y: Math.min(y0, y0 + h), w: Math.abs(w), h: Math.abs(h), dx: w, dy: h };
		}
		else if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
		return { x: Math.min(x0, x0 + w), y: Math.min(y0, y0 + h), w: Math.abs(w), h: Math.abs(h) };
	};
	// 도형 — 글은 안쪽 <p> 에 둔다. 가운데 맞춤을 flex 로 하는데, 글을 flex 상자에 바로 넣으면 Shift+Enter 의 <br> 가 줄을 못 바꾼다.
	// 내보낼 때 바깥 상자는 PowerPoint 도형, <p> 는 그 위 글상자가 되어 한 그룹으로 묶인다
	const SHAPE = "display:flex;align-items:center;justify-content:center;text-align:center;padding:12px 16px;background:var(--accent, #2f6fde);color:var(--paper, #fff)";
	// 모양 도형 — PowerPoint 기본 도형과 같은 꼭짓점을 px 로 잘라 그린다 (clip-path). 내보낼 때 data-shape 이름 그대로 PowerPoint 도형이 되어 PowerPoint 에서도 고칠 수 있다.
	// 꼭짓점은 PowerPoint 도형 정의의 기본 조절값을 따랐다 (화살촉 · 모서리는 짧은 변 s 의 비율). 크기를 바꾸면 다시 깎는다 (reshape)
	const GEOM = {
		triangle: (w, h) => [[w / 2, 0], [w, h], [0, h]],
		rtTriangle: (w, h) => [[0, h], [0, 0], [w, h]],
		diamond: (w, h) => [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]],
		parallelogram: (w, h, s) => [[0, h], [s / 4, 0], [w, 0], [w - s / 4, h]],
		trapezoid: (w, h, s) => [[0, h], [s / 4, 0], [w - s / 4, 0], [w, h]],
		hexagon: (w, h, s) => [[0, h / 2], [s / 4, 0], [w - s / 4, 0], [w, h / 2], [w - s / 4, h], [s / 4, h]],
		chevron: (w, h, s) => [[0, 0], [w - s / 2, 0], [w, h / 2], [w - s / 2, h], [0, h], [s / 2, h / 2]],
		homePlate: (w, h, s) => [[0, 0], [w - s / 2, 0], [w, h / 2], [w - s / 2, h], [0, h]],
		rightArrow: (w, h, s) => [[0, h / 4], [w - s / 2, h / 4], [w - s / 2, 0], [w, h / 2], [w - s / 2, h], [w - s / 2, (h * 3) / 4], [0, (h * 3) / 4]],
		leftArrow: (w, h, s) => [[0, h / 2], [s / 2, 0], [s / 2, h / 4], [w, h / 4], [w, (h * 3) / 4], [s / 2, (h * 3) / 4], [s / 2, h]],
		upArrow: (w, h, s) => [[0, s / 2], [w / 2, 0], [w, s / 2], [(w * 3) / 4, s / 2], [(w * 3) / 4, h], [w / 4, h], [w / 4, s / 2]],
		downArrow: (w, h, s) => [[w / 4, 0], [(w * 3) / 4, 0], [(w * 3) / 4, h - s / 2], [w, h - s / 2], [w / 2, h], [0, h - s / 2], [w / 4, h - s / 2]],
	};
	const clipOf = (kind, w, h) => `polygon(${GEOM[kind](w, h, Math.min(w, h)).map(([x, y]) => `${Math.round(x * 10) / 10}px ${Math.round(y * 10) / 10}px`).join(", ")})`;
	/** 모양 도형의 크기가 바뀌었으면 다시 깎을 style (아니면 빈 것) */
	const reshape = (el) => { const k = el.getAttribute?.("data-shape"); return GEOM[k] ? { "clip-path": clipOf(k, el.offsetWidth, el.offsetHeight) } : {}; };
	// 화살표 — 가로 선 하나에 촉(<i>)을 달고 돌려서 방향을 낸다. 선 · 촉 색은 color 하나(currentColor)라 윤곽선 색을 바꾸면 함께 바뀐다
	const arrowHtml = (at, len, deg, t = 2) => `<div data-arrow="end" style="${at}width:${P(len)};height:0;color:var(--ink, #222);border-top:${t}px solid currentColor${deg ? `;transform:rotate(${Math.round(deg * 10) / 10}deg)` : ""}"><i style="${arrowHead(t)}"></i></div>`;
	const arrowHead = (t) => `position:absolute;right:-1px;top:${P(-(t / 2) - 3 - t * 2)};width:0;height:0;border-left:${P(6 + t * 4)} solid currentColor;border-top:${P(3 + t * 2)} solid transparent;border-bottom:${P(3 + t * 2)} solid transparent`;
	const makeEl = (kind, r) => {
		const at = `position:absolute;left:${P(r.x)};top:${P(r.y)};`;
		const t = document.createElement("template");
		if (kind === "text") t.innerHTML = `<div style="${at}width:${P(r.w)}"><br></div>`;
		else if (kind === "arrow") {
			// 끈 두 점의 가운데에 길이만큼 가로 선을 두고 돌린다 — 가운데를 축으로 도니 양 끝이 끈 자리에 온다
			const len = Math.max(8, Math.hypot(r.dx, r.dy)), deg = (Math.atan2(r.dy, r.dx) * 180) / Math.PI, cx = r.x + r.w / 2, cy = r.y + r.h / 2;
			t.innerHTML = arrowHtml(`position:absolute;left:${P(cx - len / 2)};top:${P(cy - 1)};`, len, deg);
		}
		else if (GEOM[kind]) t.innerHTML = `<div data-shape="${kind}" style="${at}width:${P(r.w)};height:${P(r.h)};box-sizing:border-box;${SHAPE};clip-path:${clipOf(kind, r.w, r.h)}"><p style="margin:0;width:100%"></p></div>`;
		else if (kind === "line") t.innerHTML = r.h > r.w
			? `<div style="${at}width:0;height:${P(r.h)};border-left:var(--stroke, 2px) solid var(--ink, #222)"></div>`
			: `<div style="${at}width:${P(r.w)};height:0;border-top:var(--stroke, 2px) solid var(--ink, #222)"></div>`;
		else t.innerHTML = `<div style="${at}width:${P(r.w)};height:${P(r.h)};${SHAPE}${kind === "round" ? ";border-radius:16px" : kind === "ellipse" ? ";border-radius:50%" : ""}"><p style="margin:0;width:100%"></p></div>`;
		return t.content.firstElementChild;
	};
	const finishPlace = (e) => {
		const p = place;
		let r = placeRect(e);
		const D = { text: [360, 0], line: [240, 0], arrow: [240, 0], rect: [200, 120], round: [200, 120], ellipse: [160, 160], triangle: [160, 140], rtTriangle: [160, 140], diamond: [160, 160], hexagon: [180, 150], upArrow: [100, 180], downArrow: [100, 180] }[p.kind] || [200, 120];
		// 누르기만 했다 — 누른 자리를 왼쪽 위로 기본 크기
		if (r.w < 6 && r.h < 6) r = { x: p.x0, y: p.y0, w: D[0], h: D[1], dx: D[0], dy: D[1] };
		else if (p.kind === "text") r.w = Math.max(r.w, 40);
		setPlace(null);
		const el = makeEl(p.kind, r);
		root.appendChild(el);
		if (p.kind === "text") { fresh = el; startEdit(el, null, true); return; }
		keep(el);
		post({ t: "append", html: clean(el).outerHTML });
		select(el);
	};
	/** 그림 — 쪽의 60% 안에 들게 줄여 가운데에 놓는다 */
	const putImage = async (src) => {
		if (edit) edit.el.blur();
		const probe = new Image();
		probe.src = src;
		await within(probe.decode(), 5000);
		const S = root.getBoundingClientRect(), nw = probe.naturalWidth || 400, nh = probe.naturalHeight || 300;
		const k = Math.min(1, (S.width * 0.6) / nw, (S.height * 0.6) / nh), w = nw * k, h = nh * k;
		const el = document.createElement("img");
		el.setAttribute("src", src);
		el.setAttribute("alt", "");
		el.setAttribute("style", `position:absolute;left:${P((S.width - w) / 2)};top:${P((S.height - h) / 2)};width:${P(w)};height:${P(h)}`);
		root.appendChild(el);
		keep(el);
		post({ t: "append", html: el.outerHTML });
		select(el);
	};

	// ── 요소 ── 순서 · 맞춤 · 복제 · 복사
	const arrange = (how, x = sel) => {
		// 흐름 요소는 순서를 바꾸면 겹침이 아니라 배치 차례가 바뀐다 — 절대 위치 상자만
		if (!movable(shapeOf(x))) return;
		const el = shapeOf(x), p = el.parentElement, n = p.children.length, i = [...p.children].indexOf(el);
		const to = how === "front" ? n - 1 : how === "back" ? 0 : how === "forward" ? Math.min(n - 1, i + 1) : Math.max(0, i - 1);
		if (to === i) return;
		const from = pathOf(el);
		el.remove();
		p.insertBefore(el, p.children[to] ?? null);
		post({ t: "order", path: from, to });
		// 여러 개를 고른 채면 고른 것을 그대로 둔다 (옮긴 요소는 같은 노드라 표시가 남는다)
		if (more.length) return keep(sel);
		keep(el);
		select(el);
	};
	/** 쪽 가장자리 · 가운데에 맞춘다 (PowerPoint 「슬라이드에 맞춤」). 그린 자리와 쪽의 차이만큼 left · top 을 민다 — 절대 · 흐름 요소에 같이 맞는다 */
	const alignTo = (how) => {
		const el = shapeOf(sel);
		if (!canMove(el)) return;
		const r = el.getBoundingClientRect(), S = root.getBoundingClientRect(), p = posOf(el);
		const dx = { left: S.left - r.left, center: S.left + (S.width - r.width) / 2 - r.left, right: S.right - r.right }[how];
		const dy = { top: S.top - r.top, middle: S.top + (S.height - r.height) / 2 - r.top, bottom: S.bottom - r.bottom }[how];
		setStyle(el, { ...(p.rel ? { position: "relative" } : {}), ...(dx != null ? { left: P(p.l + dx) } : { top: P(p.t + dy) }) });
	};
	const dup = () => {
		const el = shapeOf(sel), c = clean(el);
		if (movable(el)) { c.style.left = P((parseFloat(css(el).left) || el.offsetLeft) + 20); c.style.top = P((parseFloat(css(el).top) || el.offsetTop) + 20); }
		const path = pathOf(el);
		el.after(c);
		keep(c);
		post({ t: "after", path, html: c.outerHTML });
		select(c);
	};
	/** 여러 개 복제 — 문서 차례대로 하나씩 바로 뒤에 넣고, 새로 생긴 것들을 고른다 */
	const dupMany = () => {
		const all = picks().sort((a, c) => (a.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
		const made = [];
		together(() => {
			for (const el of all) {
				const c = clean(el);
				if (movable(el)) { c.style.left = P((parseFloat(css(el).left) || el.offsetLeft) + 20); c.style.top = P((parseFloat(css(el).top) || el.offsetTop) + 20); }
				post({ t: "after", path: pathOf(el), html: c.outerHTML });
				el.after(c);
				made.push(c);
			}
		});
		select(made[0], made.slice(1));
		keep(made[0]);
	};
	/** 복사 — 다른 쪽에 붙여도 같은 자리 · 크기로 서게 절대 위치로 바꿔 넘긴다 (붙여 넣기는 쪽 맨 위에 놓는다). 여러 개면 이어 붙인 HTML 하나로 */
	const copy = () => {
		const S = root.getBoundingClientRect();
		const html = picks().map((x) => {
			const el = more.length ? x : shapeOf(x), c = clean(el);
			if (!movable(el) || el.offsetParent !== root) {
				const r = el.getBoundingClientRect();
				Object.assign(c.style, { position: "absolute", left: P(r.left - S.left), top: P(r.top - S.top), width: P(r.width), margin: "0" });
			}
			return c.outerHTML;
		}).join("");
		post({ t: "copy", html });
	};
	const paste = (html, dx) => {
		const t = document.createElement("template");
		t.innerHTML = String(html || "").trim();
		const els = [...t.content.children];
		if (!els.length) return;
		together(() => {
			for (const el of els) {
				if (dx) { el.style.left = P((parseFloat(el.style.left) || 0) + dx); el.style.top = P((parseFloat(el.style.top) || 0) + dx); }
				root.appendChild(el);
				post({ t: "append", html: el.outerHTML });
			}
		});
		select(els[0], els.slice(1));
		keep(els[0]);
	};

	// ── 서식 ──
	/** 글을 고치는 중에 글자 일부를 골랐는가 — 그러면 굵게 · 색은 고른 글자에만 */
	const ranged = () => {
		if (!edit) return false;
		const s = getSelection();
		return !!s.rangeCount && !s.isCollapsed && edit.el.contains(s.anchorNode);
	};
	const exec = (c, v) => { document.execCommand("styleWithCSS", false, true); document.execCommand(c, false, v); announce(); };
	/** var(--accent) 같은 색을 rgb 로 — execCommand 는 CSS 변수를 받지 않는다 */
	const rgbOf = (v) => {
		const probe = document.createElement("span");
		probe.style.color = v;
		root.appendChild(probe);
		const c = css(probe).color;
		probe.remove();
		return c;
	};
	/** 그 요소에 굵게 · 기울임 · 밑줄 · 취소선이 켜져 있는가 */
	const toggled = (el, what) => {
		const s = css(el);
		return what === "bold" ? +s.fontWeight >= 600 : what === "italic" ? s.fontStyle === "italic" : s.textDecorationLine.includes(what === "strike" ? "line-through" : "underline");
	};
	/** 켜고 끈다. on 을 주면 그 쪽으로 맞춘다 (여러 개를 고른 채 누르면 첫째를 기준으로 모두 같게) */
	const toggle = (what, el = edit ? edit.el : sel, on) => {
		if (ranged()) return exec(what === "strike" ? "strikeThrough" : what);
		const s = css(el), cur = toggled(el, what);
		if (on !== undefined && on === cur) return;
		// 밑줄 · 취소선은 한 속성(text-decoration)을 나눠 쓴다: 하나를 켜고 끌 때 다른 하나를 지우지 않는다
		const deco = (k) => {
			const on = new Set(s.textDecorationLine.split(/\s+/).filter((x) => x && x !== "none"));
			if (on.has(k)) on.delete(k); else on.add(k);
			return on.size ? [...on].join(" ") : "none";
		};
		if (what === "bold") setStyle(el, { "font-weight": cur ? "400" : "700" });
		else if (what === "italic") setStyle(el, { "font-style": cur ? "normal" : "italic" });
		else if (what === "strike") setStyle(el, { "text-decoration": deco("line-through") });
		else setStyle(el, { "text-decoration": deco("underline") });
	};
	/** 윤곽선 — 한 변만 그은 요소(선 · 밑줄 띠)는 그 변만 바꾼다. 네 변을 다 켜면 선이 상자가 된다.
	 *  늘 묶음 속성(border · border-top …) 전체를 다시 쓴다. `border: 1px solid var(--line)` 처럼 CSS 변수가 든 묶음에서
	 *  border-top-width 하나만 바꾸면 브라우저가 나머지 낱 속성을 빈 값으로 만들어 원본에 `border-top-style: ;` 가 남고 선이 사라진다 (2026.11.25 실측) */
	const setLine = (el, v) => {
		// 화살표: 선 · 촉이 color 하나를 같이 쓴다. 두께는 선과 촉 크기를 함께, 없음은 고르지 않는다(지우기로)
		if (el.hasAttribute("data-arrow")) {
			if (v.color) setStyle(el, { color: v.color });
			if (v.dash) setStyle(el, { "border-top-style": v.dash });
			if (v.width) together(() => { const head = el.querySelector(":scope > i"); setStyle(el, { "border-top-width": P(v.width) }); if (head) { head.setAttribute("style", arrowHead(v.width)); rewrite(el); } });
			return;
		}
		if (v.none) return setStyle(el, { border: "none" });
		const s = css(el), all = ["top", "right", "bottom", "left"];
		const on = all.filter((k) => s.getPropertyValue(`border-${k}-style`) !== "none" && parseFloat(s.getPropertyValue(`border-${k}-width`)) > 0);
		const of = (k) => `${v.width ? v.width + "px" : on.length ? s.getPropertyValue(`border-${k}-width`) : "2px"} ${v.dash || (on.length ? s.getPropertyValue(`border-${k}-style`) : "solid")} ${v.color || (on.length ? s.getPropertyValue(`border-${k}-color`) : "var(--ink, #222)")}`;
		if (!on.length || on.length === 4) return setStyle(el, { border: of(on[0] || "top") });
		setStyle(el, Object.fromEntries(on.map((k) => [`border-${k}`, of(k)])));
	};

	// ── 글머리 기호 · 번호 ── 문단마다 data-li 를 달고 맨 앞에 표지(span data-bu)를 둔다. 내어쓰기는 padding-left 와 음수 text-indent.
	// 표지를 글자(::marker · list-style)로 두지 않는 까닭: 목록 항목(list-item)은 내보낼 때 통째로 그림이 된다 (extract needsDeep).
	// 표지 span 이 있으면 내보내기가 그 문단을 PowerPoint 글머리 문단으로 바꾼다 (extract 「글자」) (2026.11.27)
	const MARK = "display:inline-block;min-width:1.3em;text-indent:0";
	const listOf = (el) => (el.closest?.("[data-li]") && root.contains(el.closest("[data-li]")) ? el.closest("[data-li]").querySelector(":scope > [data-bu]") : el.querySelector?.("[data-li] > [data-bu]")) || null;
	/** 목록을 다는 그릇: 외동 덩이 자식만 둔 상자(도형의 <p>)면 그 자식까지 내려간다. 고른 것이 목록 문단이면 그 부모 */
	const listHost = (el) => {
		const li = el.closest?.("[data-li]");
		if (li && root.contains(li) && li.parentElement) return li.parentElement;
		let h = el;
		while (h.children.length === 1 && !ownText(h) && !INLINE.has(h.children[0].tagName) && !h.children[0].matches(NOTEXT)) h = h.children[0];
		return h;
	};
	/** 고친 그릇을 원본에 되쓴다: 글을 고치는 중이면 마칠 때 innerHTML 째로 쓰이므로 따로 보내지 않는다 */
	const rewrite = (host) => {
		if (edit && edit.el.contains(host)) return announce();
		keep(sel || host);
		post({ t: "edit", path: pathOf(host), html: host.innerHTML });
		placeHandles();
		announce();
	};
	const setList = (el, kind) => {
		const host = listHost(el);
		let items = [...host.children].filter((c) => c.hasAttribute("data-li"));
		const mk = items[0]?.querySelector(":scope > [data-bu]");
		const cur = mk ? (/\d/.test(mk.getAttribute("data-bu")) ? "num" : "bu") : null;
		if (cur === kind) {
			// 끄기: 표지와 내어쓰기만 걷는다. 줄마다 나눈 문단은 그대로 둔다
			for (const li of items) {
				li.querySelector(":scope > [data-bu]")?.remove();
				li.removeAttribute("data-li");
				li.style.removeProperty("padding-left");
				li.style.removeProperty("text-indent");
				if (!li.getAttribute("style")) li.removeAttribute("style");
			}
			return rewrite(host);
		}
		if (!items.length) {
			const blocks = [...host.children].filter((c) => !INLINE.has(c.tagName) && !c.matches(NOTEXT) && !css(c).display.startsWith("inline"));
			const loose = [...host.childNodes].some((n) => (n.nodeType === 3 && n.nodeValue.trim()) || (n.nodeType === 1 && !blocks.includes(n) && n.tagName !== "BR"));
			if (blocks.length && !loose) items = blocks;
			else {
				// 줄 바꿈(<br>)으로만 나뉜 글: 줄마다 문단으로. 빈 줄은 뺀다
				const lines = host.innerHTML.split(/<br\s*\/?>/i).filter((l) => l.replace(/<[^>]*>|&nbsp;|\s/g, ""));
				host.innerHTML = (lines.length ? lines : [""]).map((l) => `<div>${l}</div>`).join("");
				items = [...host.children];
			}
		}
		items.forEach((li, i) => {
			const m0 = kind === "num" ? `${i + 1}.` : "•";
			li.setAttribute("data-li", "");
			if (!li.style.paddingLeft) li.style.paddingLeft = "1.3em";
			li.style.textIndent = "-1.3em";
			let m = li.querySelector(":scope > [data-bu]");
			if (!m) { m = document.createElement("span"); m.setAttribute("style", MARK); li.prepend(m); }
			m.setAttribute("data-bu", m0);
			m.textContent = m0;
		});
		rewrite(host);
	};
	/** 번호 목록이면 차례대로 다시 매긴다: 항목을 지우거나 Enter 로 늘린 뒤 */
	const renumber = (host) => {
		for (const h of new Set([...host.querySelectorAll("[data-li]")].map((li) => li.parentElement))) {
			const items = [...h.children].filter((c) => c.hasAttribute("data-li"));
			if (!/\d/.test(items[0]?.querySelector(":scope > [data-bu]")?.getAttribute("data-bu") || "")) continue;
			items.forEach((li, i) => { const m = li.querySelector(":scope > [data-bu]"); if (m) { m.setAttribute("data-bu", `${i + 1}.`); m.textContent = `${i + 1}.`; } });
		}
	};
	/** 목록을 고치는 중 Enter: 다음 항목을 연다 (PowerPoint 와 같다). 빈 항목에서 누르면 그 항목을 걷고 마친다. 목록 밖이면 false */
	const listEnter = () => {
		const s = getSelection(), at = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement);
		const li = at?.closest?.("[data-li]");
		if (!li || !edit.el.contains(li) || li === edit.el) return false;
		const mk = li.querySelector(":scope > [data-bu]");
		const rest = [...li.childNodes].filter((n) => n !== mk).map((n) => n.textContent).join("").trim();
		if (!rest) { if ([...li.parentElement.children].length > 1) li.remove(); edit.el.blur(); return true; }
		document.execCommand("insertParagraph");
		// 웹뷰가 새로 연 문단: 속성(data-li · 내어쓰기)을 앞 항목에서 받고, 표지를 맨 앞에 둔다
		const s2 = getSelection(), now = s2.anchorNode && (s2.anchorNode.nodeType === 1 ? s2.anchorNode : s2.anchorNode.parentElement);
		let nl = now;
		while (nl && nl.parentElement !== li.parentElement) nl = nl.parentElement;
		if (nl && nl !== li) {
			for (const a of ["data-li", "style"]) if (!nl.hasAttribute(a) && li.hasAttribute(a)) nl.setAttribute(a, li.getAttribute(a));
			let m = nl.querySelector(":scope > [data-bu]");
			if (m && m !== nl.firstElementChild) { m.remove(); m = null; }
			if (!m && mk) { m = mk.cloneNode(true); nl.prepend(m); }
			if (m) m.contentEditable = "false";
			// 커서를 표지 뒤로: 표지 안에서 글을 쓰면 표지가 늘어난다
			if (m) { const r = document.createRange(); r.setStartAfter(m); r.collapse(true); s2.removeAllRanges(); s2.addRange(r); }
		}
		renumber(edit.el);
		return true;
	};
	/** 들여쓰기: 목록이면 문단마다, 아니면 그 글 덩이의 왼쪽 안쪽 여백을 24px 씩 (PowerPoint 「목록 수준 늘림 · 줄임」) */
	const indent = (el, d) => {
		const host = listHost(el), items = [...host.children].filter((c) => c.hasAttribute("data-li"));
		if (!items.length) return setStyle(el, { "padding-left": P(Math.max(0, (parseFloat(css(el).paddingLeft) || 0) + 24 * d)) });
		for (const li of items) {
			const min = parseFloat(css(li.querySelector(":scope > [data-bu]") || li).minWidth) || 0;
			li.style.paddingLeft = P(Math.max(min, (parseFloat(css(li).paddingLeft) || 0) + 24 * d));
		}
		rewrite(host);
	};

	// ── 표 ── 넣기와 행 · 열 고치기. 고친 표는 innerHTML 째로 되쓴다
	const putTable = ({ r, c }) => {
		if (edit) edit.el.blur();
		const S = root.getBoundingClientRect(), w = Math.min(S.width * 0.8, c * 180), cell = "border:1px solid var(--line, #c8c8c8);padding:8px 12px;text-align:left";
		const head = `<tr>${`<th style="${cell};background:var(--accent, #2f6fde);color:var(--paper, #fff);font-weight:700"></th>`.repeat(c)}</tr>`;
		const body = `<tr>${`<td style="${cell}"></td>`.repeat(c)}</tr>`.repeat(Math.max(0, r - 1));
		const t = document.createElement("template");
		t.innerHTML = `<table style="position:absolute;left:${P((S.width - w) / 2)};top:${P(S.height * 0.3)};width:${P(w)};border-collapse:collapse"><tbody>${head}${body}</tbody></table>`;
		const el = t.content.firstElementChild;
		root.appendChild(el);
		keep(el);
		post({ t: "append", html: el.outerHTML });
		select(el);
	};
	/** 표의 눈금 — 합친 칸이 덮는 자리까지 map[행][열] 에 그 칸을, pos 에 칸마다 시작 자리를 */
	const grid = (table) => {
		const map = [], pos = new Map();
		[...table.rows].forEach((tr, r) => {
			map[r] ||= [];
			let c = 0;
			for (const cell of tr.cells) {
				while (map[r][c]) c++;
				pos.set(cell, { r, c });
				for (let dr = 0; dr < cell.rowSpan; dr++) for (let dc = 0; dc < cell.colSpan; dc++) (map[r + dr] ||= [])[c + dc] = cell;
				c += cell.colSpan;
			}
		});
		return { map, pos };
	};
	const tableOp = (how) => {
		const at = edit ? edit.el : sel;
		const td = at?.closest?.("td, th") || (lastCell?.isConnected && at?.contains(lastCell) ? lastCell : null);
		const table = td?.closest("table") || at?.closest?.("table");
		if (!table || !root.contains(table) || (!td && how !== "del")) return;
		if (edit) edit.el.blur();
		if (how === "del") { post({ t: "remove", path: pathOf(table) }); table.remove(); return select(null); }
		const tr = td.parentElement, rows = [...table.rows], ri = rows.indexOf(tr), ci = td.cellIndex;
		const blank = (c) => { const x = c.cloneNode(false); x.removeAttribute("data-deck-sel"); x.removeAttribute("colspan"); x.removeAttribute("rowspan"); return x; };
		if (how === "rowAbove" || how === "rowBelow") {
			// 머리 행(th) 위 · 아래에 넣는 행은 몸 행 꼴을 따른다: 머리 행이 둘이 되지 않게
			const model = (how === "rowBelow" && rows[ri + 1]) || (tr.querySelector("th") && rows.find((x) => !x.querySelector("th"))) || tr;
			const nr = model.cloneNode(false);
			for (const c of model.cells) nr.appendChild(blank(c));
			if (how === "rowAbove" && !tr.querySelector("th")) tr.before(nr); else tr.after(nr);
		} else if (how === "colLeft" || how === "colRight") {
			for (const row of rows) {
				const c = row.cells[Math.min(ci, row.cells.length - 1)];
				if (!c) continue;
				if (how === "colLeft") c.before(blank(c)); else c.after(blank(c));
			}
		} else if (how === "rowDel") {
			if (rows.length < 2) { post({ t: "remove", path: pathOf(table) }); table.remove(); return select(null); }
			tr.remove();
		} else if (how === "colDel") {
			if (Math.max(...rows.map((x) => x.cells.length)) < 2) { post({ t: "remove", path: pathOf(table) }); table.remove(); return select(null); }
			for (const row of rows) row.cells[ci]?.remove();
		} else if (how === "mergeRight" || how === "mergeDown") {
			// 오른쪽 · 아래로 붙은 칸들과 합친다 (PowerPoint 「셀 병합」). 붙은 칸들이 지금 칸의 높이(너비)를 꼭 맞게 덮고 같은 두께일 때만 — 그래야 네모가 된다.
			// 글은 줄을 바꿔 잇는다
			const g = grid(table), at = g.pos.get(td), right = how === "mergeRight";
			const span = right ? td.rowSpan : td.colSpan, line = right ? at.c + td.colSpan : at.r + td.rowSpan;
			const nbs = [...new Set(Array.from({ length: span }, (_, k) => (right ? g.map[at.r + k]?.[line] : g.map[line]?.[at.c + k])))];
			const fits = nbs.length && nbs.every((x) => {
				if (!x || x === td) return false;
				const p = g.pos.get(x);
				return right ? p.c === line && p.r >= at.r && p.r + x.rowSpan <= at.r + span && x.colSpan === nbs[0].colSpan
					: p.r === line && p.c >= at.c && p.c + x.colSpan <= at.c + span && x.rowSpan === nbs[0].rowSpan;
			});
			if (!fits) return;
			if (right) td.colSpan += nbs[0].colSpan; else td.rowSpan += nbs[0].rowSpan;
			for (const nb of nbs) {
				if ((nb.innerText || "").trim()) { if ((td.innerText || "").trim()) td.append(document.createElement("br")); td.append(...nb.childNodes); }
				nb.remove();
			}
		} else if (how === "split") {
			// 합친 칸을 다시 나눈다 — 칸마다 빈 칸을 채워 넣는다
			if (td.colSpan < 2 && td.rowSpan < 2) return;
			const g = grid(table), at = g.pos.get(td), cs = td.colSpan, rs = td.rowSpan;
			td.colSpan = 1;
			td.rowSpan = 1;
			for (let k = 1; k < cs; k++) td.after(blank(td));
			for (let r = at.r + 1; r < at.r + rs; r++) {
				const row = rows[r];
				if (!row) continue;
				// 그 행에서 이 칸보다 오른쪽에서 시작하는 첫 칸 앞에 끼운다
				const after = [...row.cells].find((c) => g.pos.get(c)?.c > at.c);
				for (let k = 0; k < cs; k++) { const x = blank(td); if (after) after.before(x); else row.appendChild(x); }
			}
		} else if (how && typeof how === "object" && how.border) {
			// 표 테두리 — 칸마다 네 변을 같게 (PowerPoint 표도 칸 테두리로 나간다). none 이면 걷는다
			const v = how.border, s0 = css(td);
			const w = v.width ?? (parseFloat(s0.borderBottomWidth) || 1), c = v.color ?? (s0.borderBottomStyle !== "none" ? s0.borderBottomColor : "var(--line, #c8c8c8)");
			for (const c2 of table.querySelectorAll("td, th")) { if (v.none) c2.style.setProperty("border", "none"); else c2.style.setProperty("border", `${w}px solid ${c}`); }
		}
		select(table);
		keep(table);
		post({ t: "edit", path: pathOf(table), html: table.innerHTML });
		announce();
	};

	// ── 고른 글자에만 ── 글꼴 · 크기 · 간격 · 대소문자 · 색 · 강조 색은 글자를 골랐으면 그 글자만 span 으로 감싸 입힌다 (PowerPoint 와 같다).
	// 글 마디 단위로 감싼다: 범위를 통째로 꺼내 감싸면(extractContents) 문단을 넘는 범위에서 문단이 쪼개진다. 글머리 표지는 건너뛴다
	const wrapRange = (host, range, st) => {
		const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT), cut = [];
		for (let n; (n = w.nextNode());) {
			if (!n.nodeValue || !range.intersectsNode(n) || n.parentElement.closest("[data-bu]")) continue;
			const a = n === range.startContainer ? range.startOffset : 0, b = n === range.endContainer ? range.endOffset : n.nodeValue.length;
			if (a < b) cut.push([n, a, b]);
		}
		const spans = [];
		for (let [n, a, b] of cut) {
			if (b < n.nodeValue.length) n.splitText(b);
			if (a > 0) n = n.splitText(a);
			const p = n.parentElement;
			// 이미 그 글만 감싼 span 이면 거기에 더한다: 감싸기를 거듭해도 span 이 겹겹이 쌓이지 않게
			const sp = p !== host && p.tagName === "SPAN" && p.childNodes.length === 1 ? p : document.createElement("span");
			for (const [k, v] of Object.entries(st)) sp.style.setProperty(k, v);
			if (sp !== p) { n.replaceWith(sp); sp.appendChild(n); }
			spans.push(sp);
		}
		return spans;
	};
	/** 글 서식: 고친 중 고른 글자 · 마치기 전에 골라 둔 글자가 있으면 그 글자에만, 없으면 요소 전체에 */
	const textStyle = (el, st) => {
		const live = edit && ranged();
		const r = live ? { host: edit.el, range: getSelection().getRangeAt(0) } : lastRange?.el.isConnected && sel && (sel === lastRange.el || sel.contains(lastRange.el)) ? lastRange : null;
		if (!r) return setStyle(el, st);
		const spans = wrapRange(r.host ?? r.el, r.range, st);
		if (live) {
			// 고른 자리를 감싼 글자로 다시 잡는다: 이어서 다른 서식을 또 입힐 수 있게
			if (spans.length) { const g = document.createRange(); g.setStartBefore(spans[0]); g.setEndAfter(spans[spans.length - 1]); getSelection().removeAllRanges(); getSelection().addRange(g); }
			return announce();
		}
		lastRange = null;
		rewrite(r.host ?? r.el);
	};
	/** 강조 색: 글자를 골랐으면 그 글자, 아니면 그 글 전체 */
	const highlight = (el, v) => {
		if (edit && ranged()) return exec("hiliteColor", v === "transparent" ? v : rgbOf(v));
		if (lastRange?.el.isConnected) return textStyle(el, { "background-color": v });
		const host = edit ? edit.el : textAt(el, null);
		if (!host) return;
		const all = document.createRange();
		all.selectNodeContents(host);
		wrapRange(host, all, { "background-color": v });
		rewrite(host);
	};
	/** 고치는 중 잘라내기 · 복사: 고른 글자를 앱에 넘긴다(앱이 클립보드에 쓴다). 잘라내기면 그 글자를 지운다 */
	const clipText = (cut) => {
		if (!ranged()) return;
		post({ t: "clip", text: getSelection().toString() });
		if (cut) document.execCommand("delete");
		announce();
	};

	// ── 서식 복사 · 지우기 ──
	const PAINT_TEXT = ["font-family", "font-size", "font-weight", "font-style", "text-decoration", "color", "letter-spacing", "text-transform", "line-height"];
	const PAINT_BOX = ["background-color", "border-top", "border-right", "border-bottom", "border-left", "border-radius", "box-shadow", "opacity"];
	const startPaint = (el, lock) => {
		if (painter && !lock) painter = null;
		else {
			const b = shapeOf(el), s = css(el), bs = css(b);
			// 도형(바탕 · 테두리가 있는 것)에서 집었을 때만 상자 서식도 옮긴다: 맨 글에서 집어 도형에 찍으면 도형 바탕이 지워진다
			const shape = !!color(bs.backgroundColor) || ["Top", "Right", "Bottom", "Left"].some((k) => bs["border" + k + "Style"] !== "none" && parseFloat(bs["border" + k + "Width"]) > 0);
			painter = {
				text: Object.fromEntries(PAINT_TEXT.map((k) => [k, s.getPropertyValue(k)])),
				box: shape ? Object.fromEntries(PAINT_BOX.map((k) => [k, bs.getPropertyValue(k)])) : null,
				// 두 번 누르면 계속 찍는다 (PowerPoint 서식 복사 두 번 누르기). Esc · 쪽 바탕 · 붓 단추로 끝낸다
				lock: !!lock,
			};
		}
		document.documentElement.toggleAttribute("data-deck-paint", !!painter);
		announce();
	};
	const paintOn = (t) => {
		const p = painter;
		if (!p.lock) { painter = null; document.documentElement.removeAttribute("data-deck-paint"); }
		const box = boxOf(t) || t, tt = textAt(t, null) || (editable(t) ? t : null);
		together(() => {
			if (tt) setStyle(tt, p.text);
			if (p.box) setStyle(shapeOf(tt || box), p.box);
		});
		select(box);
	};
	const clearFmt = (el) => {
		if (ranged()) return exec("removeFormat");
		// 글 조각(span · b …)에 박힌 서식도 걷는다: 가져온 PPTX 글은 서식이 조각마다 붙어 있다
		const runs = [...el.querySelectorAll("*")].filter((x) => INLINE.has(x.tagName) && !x.hasAttribute("data-bu") && x.getAttribute("style"));
		for (const x of runs) for (const k of PAINT_TEXT) x.style.removeProperty(k);
		if (runs.length) rewrite(el);
		setStyle(el, Object.fromEntries(PAINT_TEXT.filter((k) => k !== "line-height").map((k) => [k, ""])));
	};
	/** 기호 넣기: 고치는 중이면 커서 자리에, 아니면 고른 글 끝에 */
	const putSymbol = (ch) => {
		if (!edit) {
			const tt = sel && textAt(sel, null);
			if (!tt) return;
			startEdit(tt, null, true);
			getSelection().collapseToEnd();
		}
		document.execCommand("insertText", false, ch);
		announce();
	};
	/** 하이퍼링크 — 고친 중 고른 글자 · 골라 둔 글자(lastRange)에, 없으면 그 글 전체에. 빈 주소면 걷는다.
	 *  이미 링크 안이면 그 링크의 주소만 바꾼다 (링크 안에 링크를 넣지 않는다) */
	const putLink = (el, url) => {
		const live = edit && ranged();
		const r = live ? { host: edit.el, range: getSelection().getRangeAt(0) } : lastRange?.el.isConnected ? lastRange : null;
		const host = r ? r.host ?? r.el : edit ? edit.el : textAt(el, null);
		if (!host) return;
		let range = r?.range;
		if (!range) { range = document.createRange(); range.selectNodeContents(host); }
		const near = [...host.querySelectorAll("a[href]")].filter((a) => range.intersectsNode(a));
		if (!url) { for (const a of near) a.replaceWith(...a.childNodes); }
		else {
			const inA = (n) => (n.nodeType === 1 ? n : n.parentElement)?.closest?.("a[href]");
			const a0 = inA(range.startContainer);
			if (a0 && a0 === inA(range.endContainer) && host.contains(a0)) a0.setAttribute("href", url);
			else for (const sp of wrapRange(host, range, {})) {
				const old = sp.closest("a[href]");
				if (old && host.contains(old)) { old.setAttribute("href", url); continue; }
				const a = document.createElement("a");
				a.setAttribute("href", url);
				sp.replaceWith(a);
				// 서식 없이 감싼 span 은 걷는다
				if (sp.getAttribute("style")) a.appendChild(sp); else a.append(...sp.childNodes);
			}
		}
		// 아무 서식 없는 빈 span 은 걷는다 (감싸기 · 링크 걷기가 남긴 껍데기)
		for (const s of [...host.querySelectorAll("span")]) if (!s.attributes.length) s.replaceWith(...s.childNodes);
		lastRange = null;
		if (live) return announce();
		rewrite(host);
	};
	const removeSel = () => {
		// 여러 개면 하나씩 지우며 그때그때 길을 잰다 — 묶음은 같은 차례로 원본에 적용된다 (edits.ts batch)
		together(() => { for (const el of picks()) { const x = more.length ? el : shapeOf(el); if (!x.isConnected) continue; post({ t: "remove", path: pathOf(x) }); x.remove(); } });
		select(null);
	};

	// ── 회전 · 대칭 ── 인라인 transform 의 rotate() · scaleX(-1) · scaleY(-1) 만 고친다. 다른 변형(가운데 맞춤 translate 등)은 그대로 둔다.
	// 돌린 요소는 내보낼 때 그림으로 구워진다 (needsDeep) — 모양은 같지만 PowerPoint 에서 글을 고치려면 돌리기를 풀어야 한다
	const TF = /(rotate|scaleX|scaleY)\([^)]*\)\s*/g;
	const tfOf = (el) => {
		const s = el.style?.transform || "";
		const r = /rotate\((-?[\d.]+)deg\)/.exec(s);
		return { rest: s.replace(TF, "").trim(), rot: r ? +r[1] : 0, x: /scaleX\(-1\)/.test(s), y: /scaleY\(-1\)/.test(s) };
	};
	const tfText = (p) => [p.rest, p.rot % 360 ? `rotate(${Math.round(p.rot * 10) / 10}deg)` : "", p.x ? "scaleX(-1)" : "", p.y ? "scaleY(-1)" : ""].filter(Boolean).join(" ");
	/** 돌린 각도 0~359 */
	const rotOf = (el) => (el ? ((Math.round(tfOf(el).rot) % 360) + 360) % 360 : 0);
	const flipOf = (el, k) => !!el && tfOf(el)[k];
	/** 쪽 좌표로 잰 돌리기 전 상자 — 돌리기 · 뒤집기는 가운데를 축으로 하므로 가운데는 그대로다. PowerPoint 의 위치 · 크기와 같은 수 */
	const posBox = (el) => {
		const S = root.getBoundingClientRect(), r = el.getBoundingClientRect();
		const w = el.offsetWidth ?? r.width, h = el.offsetHeight ?? r.height;
		return { x: r.left + r.width / 2 - S.left - w / 2, y: r.top + r.height / 2 - S.top - h / 2, w, h };
	};
	const setRot = (el, deg) => { const p = tfOf(el); p.rot = deg; setStyle(el, { transform: tfText(p) }); };
	const setFlip = (el, k) => { const p = tfOf(el); p[k] = !p[k]; setStyle(el, { transform: tfText(p) }); };
	/** 위치 — 쪽 왼쪽 위에서 잰 돌리기 전 상자의 왼쪽 위 (px). 지금 자리와의 차이만큼 left · top 을 민다 */
	const setPos = (el, v) => {
		if (!canMove(el)) return;
		const b = posBox(el), p = posOf(el), st = p.rel ? { position: "relative" } : {};
		if (v.x != null) st.left = P(p.l + v.x - b.x);
		if (v.y != null) st.top = P(p.t + v.y - b.y);
		setStyle(el, st);
	};

	// ── 여러 개 맞춤 · 배분 · 묶기 ──
	/** 고른 것들을 서로에 맞춘다 (PowerPoint 「선택한 개체 맞춤」). 하나뿐이면 쪽에 맞춘다 */
	const alignMany = (how) => {
		const all = picks().filter(canMove);
		if (all.length < 2) return alignTo(how);
		const rs = all.map((x) => x.getBoundingClientRect());
		const L = Math.min(...rs.map((r) => r.left)), T = Math.min(...rs.map((r) => r.top)), R = Math.max(...rs.map((r) => r.right)), B = Math.max(...rs.map((r) => r.bottom));
		together(() => all.forEach((x, i) => {
			const r = rs[i], p = posOf(x);
			const dx = { left: L - r.left, center: (L + R) / 2 - (r.left + r.width / 2), right: R - r.right }[how];
			const dy = { top: T - r.top, middle: (T + B) / 2 - (r.top + r.height / 2), bottom: B - r.bottom }[how];
			setStyle(x, { ...(p.rel ? { position: "relative" } : {}), ...(dx != null ? { left: P(p.l + dx) } : { top: P(p.t + dy) }) });
		}));
	};
	/** 가로 · 세로 간격을 같게 (PowerPoint 「가로 간격을 동일하게」). 셋 이상일 때 양 끝은 그대로 두고 가운데 것들을 민다 */
	const distribute = (axis) => {
		const all = picks().filter(canMove);
		if (all.length < 3) return;
		const h = axis === "h", A = h ? "left" : "top", Z = h ? "width" : "height";
		const items = all.map((x) => ({ x, r: x.getBoundingClientRect() })).sort((a, b) => a.r[A] - b.r[A]);
		const first = items[0].r, last = items[items.length - 1].r;
		const gap = (last[A] + last[Z] - first[A] - items.reduce((s, it) => s + it.r[Z], 0)) / (items.length - 1);
		let at = first[A] + first[Z] + gap;
		together(() => items.slice(1, -1).forEach(({ x, r }) => {
			const p = posOf(x), d = at - r[A];
			setStyle(x, { ...(p.rel ? { position: "relative" } : {}), [h ? "left" : "top"]: P((h ? p.l : p.t) + d) });
			at += r[Z] + gap;
		}));
	};
	/** 묶을 수 있다 — 둘 이상이고, 모두 절대 위치이며 한 부모 아래 있다. 흐름 배치 요소를 묶으면 빠진 자리로 이웃이 밀려든다 */
	const canGroup = () => { const a = picks(); return a.length > 1 && a.every((x) => movable(x) && x.parentElement === a[0].parentElement); };
	/** 묶음 풀기 — 묶음으로 만든 것, 또는 바탕 · 테두리 없이 절대 위치 요소만 둔 상자 (가져온 PPTX 의 그룹). 돌린 묶음은 풀면 자식 자리가 어긋난다 */
	const canUngroup = (el) => {
		if (!el || !movable(el) || el.children.length < 1 || rotOf(el) || ![...el.children].every((c) => movable(c))) return false;
		if (el.hasAttribute("data-group")) return true;
		const s = css(el);
		return el.children.length > 1 && !color(s.backgroundColor) && s.backgroundImage === "none" && !["Top", "Right", "Bottom", "Left"].some((k) => s["border" + k + "Style"] !== "none" && parseFloat(s["border" + k + "Width"]) > 0);
	};
	/** 자식을 옮겨 심을 때의 style — 퍼센트 크기는 새 부모 기준이 되면 달라지므로 px 로 굳힌다. 오른쪽 · 아래 기준 자리는 걷는다 */
	const replant = (x, left, top) => {
		const c = clean(x), s = css(x);
		c.style.left = P(left - (parseFloat(s.marginLeft) || 0));
		c.style.top = P(top - (parseFloat(s.marginTop) || 0));
		c.style.removeProperty("right");
		c.style.removeProperty("bottom");
		if (/%/.test(x.style.width)) c.style.width = P(x.offsetWidth);
		if (/%/.test(x.style.height)) c.style.height = P(x.offsetHeight);
		return c;
	};
	const groupSel = () => {
		if (edit || !canGroup()) return;
		const all = picks(), par = all[0].parentElement, order = [...par.children].filter((c) => all.includes(c));
		const L = Math.min(...order.map((x) => x.offsetLeft)), T = Math.min(...order.map((x) => x.offsetTop));
		const R = Math.max(...order.map((x) => x.offsetLeft + x.offsetWidth)), B = Math.max(...order.map((x) => x.offsetTop + x.offsetHeight));
		const g = document.createElement("div");
		g.setAttribute("data-group", "");
		g.setAttribute("style", `position:absolute;left:${P(L)};top:${P(T)};width:${P(R - L)};height:${P(B - T)}`);
		g.append(...order.map((x) => replant(x, x.offsetLeft - L, x.offsetTop - T)));
		const last = order[order.length - 1];
		together(() => {
			post({ t: "after", path: pathOf(last), html: g.outerHTML });
			last.after(g);
			for (const x of order) { post({ t: "remove", path: pathOf(x) }); x.remove(); }
		});
		select(g);
		keep(g);
	};
	const ungroupSel = () => {
		const g = sel;
		if (edit || more.length || !canUngroup(g)) return;
		const gl = g.offsetLeft + g.clientLeft, gt = g.offsetTop + g.clientTop;
		const kids = [...g.children].map((x) => replant(x, gl + x.offsetLeft, gt + x.offsetTop));
		together(() => {
			post({ t: "after", path: pathOf(g), html: kids.map((c) => c.outerHTML).join("") });
			g.after(...kids);
			post({ t: "remove", path: pathOf(g) });
			g.remove();
		});
		select(kids[0], kids.slice(1));
		keep(kids[0]);
	};
	/** 여러 개를 고른 채 한 요소씩 해도 되는 명령 — 서식 · 순서 · 크기 · 돌리기 */
	const EACH = new Set(["toggle", "font", "spacing", "case", "size", "color", "align", "lineHeight", "valign", "fill", "line", "radius", "shadow", "opacity", "clear", "highlight", "dim", "rotate", "rotateTo", "flip", "arrange"]);
	/** 서식 띠가 보낸 명령 */
	const command = (cmd, v, m) => {
		if (cmd === "place") return setPlace(v ? { kind: v } : null);
		if (cmd === "image") return void putImage(v);
		if (cmd === "paste") return paste(v, m.dx || 0);
		if (cmd === "pasteReq") return post({ t: "pasteReq" });
		if (cmd === "table") return putTable(v);
		if (cmd === "tbl") return tableOp(v);
		// 순서 · 맞춤 · 복제 · 지우기 · 목록은 고친 글을 먼저 마친다: 고치는 중인 요소의 번호 길이 바뀌면 글이 엉뚱한 요소에 쓰인다
		// 고치는 중 잘라내기 · 복사는 고른 글자의 일이다 (Ctrl+X · Ctrl+C 가 웹뷰에서 한다): 상자째 잘라 내지 않는다
		if ((cmd === "cut" || cmd === "copy") && edit) return clipText(cmd === "cut");
		if (["arrange", "alignTo", "dup", "remove", "list", "indent", "dim", "pos", "rotate", "rotateTo", "flip", "group", "ungroup", "distribute"].includes(cmd) && edit) edit.el.blur();
		if (cmd === "selectAll") return selectAll();
		if (cmd === "group") return groupSel();
		if (cmd === "ungroup") return ungroupSel();
		if (cmd === "distribute") return distribute(v);
		// 여러 개를 골랐다 — 맞춤은 서로에게, 복제 · 복사 · 지우기는 모두를, 서식 · 순서 · 돌리기는 하나씩 같은 값으로. 묶음 하나로 쓴다
		if (!edit && more.length) {
			if (cmd === "alignTo") return alignMany(v);
			if (cmd === "dup") return dupMany();
			if (cmd === "copy") return copy();
			if (cmd === "cut") { copy(); return removeSel(); }
			if (cmd === "remove") return removeSel();
			if (cmd === "pos") {
				// 첫째의 자리를 옮긴 만큼 모두 민다 — 서로의 배치는 그대로
				const b0 = posBox(sel), dx = v.x != null ? v.x - b0.x : 0, dy = v.y != null ? v.y - b0.y : 0;
				return together(() => { for (const x of picks()) { const b = posBox(x); setPos(x, { x: b.x + dx, y: b.y + dy }); } });
			}
			if (EACH.has(cmd)) {
				// 굵게 같은 켜고 끄기는 첫째를 기준으로 모두 같은 쪽으로 — 하나씩 뒤집으면 섞인 채로 남는다
				const force = cmd === "toggle" ? !toggled(sel, v) : undefined;
				let all = picks();
				// 맨 앞 · 맨 뒤로 보낼 때 고른 것끼리의 앞뒤는 지킨다
				if (cmd === "arrange") all = all.sort((a, c) => (a.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1) * (v === "front" || v === "forward" ? 1 : -1));
				return together(() => { for (const x of all) one(cmd, v, x, force); });
			}
		}
		const el = edit ? edit.el : sel;
		if (el) one(cmd, v, el);
	};
	/** 명령 하나를 요소 하나에 */
	const one = (cmd, v, el, force) => {
		const b = shapeOf(el);
		if (cmd === "toggle") toggle(v, el, force);
		else if (cmd === "pos") setPos(b, v);
		else if (cmd === "link") putLink(el, v);
		else if (cmd === "rotate") { if (movable(b)) setRot(b, rotOf(b) + v); }
		else if (cmd === "rotateTo") { if (movable(b)) setRot(b, v); }
		else if (cmd === "flip") { if (movable(b)) setFlip(b, v); }
		else if (cmd === "painter") startPaint(el, v === "lock");
		else if (cmd === "clear") clearFmt(el);
		else if (cmd === "symbol") putSymbol(v);
		else if (cmd === "font") textStyle(el, { "font-family": v || "" });
		// 글자 간격은 pt 로 받는다 (PowerPoint 「문자 간격」과 같은 수)
		else if (cmd === "spacing") textStyle(el, { "letter-spacing": v ? Math.round((v / 0.75) * 100) / 100 + "px" : "" });
		else if (cmd === "case") textStyle(el, { "text-transform": v === "none" ? "" : v });
		else if (cmd === "highlight") highlight(el, v);
		else if (cmd === "list") setList(el, v);
		else if (cmd === "indent") indent(el, v);
		else if (cmd === "radius") setStyle(b, { "border-radius": v });
		// 그림자는 바깥 그림자 하나: 내보낼 때 PowerPoint 도형 그림자로 그대로 간다 (simpleShadow)
		else if (cmd === "shadow") setStyle(b, { "box-shadow": v ? "0 4px 14px rgba(0,0,0,0.22)" : "none" });
		else if (cmd === "opacity") setStyle(b, { opacity: v >= 100 ? "" : String(v / 100) });
		else if (cmd === "dim") {
			if (!canMove(b)) return;
			// 칸의 값은 그린 크기(테두리 · 안쪽 여백 포함)다. 안쪽 여백이 있는 상자에 그대로 쓰면 여백만큼 커진다 — 지금 그린 크기와의 차이만큼 고친다
			for (const [k, x] of Object.entries(v)) { const cur = k === "width" ? b.offsetWidth : b.offsetHeight; b.style.setProperty(k, P((parseFloat(css(b)[k]) || 0) + x - cur)); }
			setStyle(b, { ...Object.fromEntries(Object.keys(v).map((k) => [k, b.style.getPropertyValue(k)])), ...reshape(b) });
		}
		else if (cmd === "cut") { if (sel) { copy(); removeSel(); } }
		else if (cmd === "color") { if (ranged()) exec("foreColor", rgbOf(v)); else textStyle(el, { color: v }); }
		// 글자 크기는 pt 로 받는다 (PowerPoint 와 같은 수). 쪽 1px = 0.75pt
		else if (cmd === "size") textStyle(el, { "font-size": Math.round((v / 0.75) * 100) / 100 + "px" });
		else if (cmd === "align") setStyle(el, { "text-align": v });
		// 줄 간격 — 글자 크기의 배수로 쓴다 (단위 없는 line-height). 내보낼 때는 그린 줄 높이(px)를 잰다
		else if (cmd === "lineHeight") setStyle(el, { "line-height": String(v) });
		else if (cmd === "valign") setStyle(b, { "align-items": v });
		else if (cmd === "fill") setStyle(b, { background: v });
		else if (cmd === "line") setLine(b, v);
		else if (cmd === "arrange") arrange(v, el);
		else if (cmd === "alignTo") alignTo(v);
		else if (cmd === "dup") dup();
		else if (cmd === "copy") { if (sel) copy(); }
		else if (cmd === "remove") removeSel();
	};

	// ── 붙기 ── 끌어 옮길 때 쪽 가장자리 · 가운데, 이웃 요소의 가장자리 · 가운데에 붙는다. Alt 를 누르고 끌면 붙지 않는다 (PowerPoint 와 같다)
	const SNAP = 8;
	/** 끌기 시작 때 붙을 자리를 모은다 — 쪽, 쪽의 자식들, 끄는 요소의 형제들 (끄는 요소 · 그 조상 · 자손은 빼고) */
	const snapTargets = (el, group = [el]) => {
		const S = root.getBoundingClientRect(), xs = [0, S.width / 2, S.width], ys = [0, S.height / 2, S.height];
		const near = new Set([...root.children, ...group.flatMap((g) => (g.parentElement ? [...g.parentElement.children] : []))]);
		for (const o of near) {
			if (group.some((g) => o === g || o.contains(g) || g.contains(o)) || o.id === "deck-ui" || !visible(o)) continue;
			const r = o.getBoundingClientRect();
			if (r.width < 4 && r.height < 4) continue;
			xs.push(r.left - S.left, r.left - S.left + r.width / 2, r.right - S.left);
			ys.push(r.top - S.top, r.top - S.top + r.height / 2, r.bottom - S.top);
		}
		// 여러 개를 함께 끌면 모두를 감싼 네모로 붙는다
		const rs = group.map((g) => g.getBoundingClientRect());
		const L = Math.min(...rs.map((r) => r.left)), T = Math.min(...rs.map((r) => r.top)), R = Math.max(...rs.map((r) => r.right)), B = Math.max(...rs.map((r) => r.bottom));
		return { xs, ys, x0: L - S.left, y0: T - S.top, w: R - L, h: B - T, S };
	};
	/** 옮긴 만큼(dx, dy)에서 가장 가까운 붙을 자리로 고친 어긋남과 안내선 */
	const snapMove = (z, dx, dy) => {
		const best = (own, cands) => {
			let b = null;
			for (const o of own) for (const c of cands) { const d = c - o; if (Math.abs(d) <= SNAP && (!b || Math.abs(d) < Math.abs(b.d))) b = { d, at: c }; }
			return b;
		};
		const x = z.x0 + dx, y = z.y0 + dy;
		const bx = best([x, x + z.w / 2, x + z.w], z.xs), by = best([y, y + z.h / 2, y + z.h], z.ys);
		return { dx: dx + (bx ? bx.d : 0), dy: dy + (by ? by.d : 0), gx: bx?.at, gy: by?.at };
	};
	const showGuides = (z, g) => {
		Object.assign(gx.style, g?.gx != null ? { display: "block", left: z.S.left + g.gx - 0.5 + "px", top: z.S.top + "px", width: "1px", height: z.S.height + "px" } : { display: "none" });
		Object.assign(gy.style, g?.gy != null ? { display: "block", top: z.S.top + g.gy - 0.5 + "px", left: z.S.left + "px", height: "1px", width: z.S.width + "px" } : { display: "none" });
	};

	addEventListener("pointerdown", (e) => {
		if (mode !== "edit") return;
		if (place) {
			if (e.button !== 0) return setPlace(null);
			[place.x0, place.y0] = slideXY(e);
			e.preventDefault();
			return;
		}
		// 서식 복사 중: 누른 요소에 찍고 끝낸다. 쪽 바탕 · 오른쪽 단추를 누르면 그만둔다
		if (painter) {
			const t = e.target;
			if (e.button === 0 && t !== root && root.contains(t) && !t.closest?.("#deck-ui")) paintOn(t);
			else { painter = null; document.documentElement.removeAttribute("data-deck-paint"); announce(); }
			e.preventDefault();
			return;
		}
		// 회전 손잡이 — 가운데를 축으로 누른 자리 쪽을 향해 돈다
		if (e.target === spin) {
			if (sel && e.button === 0) {
				const r = sel.getBoundingClientRect();
				turn = { el: sel, cx: r.left + r.width / 2, cy: r.top + r.height / 2, tf: tfOf(sel), moved: false };
				spin.setPointerCapture(e.pointerId);
			}
			e.preventDefault();
			return;
		}
		// 크기 손잡이
		const hd = e.target.closest?.("#deck-ui .h");
		if (hd) {
			if (sel && e.button === 0) {
				const p = posOf(sel);
				size = { el: sel, dir: hd.dataset.dir, x: e.clientX, y: e.clientY, l: p.l, t: p.t, rel: p.rel, w: sel.offsetWidth, h: sel.offsetHeight, img: sel.tagName === "IMG", props: new Set() };
				hd.setPointerCapture(e.pointerId);
			}
			e.preventDefault();
			return;
		}
		const t = e.target.closest("[contenteditable=true]") ? null : e.target;
		// 빈 곳 — 끌면 범위 고르기 (Shift · Ctrl 이면 고른 것에 더한다). 누르기만 하면 고른 것을 푼다
		if (!t || t === root || t === document.body || t === document.documentElement) {
			const add = (e.shiftKey || e.ctrlKey) && !!sel;
			if (!add) select(null);
			if (t && e.button === 0 && !edit) { const [x0, y0] = slideXY(e); band = { x0, y0, add, moved: false }; e.preventDefault(); }
			return;
		}
		// Shift · Ctrl 누르기 — 고른 것에 더하거나 뺀다 (상자 단위)
		if ((e.shiftKey || e.ctrlKey) && e.button === 0 && sel && !edit) {
			const b = boxOf(t) || (canMove(t) ? t : null);
			if (b) { togglePick(b); picked = Date.now(); e.preventDefault(); return; }
		}
		const m = boxOf(t);
		// 여러 개를 고른 채 그중 하나를 누름 — 끌면 모두 함께 옮긴다. 끌지 않고 떼면 그것 하나만 고른다 (pointerup)
		if (more.length && (e.button === 0 || e.button === 2)) {
			const hitPick = picks().find((x) => x === t || x.contains(t));
			// 우클릭은 고른 것을 그대로 두고 메뉴만 연다 (그룹 · 지우기를 모두에)
			if (hitPick && e.button === 2) return;
			if (hitPick) {
				drag = { el: hitPick, x: e.clientX, y: e.clientY, moved: false, group: picks().map((x) => ({ el: x, ...posOf(x) })) };
				e.preventDefault();
				return;
			}
		}
		// 고른 상자를 다시 누름 — 끌면 옮기고, 끌지 않고 떼면 누른 자리 글 고치기. 두 번 누르기의 둘째 누름과 가르려고 시간을 본다
		if (m && m === sel && e.button === 0 && Date.now() - picked > 450) {
			drag = { el: m, x: e.clientX, y: e.clientY, ...posOf(m), moved: false, again: true, hit: t };
			e.preventDefault();
			return;
		}
		// 상자 밖에서 왔으면 상자를 고른다. 이미 상자 안의 요소를 골라 들어와 있으면 누른 요소를 그대로 고른다
		const el = m && (m === sel || !(sel && m.contains(sel))) ? m : t;
		const again = el === sel && e.button === 0 && Date.now() - picked > 450;
		if (el !== sel) picked = Date.now();
		select(el);
		// 우클릭은 고르기만 한다 — 끌기를 시작하면 메뉴를 여는 동안 요소가 손에 붙는다.
		// 옮길 수 있는 요소는 끌기부터 — 끌지 않고 떼었고 이미 골라 둔 요소였으면 그때 글 고치기 (pointerup)
		if (canMove(el) && e.button === 0) {
			drag = { el, x: e.clientX, y: e.clientY, ...posOf(el), moved: false, again, hit: t };
			e.preventDefault();
			return;
		}
		if (again) {
			const tt = textAt(t, el);
			if (tt) return startEdit(tt, { x: e.clientX, y: e.clientY });
		}
	}, true);
	addEventListener("pointermove", (e) => {
		if (place && place.x0 != null) {
			const r = placeRect(e), S = root.getBoundingClientRect();
			Object.assign(ghost.style, { display: "", left: S.left + r.x + "px", top: S.top + r.y + "px", width: Math.max(2, r.w) + "px", height: Math.max(2, r.h) + "px" });
			return;
		}
		if (size) {
			const d = size.dir, dx = e.clientX - size.x, dy = e.clientY - size.y;
			let w = size.w + (d.includes("e") ? dx : d.includes("w") ? -dx : 0);
			let h = size.h + (d.includes("s") ? dy : d.includes("n") ? -dy : 0);
			if (d.length === 2 && (e.shiftKey || size.img)) { const k = Math.max(w / size.w, h / size.h); w = size.w * k; h = size.h * k; }
			w = Math.max(Math.min(8, size.w), w);
			h = Math.max(Math.min(8, size.h), h);
			const st = size.el.style;
			if (/[ew]/.test(d)) { st.width = P(w); size.props.add("width"); }
			if (/[ns]/.test(d)) { st.height = P(h); size.props.add("height"); }
			if (d.includes("w")) { st.left = P(size.l + size.w - w); size.props.add("left"); }
			if (d.includes("n")) { st.top = P(size.t + size.h - h); size.props.add("top"); }
			if (size.rel && (d.includes("w") || d.includes("n"))) st.position = "relative";
			placeHandles();
			return;
		}
		if (turn) {
			let a = (Math.atan2(e.clientX - turn.cx, -(e.clientY - turn.cy)) * 180) / Math.PI;
			// Shift 는 15° 씩, 아니면 0 · 90 · 180 · 270° 근처(4° 안)에서 붙는다
			if (e.shiftKey) a = Math.round(a / 15) * 15;
			else { const q = Math.round(a / 90) * 90; if (Math.abs(a - q) < 4) a = q; }
			turn.moved = true;
			turn.el.style.transform = tfText({ ...turn.tf, rot: Math.round(a) });
			placeHandles();
			return;
		}
		if (band) {
			const [x, y] = slideXY(e), S = root.getBoundingClientRect();
			if (!band.moved && Math.hypot(x - band.x0, y - band.y0) < 4) return;
			band.moved = true;
			band.r = { x: Math.min(x, band.x0), y: Math.min(y, band.y0), w: Math.abs(x - band.x0), h: Math.abs(y - band.y0) };
			Object.assign(ghost.style, { display: "", left: S.left + band.r.x + "px", top: S.top + band.r.y + "px", width: band.r.w + "px", height: band.r.h + "px" });
			return;
		}
		if (!drag) return;
		let dx = e.clientX - drag.x, dy = e.clientY - drag.y;
		if (!drag.moved && Math.hypot(dx, dy) < 3) return;
		if (!drag.moved) drag.z = snapTargets(drag.el, drag.group ? drag.group.map((g) => g.el) : [drag.el]);
		drag.moved = true;
		const g = e.altKey ? null : snapMove(drag.z, dx, dy);
		if (g) ({ dx, dy } = g);
		showGuides(drag.z, g);
		for (const it of drag.group || [drag]) {
			if (it.rel) it.el.style.position = "relative";
			it.el.style.left = Math.round(it.l + dx) + "px";
			it.el.style.top = Math.round(it.t + dy) + "px";
		}
		placeHandles();
	});
	addEventListener("pointerup", (e) => {
		if (place && place.x0 != null) return finishPlace(e);
		if (size) {
			if (size.props.size) {
				const cut = reshape(size.el);
				for (const [k, v] of Object.entries(cut)) size.el.style.setProperty(k, v);
				keep(size.el);
				post({ t: "patch", path: pathOf(size.el), style: { ...posPatch(size.el, size.props), ...cut } });
			}
			size = null;
			// 서식 띠의 크기 · 위치 칸이 끈 뒤의 값을 보이게 (전에는 다른 것을 고를 때까지 옛 값이 남았다)
			announce();
			return;
		}
		if (turn) {
			if (turn.moved) { keep(turn.el); post({ t: "patch", path: pathOf(turn.el), style: { transform: turn.el.style.transform } }); announce(); }
			turn = null;
			return;
		}
		if (band) {
			const b = band;
			band = null;
			ghost.style.display = "none";
			if (!b.moved) return;
			const got = inside(b.r);
			const all = b.add ? [...picks(), ...got.filter((x) => !picks().some((p) => p === x || p.contains(x) || x.contains(p)))] : got;
			if (all.length) { select(all[0], all.slice(1)); picked = Date.now(); }
			return;
		}
		if (drag?.group) {
			showGuides(null, null);
			if (drag.moved) { together(() => { for (const it of drag.group) post({ t: "patch", path: pathOf(it.el), style: posPatch(it.el, ["left", "top"]) }); }); keep(sel); announce(); }
			else { picked = Date.now(); select(drag.el); }
			drag = null;
			return;
		}
		if (drag?.moved) { showGuides(null, null); keep(drag.el); post({ t: "patch", path: pathOf(drag.el), style: posPatch(drag.el, ["left", "top"]) }); announce(); }
		// 고른 상자를 끌지 않고 뗐다 — 누른 자리 글 고치기. 글이 없는 자리(그림 · 아이콘)면 그 요소를 고른다
		else if (drag?.again) {
			const tt = textAt(drag.hit, drag.el);
			if (tt) startEdit(tt, { x: e.clientX, y: e.clientY });
			else if (drag.hit !== drag.el) select(drag.hit);
		}
		drag = null;
	});
	/** 그 자리의 낱말 범위 — 띄어쓰기로 가른다 (한글은 어절) */
	const wordAt = (x, y) => {
		const r = document.caretRangeFromPoint(x, y);
		if (!r || r.startContainer.nodeType !== 3) return null;
		const s = r.startContainer.nodeValue;
		let a = r.startOffset, b = a;
		while (a > 0 && /\S/.test(s[a - 1])) a--;
		while (b < s.length && /\S/.test(s[b])) b++;
		if (a === b) return null;
		const w = document.createRange();
		w.setStart(r.startContainer, a);
		w.setEnd(r.startContainer, b);
		return w;
	};
	// 두 번 누르기 — 글 고치기를 시작하고 누른 낱말을 고른다. 끌기 때문에 누름의 기본 동작을 막아서 브라우저가 낱말을 고르지 않는다 —
	// 그래서 직접 고른다 (2026.11.25 : 낱말이 안 골라져 두 번 누른 뒤 굵게를 누르면 글 전체가 굵어졌다)
	addEventListener("dblclick", (e) => {
		if (mode !== "edit" || edit || place || e.target.closest?.("#deck-ui")) return;
		const tt = textAt(e.target, null);
		startEdit(tt);
		const w = edit && wordAt(e.clientX, e.clientY);
		if (w && tt.contains(w.startContainer)) { const s = getSelection(); s.removeAllRanges(); s.addRange(w); }
	});
	// 슬라이드 안 링크를 눌러도 슬라이드 창이 그 주소로 넘어가지 않게 한다 — 넘어가면 무대 · 쪽 그림이 남의 페이지가 되고 편집이 끊긴다.
	// 링크는 PPTX 로 내보낸 뒤 PowerPoint 에서 쓴다 (2026.11.27)
	addEventListener("click", (e) => { if (e.target.closest?.("a[href]")) e.preventDefault(); }, true);
	// 휠 · 쪽 넘김 키는 앱으로 넘긴다 — 슬라이드 창이 받아 버리면 무대 위에서 휠을 굴리거나, 슬라이드를 한 번 누른 뒤 방향키를 눌러도 쪽이 안 넘어간다
	// Ctrl+휠은 무대 확대/축소다 — 웹뷰가 슬라이드 창만 따로 키우지 않게 막는다
	addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); post({ t: "wheel", dy: e.deltaY, dx: e.deltaX, ctrl: e.ctrlKey }); }, { passive: false });
	// 우클릭도 앱으로 넘긴다 — 웹뷰 기본 메뉴(뒤로 · 새로 고침)는 슬라이드 창을 엉뚱한 곳으로 보낸다.
	// 글자를 고치는 중이면 기본 메뉴(붙여 넣기 · 맞춤법)를 그대로 쓴다
	addEventListener("contextmenu", (e) => {
		if (e.target.isContentEditable) return;
		e.preventDefault();
		const el = e.target.nodeType === 1 && root.contains(e.target) ? (sel && sel.contains(e.target) ? sel : e.target) : root;
		post({ t: "menu", x: e.clientX, y: e.clientY, path: pathOf(el), tag: el.tagName.toLowerCase(), text: el === root ? "" : label(el) });
	});
	// 아직 파일에 쓰지 않은 방향키 이동을 바로 쓴다 — 되돌리기 · 쪽 넘김 전에 (늦게 쓰이면 되돌림을 덮거나, 쪽을 넘긴 뒤에 쓰인다)
	// 여러 개를 함께 밀었으면 모두를 묶음 하나로 쓴다
	let nudge = null;
	const flushNudge = () => { if (nudge) { clearTimeout(nudge.timer); const f = nudge.fn; nudge = null; f(); } };
	addEventListener("keydown", (e) => {
		const k = e.key.toLowerCase(), ctrl = e.ctrlKey && !e.altKey;
		// F5 · Shift+F5 는 슬라이드 쇼 (PowerPoint 와 같다) — 웹뷰가 슬라이드 창을 새로 고치지 않게 앱으로 넘긴다
		if (e.key === "F5") { if (edit) edit.el.blur(); post({ t: "key", key: "F5", shift: e.shiftKey }); e.preventDefault(); return; }
		// Ctrl+F 찾기 · Ctrl+H 바꾸기 · Ctrl+K 링크는 앱의 칸이 연다. 글을 고치는 중이면 고른 글자를 기억해 둔다(lastRange) — 칸으로 포커스가 가면 고치기가 끝난다
		if (ctrl && !e.shiftKey && ["f", "h", "k"].includes(k)) { post({ t: "key", key: { f: "find", h: "replace", k: "link" }[k], bar: true }); e.preventDefault(); return; }
		// 되돌리기 · 다시 하기는 앱이 한다 (손으로 고친 것을 파일째 되쓴다). 글자를 고치는 중이면 그 글의 되돌리기를 쓴다
		if (ctrl && ["z", "y"].includes(k) && !document.activeElement?.isContentEditable) {
			// 아직 파일에 쓰지 않은 방향키 이동이 있으면 먼저 쓴다 — 안 그러면 되돌린 뒤에 늦게 쓰여 되돌림을 덮는다
			flushNudge();
			post({ t: k === "y" || e.shiftKey ? "redo" : "undo" });
			e.preventDefault();
			return;
		}
		// 고른 요소가 없으면(보기만 하는 중) 넘김 키는 쪽을 넘긴다 — 고르기 도구가 늘 켜져 있어도 방향키로 쪽을 넘길 수 있게.
		// 쪽 넘김 키(PageUp · PageDown · Home · End)는 고른 요소가 있어도 넘긴다 — 방향키만 요소 옮기기에 쓴다.
		// 2026.11.27 : 슬라이드를 한 번 누르면 거의 늘 무언가 골라져, Esc 를 먼저 누르기 전에는 PageDown 이 듣지 않았다
		const pageKey = ["PageDown", "PageUp", "Home", "End"].includes(e.key);
		if ((pageKey || mode !== "edit" || !sel) && !place && !document.activeElement?.isContentEditable && (pageKey || e.key.startsWith("Arrow")) && !e.ctrlKey && !e.altKey) {
			flushNudge();
			post({ t: "key", key: e.key });
			e.preventDefault();
			return;
		}
		// 도구 키(V · 1~4 · C · S · F)도 앱으로 넘긴다 — 슬라이드를 한 번 누르면 포커스가 이 창에 와서 앱이 키를 못 받는다.
		// 요소를 고른 채로는 넘기지 않는다 — 2026.11.27 : PowerPoint 처럼 상자를 고르고 타자를 치면 C 에 비교가, S 에 이어 보기가 켜졌다
		if (!edit && !(mode === "edit" && sel) && !e.ctrlKey && !e.altKey && !e.metaKey && /^[vepcsf1-4]$/i.test(e.key) && !document.activeElement?.isContentEditable) {
			if (place) setPlace(null);
			post({ t: "key", key: e.key });
			e.preventDefault();
			return;
		}
		// Esc 는 앱이 한다(비교 닫기 · 지난 판 보기에서 지금으로) — 글을 고치는 중 · 넣는 중 · 고른 것이 있으면 여기서 먼저 푼다
		if (e.key === "Escape" && !edit && !place && !(mode === "edit" && sel)) { post({ t: "key", key: e.key }); e.preventDefault(); return; }
		if (mode !== "edit") return;
		if (edit) {
			// Esc 는 쓴 글을 남기고 마친다(PowerPoint 와 같다) — 되돌리려면 Ctrl+Z.
			// 2026.11.27 : 전에는 Esc 가 쓴 글을 모두 버렸고, 파일에 쓰이지 않아 Ctrl+Z 로도 못 살렸다
			if (e.key === "Escape") { edit.el.blur(); e.preventDefault(); }
			else if (e.key === "Enter" && !e.shiftKey && !e.isComposing && listEnter()) e.preventDefault();
			else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { edit.el.blur(); e.preventDefault(); }
			else if (e.key === "Enter" && e.shiftKey && !e.isComposing) { document.execCommand("insertLineBreak"); e.preventDefault(); }
			return;
		}
		if (place) { if (e.key === "Escape") { setPlace(null); e.preventDefault(); } return; }
		if (painter && e.key === "Escape") { painter = null; document.documentElement.removeAttribute("data-deck-paint"); announce(); e.preventDefault(); return; }
		// 붙여 넣기는 고른 것이 없어도 된다 — 복사한 요소는 앱이 들고 있다가 paste 명령으로 돌려준다
		if (ctrl && k === "v") { post({ t: "pasteReq" }); e.preventDefault(); return; }
		// 모두 고르기 (PowerPoint 와 같다)
		if (ctrl && k === "a") { flushNudge(); selectAll(); e.preventDefault(); return; }
		if (!sel) return;
		if (ctrl && k === "c") { command("copy"); e.preventDefault(); }
		else if (ctrl && k === "x") { command("cut"); e.preventDefault(); }
		else if (ctrl && k === "d") { command("dup"); e.preventDefault(); }
		// 묶기 · 묶음 풀기 (Ctrl+G · Ctrl+Shift+G)
		else if (ctrl && k === "g") { flushNudge(); command(e.shiftKey ? "ungroup" : "group"); e.preventDefault(); }
		else if (ctrl && ["b", "i", "u"].includes(k)) { command("toggle", { b: "bold", i: "italic", u: "underline" }[k]); e.preventDefault(); }
		// Alt+← → 로 15° 씩 돌린다 (PowerPoint 와 같다)
		else if (e.altKey && !e.ctrlKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { command("rotate", e.key === "ArrowLeft" ? -15 : 15); e.preventDefault(); }
		else if (e.ctrlKey || e.altKey) return;
		else if ((e.key === "Enter" || e.key === "F2") && !more.length && textAt(sel, null)) {
			startEdit(textAt(sel, null), null, true);
			e.preventDefault();
		} else if (e.key === "Delete" || e.key === "Backspace") {
			// 리본 「지우기」와 같은 것을 지운다 — 글 하나만 든 카드면 카드째 (전에는 글만 지워 빈 카드가 남았다)
			flushNudge();
			removeSel();
			e.preventDefault();
		} else if (e.key.startsWith("Arrow") && picks().every(canMove)) {
			const d = e.shiftKey ? 10 : 1, all = picks();
			for (const el of all) {
				const { l, t, rel } = posOf(el);
				if (rel) el.style.position = "relative";
				if (e.key === "ArrowLeft") el.style.left = l - d + "px";
				if (e.key === "ArrowRight") el.style.left = l + d + "px";
				if (e.key === "ArrowUp") el.style.top = t - d + "px";
				if (e.key === "ArrowDown") el.style.top = t + d + "px";
			}
			placeHandles();
			announce();
			if (nudge) clearTimeout(nudge.timer);
			const first = sel;
			const fn = () => { keep(first, all.slice(1)); together(() => { for (const el of all) if (el.isConnected) post({ t: "patch", path: pathOf(el), style: posPatch(el, ["left", "top"]) }); }); };
			nudge = { fn, timer: setTimeout(() => { nudge = null; fn(); }, 400) };
			e.preventDefault();
		} else if (e.key === "Escape") select(null);
	});

	addEventListener("message", async (e) => {
		const m = e.data;
		if (!m || !m.__deck) return;
		if (m.t === "css") {
			document.querySelectorAll("link[rel=stylesheet]").forEach((l) => { l.href = l.href.split("?")[0] + "?t=" + Date.now(); });
			setTimeout(placeHandles, 300);
		} else if (m.t === "mode") {
			mode = m.mode;
			document.documentElement.toggleAttribute("data-deck-edit", mode === "edit");
			if (mode !== "edit") { if (place) setPlace(null); select(null); }
			else {
				let k = null;
				try { k = JSON.parse(sessionStorage.getItem(KEEP) || "null"); sessionStorage.removeItem(KEEP); } catch {}
				const el = k && Date.now() - k.at < 5000 && k.path ? atPath(k.path) : null;
				if (el && el !== root) { select(el, (k.more || []).map(atPath).filter((x) => x && x !== root)); picked = Date.now(); window.focus(); }
				// 다시 읽은 쪽이면 띠에 지금 고른 것(없으면 없음)을 알린다 — 띠가 옛 쪽의 고른 것을 들고 있지 않게
				else announce();
			}
		} else if (m.t === "find") {
			// 찾기 칠하기 — CSS 강조 표시라 문서를 바꾸지 않는다 (굽기 · 뽑기 · 원본에 섞이지 않는다)
			try {
				if (!window.CSS?.highlights) return;
				const q = String(m.q || "");
				if (!q) return void CSS.highlights.delete("deck-find");
				const want = m.cs ? q : q.toLowerCase(), ranges = [];
				const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
				for (let n = w.nextNode(); n; n = w.nextNode()) {
					if (n.parentElement?.closest("script, style")) continue;
					const s = m.cs ? n.nodeValue : n.nodeValue.toLowerCase();
					for (let i = s.indexOf(want); i >= 0; i = s.indexOf(want, i + want.length)) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + want.length); ranges.push(r); }
				}
				CSS.highlights.set("deck-find", new Highlight(...ranges));
			} catch {}
		} else if (m.t === "cmd") {
			if (mode === "edit") command(m.cmd, m.v, m);
		} else if (m.t === "hit") {
			const el = document.elementFromPoint(m.x, m.y) || root;
			post({ t: "hit", req: m.req, path: pathOf(el), tag: el.tagName.toLowerCase(), text: el === root ? "" : label(el), cls: el.className && typeof el.className === "string" ? el.className : "" });
		} else if (m.t === "selHit") {
			// 고른 요소 — 「요청에 넣기」가 그 요소 가운데에 핀을 꽂는다 (자리 · 경로 · 글). 글을 고치는 중이면 고치는 요소
			const el = sel || (edit && edit.el);
			if (!el || el === root) post({ t: "selHit", req: m.req, none: true });
			else {
				const r = el.getBoundingClientRect();
				post({ t: "selHit", req: m.req, path: pathOf(el), tag: el.tagName.toLowerCase(), text: label(el), x: r.left + r.width / 2, y: r.top + r.height / 2 });
			}
		} else if (m.t === "snapshot") {
			// 비교 검사용 — 슬라이드 전체를 1:1 로 굽는다
			try {
				await within(document.fonts.ready, 3000);
				const S = root.getBoundingClientRect();
				post({ t: "snapshot", req: m.req, data: await bake(root, { x: 0, y: 0, w: S.width, h: S.height }, true, m.scale || 1) });
			} catch (err) { post({ t: "snapshot", req: m.req, error: String(err) }); }
		} else if (m.t === "extract") {
			try { post({ t: "extracted", req: m.req, data: await extract() }); }
			catch (err) { post({ t: "extracted", req: m.req, error: String(err) }); }
		} else if (m.t === "audit") {
			try { await within(document.fonts.ready, 3000); post({ t: "audited", req: m.req, data: auditNodes() }); }
			catch (err) { post({ t: "audited", req: m.req, error: String(err) }); }
		}
	});

	// ── PPTX 좌표 뽑기 ──
	// 브라우저가 실제로 그린 자리를 잰다 — PPT 쪽에서 배치를 다시 계산하지 않아야 웹과 PPT 가 따로 놀지 않는다.
	// 상자(바탕 · 테두리)는 도형, 글자 묶음은 글상자, 표는 표, 그림 · SVG 는 그림(PNG)으로 넘긴다.
	const INLINE = new Set(["SPAN", "B", "STRONG", "I", "EM", "U", "A", "BR", "SUP", "SUB", "CODE", "SMALL", "MARK", "S", "DEL", "INS", "LABEL", "ABBR", "Q"]);
	// rgb() 밖의 색(color-mix 가 낳는 color(srgb …) · oklch …)은 1px 캔버스에 칠해 픽셀로 읽는다
	const px = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
	px.canvas.width = px.canvas.height = 1;
	const color = (c) => {
		if (!c || c === "transparent" || c === "none") return null;
		const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\)/.exec(c);
		if (!m) {
			px.clearRect(0, 0, 1, 1);
			px.fillStyle = "#000"; px.fillStyle = c;
			px.fillRect(0, 0, 1, 1);
			const [r, g, b, a] = px.getImageData(0, 0, 1, 1).data;
			if (a === 0) return null;
			return { hex: [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase(), alpha: Math.round((a / 255) * 100) / 100 };
		}
		let a = m[4] == null ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : +m[4];
		if (a === 0) return null;
		return { hex: [m[1], m[2], m[3]].map((v) => Math.round(+v).toString(16).padStart(2, "0")).join("").toUpperCase(), alpha: a };
	};
	const visible = (el) => {
		for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
			const s = css(e);
			if (s.display === "none" || s.visibility === "hidden" || +s.opacity === 0) return false;
		}
		return true;
	};
	// 감사(audit.ts)용 — 보이는 요소마다 그려진 자리와 계산된 서식. 굽지 않아 extract 보다 훨씬 빠르다.
	// SVG 속은 그림이라 세지 않는다 (그림 안 색 · 글꼴은 템플릿 밖이어도 PowerPoint 에서 그림이다)
	const auditNodes = () => {
		const S = root.getBoundingClientRect();
		const nodes = [];
		for (const el of [root, ...root.querySelectorAll("*")]) {
			const tag = el.tagName.toLowerCase();
			if (el !== root && el.parentElement && el.parentElement.closest("svg")) continue;
			if (!visible(el)) continue;
			const r = el.getBoundingClientRect();
			if (r.width < 1 || r.height < 1) continue;
			const s = css(el);
			const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(" ").replace(/\s+/g, " ").trim();
			// 글이 실제로 놓인 범위 — 칸이 쪽 너비 전체여도 가운데 맞춤 글은 가장자리에서 멀다. 여백은 이것으로 잰다
			let tb = null;
			if (own) {
				const rg = document.createRange();
				for (const n of el.childNodes) {
					if (n.nodeType !== 3 || !n.nodeValue.trim()) continue;
					rg.selectNodeContents(n);
					const q = rg.getBoundingClientRect();
					if (!q.width) continue;
					tb = tb ? { l: Math.min(tb.l, q.left), t: Math.min(tb.t, q.top), r: Math.max(tb.r, q.right), b: Math.max(tb.b, q.bottom) } : { l: q.left, t: q.top, r: q.right, b: q.bottom };
				}
			}
			const fill = color(s.backgroundColor);
			const bw = Math.max(...["Top", "Right", "Bottom", "Left"].map((k) => (s["border" + k + "Style"] !== "none" ? parseFloat(s["border" + k + "Width"]) || 0 : 0)));
			nodes.push({
				path: pathOf(el), tag, cls: typeof el.className === "string" ? el.className : "",
				x: Math.round(r.left - S.left), y: Math.round(r.top - S.top), w: Math.round(r.width), h: Math.round(r.height),
				text: own.slice(0, 300),
				tbox: tb ? { x: Math.round(tb.l - S.left), y: Math.round(tb.t - S.top), w: Math.round(tb.r - tb.l), h: Math.round(tb.b - tb.t) } : null,
				font: s.fontFamily.split(",")[0].replace(/["']/g, "").trim(),
				size: Math.round(parseFloat(s.fontSize) * 10) / 10, weight: +s.fontWeight || 400,
				color: own ? color(s.color)?.hex || null : null,
				fill: fill && fill.alpha > 0.05 ? fill.hex : null,
				border: bw > 0 ? color(s.borderTopColor)?.hex || null : null,
				radius: parseFloat(s.borderTopLeftRadius) || 0,
				shadow: s.boxShadow !== "none", tshadow: s.textShadow !== "none",
				gradient: /gradient\(/.test(s.backgroundImage), clip: (s.webkitBackgroundClip || s.backgroundClip) === "text",
				upper: s.textTransform === "uppercase", ls: parseFloat(s.letterSpacing) || 0,
				li: s.display === "list-item",
			});
		}
		return { w: S.width, h: S.height, nodes };
	};
	const opacityOf = (el) => { let o = 1; for (let e = el; e && e !== document.documentElement; e = e.parentElement) o *= +css(e).opacity || 1; return o; };
	// 글꼴 목록 전체를 넘긴다 — 앞 글꼴이 이 PC 에 없으면 브라우저는 다음 글꼴로 그린다. 내보내기도 같은 차례로 고른다
	const fontOf = (s) => s.fontFamily.split(",").map((f) => f.replace(/["']/g, "").trim()).filter(Boolean).join("|");
	/** 글머리 표지: 목록 문단(data-li)의 맨 앞 span. 글상자 안 글로 치지 않고 PowerPoint 글머리로 넘긴다 (setList) */
	const isMark = (n) => n.nodeType === 1 && n.hasAttribute("data-bu") && !!n.parentElement?.hasAttribute("data-li") && n === n.parentElement.firstElementChild;
	const isTextBlock = (el) => {
		let text = false;
		for (const n of el.childNodes) {
			if (n.nodeType === 3) { if (n.nodeValue.trim()) text = true; }
			else if (n.nodeType === 1 && !isMark(n)) { if (!INLINE.has(n.tagName) || css(n).display.includes("block") || css(n).display === "flex") return false; }
		}
		return text || (el.innerText || "").trim() !== "";
	};
	// 숨은 iframe 에서는 글꼴 · 그림 준비가 끝없이 미뤄질 때가 있다 — 기다림마다 한도를 둔다
	const within = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
	const hasInlineOnly = (el) => [...el.children].every((c) => isMark(c) || INLINE.has(c.tagName) && !css(c).display.includes("block"));

	// ── 굽기 — 요소를 브라우저가 그린 그대로 PNG 로 ──
	// PowerPoint 가 같은 모양으로 그릴 수 없는 것(그라데이션 · 그림자 · 변형 · 필터 · ::before/::after · 그림 · SVG)은
	// 계산된 서식을 모두 박은 복제본을 SVG foreignObject 에 넣어 같은 엔진으로 그린다. 그림 · 글꼴은 data: 로 바꿔 넣는다
	// (그렇지 않으면 그림이 비거나 캔버스가 막힌다). deep=false 면 자식 없이 그 요소의 바탕 · 테두리 · 그림자만 굽는다.
	const dataCache = new Map();
	const toData = (url) => {
		if (!url || url.startsWith("data:")) return Promise.resolve(url);
		if (!dataCache.has(url)) {
			dataCache.set(url, fetch(url).then((r) => r.blob()).then((b) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); })).catch(() => url));
		}
		return dataCache.get(url);
	};
	const URLS = /url\(\s*["']?([^"')]+)["']?\s*\)/g;
	const inlineUrls = async (v, base = location.href) => {
		let out = v;
		for (const m of [...v.matchAll(URLS)]) {
			// url(#이름) 은 같은 문서 안 참조(화살촉 marker · 그라데이션 · 자르기)다 — 받아 넣으면 이 쪽 HTML 전체가 되어 구운 그림에서 화살촉이 사라졌다 (2026.11.23)
			if (m[1].startsWith("#")) continue;
			out = out.replace(m[0], `url("${await toData(new URL(m[1], base).href)}")`);
		}
		return out;
	};
	// 글꼴 — 문서의 @font-face 를 가족 이름별로 모아 두고, 굽는 요소 안 글자가 쓰는 가족만 넣는다. data: 로 바꾸는 것은 처음 쓸 때 한 번.
	// 2026.11.25 : 전에는 굽기마다 모든 글꼴(덱에 든 Pretendard 만 2MB 넘음)을 통째로 넣어, 글자 없는 그림 · 도형 · 바탕을 구울 때도 SVG 가 몇 MB 였다
	const famKey = (f) => f.trim().replace(/^["']|["']$/g, "").toLowerCase();
	let faceList = null;
	const faces = () => (faceList ||= (() => {
		const out = [];
		for (const sh of document.styleSheets) {
			let rules;
			try { rules = sh.cssRules; } catch { continue; }
			for (const r of rules) if (r instanceof CSSFontFaceRule) out.push({ fam: famKey(r.style.getPropertyValue("font-family")), src: r.cssText, base: sh.href || location.href, css: null });
		}
		return out;
	})());
	/** 구운 그림에 그려질 글자가 쓰는 가족 — 얕게 구우면 자식(글자)은 빠지고 ::before · ::after 만 남는다. 글자가 없으면 비어 있다 */
	const usedFamilies = (el, deep) => {
		const fams = new Set();
		const pseudo = (e) => ["::before", "::after"].some((w) => { const c = getComputedStyle(e, w).content; return !!c && c !== "none" && c !== "normal" && !!unquote(c); });
		for (const e of deep ? [el, ...el.querySelectorAll("*")] : [el]) {
			const text = deep && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
			if (text || pseudo(e)) for (const f of css(e).fontFamily.split(",")) fams.add(famKey(f));
		}
		return fams;
	};
	const fontCss = async (fams) => {
		const out = [];
		for (const f of faces()) {
			if (!fams.has(f.fam)) continue;
			f.css ||= inlineUrls(f.src, f.base);
			out.push(await f.css);
		}
		return out.join("\n");
	};
	// 논리 속성(inset-inline-start · margin-block-end · inline-size …)은 옮기지 않는다 — 계산 값에는 물리 속성(left · margin-bottom · width)과
	// 둘 다 들어 있고, 뒤에 오는 논리 속성이 나중에 바꾼 left · width 를 이겨 복제본이 슬라이드 (0,0) 으로 간다.
	// (2026.11.17 : 다른 요소 안에 놓인 그림 · SVG 가 빈 그림으로 구워진 까닭이었다)
	const LOGICAL = /^(inset|inline-size|block-size|(min|max)-(inline|block)-size)|-(inline|block)(-|$)/;
	const styleText = async (cs) => {
		let t = "";
		for (let i = 0; i < cs.length; i++) {
			const k = cs[i];
			if (LOGICAL.test(k)) continue;
			let v = cs.getPropertyValue(k);
			if (v.includes("url(")) v = await inlineUrls(v);
			t += `${k}:${v};`;
		}
		return t;
	};
	const unquote = (c) => (/^["'].*["']$/.test(c) ? c.slice(1, -1).replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, "$1") : "");
	async function styledClone(el, deep) {
		const clone = el.cloneNode(deep);
		const srcs = deep ? [el, ...el.querySelectorAll("*")] : [el];
		const dsts = deep ? [clone, ...clone.querySelectorAll("*")] : [clone];
		for (let i = 0; i < srcs.length; i++) {
			const s = srcs[i], d = dsts[i];
			d.removeAttribute("data-deck-sel");
			d.removeAttribute("contenteditable");
			d.setAttribute("style", await styleText(css(s)));
			if (s.tagName === "IMG") d.setAttribute("src", await toData(s.currentSrc || s.src));
			if (s.tagName === "image" || s.tagName === "use") {
				const h = s.getAttribute("href") || s.getAttribute("xlink:href");
				if (h && !h.startsWith("#")) d.setAttribute("href", await toData(new URL(h, location.href).href));
			}
			if (s.tagName === "CANVAS") {
				const im = document.createElement("img");
				im.src = s.toDataURL();
				im.setAttribute("style", d.getAttribute("style"));
				d.replaceWith(im);
				continue;
			}
			for (const which of ["::before", "::after"]) {
				const ps = getComputedStyle(s, which);
				if (!ps.content || ps.content === "none" || ps.content === "normal") continue;
				const sp = document.createElement("span");
				sp.setAttribute("style", await styleText(ps));
				sp.textContent = unquote(ps.content);
				which === "::before" ? d.prepend(sp) : d.append(sp);
			}
		}
		return clone;
	}
	/** 요소 하나를 굽는다. box 는 슬라이드 좌표로 그릴 영역(그림자가 넘치면 넓힌다). */
	async function bake(el, box, deep, scale = 2) {
		const S = root.getBoundingClientRect();
		// 변형 전 자리 — 복제본을 같은 자리에 두면 변형 · 그림자가 원래대로 그려진다
		const old = el.style.transform;
		const tf = css(el).transform;
		if (tf !== "none") el.style.transform = "none";
		const L = el.getBoundingClientRect();
		if (tf !== "none") el.style.transform = old;
		const clone = await styledClone(el, deep);
		if (el !== root) {
			clone.style.position = "absolute";
			clone.style.left = L.left - S.left + "px";
			clone.style.top = L.top - S.top + "px";
			clone.style.margin = "0";
		}
		clone.style.boxSizing = "border-box";
		clone.style.width = L.width + "px";
		clone.style.height = L.height + "px";
		const wrap = document.createElement("div");
		wrap.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
		wrap.setAttribute("style", `position:relative;width:${S.width}px;height:${S.height}px;overflow:hidden;margin:0;background:transparent`);
		const st = document.createElement("style");
		const fams = usedFamilies(el, deep);
		st.textContent = fams.size ? await fontCss(fams) : "";
		wrap.append(st, clone);
		const xml = new XMLSerializer().serializeToString(wrap);
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${box.w}" height="${box.h}" viewBox="${box.x} ${box.y} ${box.w} ${box.h}"><foreignObject x="0" y="0" width="${S.width}" height="${S.height}">${xml}</foreignObject></svg>`;
		const img = new Image();
		img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
		await within(img.decode(), 8000);
		// 그리지 못한 그림을 빈칸으로 넘기지 않는다 — 빈 그림은 PPT 에서 「빠진 요소」가 된다
		if (!img.complete || !img.naturalWidth) throw new Error("bake: decode failed");
		const c = document.createElement("canvas");
		c.width = Math.max(1, Math.round(box.w * scale));
		c.height = Math.max(1, Math.round(box.h * scale));
		c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
		return c.toDataURL("image/png");
	}
	/** 그림자 · 외곽선 · 필터가 상자 밖으로 그리는 여유 */
	const overflowOf = (s) => {
		let pad = 0;
		if (s.boxShadow !== "none") {
			for (const part of s.boxShadow.split(/,(?![^(]*\))/)) {
				if (part.includes("inset")) continue;
				const n = (part.replace(/rgba?\([^)]*\)|color\([^)]*\)/g, "").match(/-?[\d.]+px/g) || []).map(parseFloat);
				pad = Math.max(pad, Math.abs(n[0] || 0) + Math.abs(n[1] || 0) + (n[2] || 0) * 1.5 + Math.max(0, n[3] || 0));
			}
		}
		if (s.outlineStyle !== "none") pad = Math.max(pad, (parseFloat(s.outlineWidth) || 0) + Math.abs(parseFloat(s.outlineOffset) || 0));
		if (s.filter !== "none") pad = Math.max(pad, 40);
		return Math.ceil(pad);
	};
	const pseudoOn = (el, w) => { const c = getComputedStyle(el, w).content; return !!c && c !== "none" && c !== "normal"; };
	/** 자식까지 통째로 구워야 하는가 — 그 요소의 효과가 자식의 모양까지 바꾼다 */
	const needsDeep = (el, s) =>
		["IMG", "CANVAS", "VIDEO", "PICTURE", "svg"].includes(el.tagName) ||
		s.transform !== "none" || s.filter !== "none" || (s.backdropFilter && s.backdropFilter !== "none") || s.mixBlendMode !== "normal" ||
		(s.clipPath !== "none" && !GEOM[el.getAttribute?.("data-shape")]) || (s.maskImage && s.maskImage !== "none") || (s.webkitMaskImage && s.webkitMaskImage !== "none") ||
		s.textShadow !== "none" || s.writingMode !== "horizontal-tb" || s.backgroundClip === "text" || s.webkitBackgroundClip === "text" ||
		(s.display === "list-item" && s.listStyleType !== "none");
	/** 바깥 그림자 하나(안쪽 · 퍼짐 없음) — PowerPoint 도형 그림자로 그대로 옮긴다. 그 밖의 그림자는 null (상자를 굽는다).
	 *  2026.11.24 : 가져온 PPTX 의 도형 그림자를 box-shadow 로 그리게 되어, 굽지 않고 도형 그림자로 내보낸다 */
	const simpleShadow = (s) => {
		if (s.boxShadow === "none" || s.boxShadow.split(/,(?![^(]*\))/).length > 1 || s.boxShadow.includes("inset")) return null;
		const c = color((/rgba?\([^)]*\)|color\([^)]*\)/.exec(s.boxShadow) || [])[0]);
		const n = (s.boxShadow.replace(/rgba?\([^)]*\)|color\([^)]*\)/g, "").match(/-?[\d.]+px/g) || []).map(parseFloat);
		if (!c || n.length < 2 || (n[3] || 0) !== 0) return null;
		return { x: n[0], y: n[1], blur: n[2] || 0, ...c };
	};
	/** 그 요소의 바탕 · 테두리만 구우면 되는가 — PowerPoint 도형으로 같은 모양이 안 나온다 */
	const needsShallow = (el, s) => {
		if (s.backgroundImage !== "none" || (s.boxShadow !== "none" && !simpleShadow(s)) || (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0)) return true;
		if (pseudoOn(el, "::before") || pseudoOn(el, "::after")) return true;
		const rad = [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius];
		if (new Set(rad).size > 1 || rad[0].trim().includes(" ")) return true;
		const sides = ["Top", "Right", "Bottom", "Left"].map((k) => [parseFloat(s["border" + k + "Width"]) || 0, s["border" + k + "Style"], s["border" + k + "Color"]]).filter(([w, st]) => w > 0 && st !== "none");
		if (sides.some(([, st]) => !["solid", "dashed", "dotted"].includes(st))) return true;
		// 네 변이 다 있는데 굵기 · 모양 · 색이 다르거나, 일부 변만 있으면서 모서리가 둥글면 도형 · 선으로 같게 못 그린다
		if (sides.length === 4 && new Set(sides.map((x) => x.join("|"))).size > 1) return true;
		if (sides.length > 0 && sides.length < 4 && parseFloat(rad[0]) > 0) return true;
		return false;
	};

	// 첫 줄 기준선 — 첫 글자의 글자 상자 위끝 + 글꼴 위 높이(ascent). DOM 을 건드리지 않고 잰다
	// (flex 상자에 재는 요소를 넣으면 배치가 바뀐다). 줄 높이가 normal 이면 글꼴의 위 · 아래 높이 합이다.
	const metric = document.createElement("canvas").getContext("2d");
	const fontMetrics = (s) => {
		metric.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
		const m = metric.measureText("가Ag");
		return { asc: m.fontBoundingBoxAscent, desc: m.fontBoundingBoxDescent };
	};
	function firstBaseline(el) {
		const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		for (let n; (n = w.nextNode());) {
			const i = n.nodeValue.search(/\S/);
			if (i < 0) continue;
			const r = document.createRange();
			r.setStart(n, i); r.setEnd(n, i + 1);
			const rect = r.getClientRects()[0];
			if (!rect) continue;
			const s = css(n.parentElement);
			return { y: rect.top + fontMetrics(s).asc, size: parseFloat(s.fontSize), s };
		}
		return null;
	}

	// 글자 조각. 브라우저가 실제로 줄을 바꾼 자리에서 조각을 나누고 soft 를 단다 — PPT 에서 같은 자리에 줄 바꿈(<a:br>)을 넣어
	// 한국어 낱말 끊기(keep-all)와 줄 수가 웹과 같게 된다. PowerPoint 는 한국어를 글자 단위로 끊는다.
	function runsOf(el, noMark) {
		const runs = [];
		const line = { top: null };
		const range = document.createRange();
		const topAt = (n, i) => { range.setStart(n, i); range.setEnd(n, i + 1); const r = range.getClientRects()[0]; return r ? Math.round(r.top) : null; };
		const walk = (node) => {
			for (const n of node.childNodes) {
				if (n.nodeType === 3) {
					const s = css(n.parentElement), c = color(s.color);
					const tt = s.textTransform;
					const raw = tt === "uppercase" ? n.nodeValue.toUpperCase() : tt === "lowercase" ? n.nodeValue.toLowerCase() : n.nodeValue;
					if (!raw.trim() && !runs.length) continue;
					const style = {
						size: parseFloat(s.fontSize), weight: +s.fontWeight || 400, bold: +s.fontWeight >= 600, italic: s.fontStyle === "italic",
						spacing: parseFloat(s.letterSpacing) || 0,
						underline: s.textDecorationLine.includes("underline"), strike: s.textDecorationLine.includes("line-through"),
						color: c ? c.hex : "000000", alpha: c ? c.alpha : 1, font: fontOf(s),
						// 글 조각(인라인)의 바탕색 = PowerPoint 의 글자 강조 표시. 문단 · 상자 바탕은 상자가 따로 그린다
						highlight: s.display.startsWith("inline") && n.parentElement !== el ? color(s.backgroundColor)?.hex || null : null,
						// 하이퍼링크 — 그 글 덩이 안의 <a href> (PowerPoint 글 하이퍼링크)
						link: (() => { const a = n.parentElement.closest("a[href]"); return a && el.contains(a) ? a.href : null; })(),
					};
					let start = 0, soft = false;
					for (let i = 0; i < raw.length; i++) {
						if (/\s/.test(raw[i])) continue;
						const top = topAt(n, i);
						if (top == null) continue;
						if (line.top != null && top > line.top + 2) {
							if (i > start) runs.push({ ...style, text: raw.slice(start, i).replace(/\s+/g, " "), soft });
							else if (!runs.length || runs[runs.length - 1].br) { /* 앞에 조각이 없으면 줄 바꿈만 */ }
							start = i;
							soft = true;
						}
						line.top = top;
					}
					runs.push({ ...style, text: raw.slice(start).replace(/\s+/g, " "), soft });
				} else if (n.nodeType === 1) {
					if (n.tagName === "BR") { runs.push({ text: "\n", br: true }); line.top = null; }
					else if (noMark && isMark(n)) { /* 글머리 표지는 문단의 글머리로 넘긴다 */ }
					else if (visible(n)) walk(n);
				}
			}
		};
		walk(el);
		// 줄 끝 · 줄 머리 빈칸은 덜어 낸다 — 들여쓰기 줄바꿈과 끊긴 자리의 빈칸이 PPT 에서 빈칸으로 남는다
		runs.forEach((r, i) => {
			if (r.br) return;
			const next = runs[i + 1];
			if (i === 0 || r.soft || runs[i - 1]?.br) r.text = r.text.replace(/^\s+/, "");
			if (!next || next.soft || next.br) r.text = r.text.replace(/\s+$/, "");
		});
		return runs.filter((r) => r.br || r.text !== "");
	}

	async function extract() {
		await within(document.fonts.ready, 3000);
		const S = root.getBoundingClientRect();
		const R = (r) => ({ x: r.left - S.left, y: r.top - S.top, w: r.width, h: r.height });
		const items = [];
		const fails = [];
		const rs = css(root);
		const bg = color(rs.backgroundColor) || color(css(document.body).backgroundColor);
		// 슬라이드 바탕에 그림 · 그라데이션 · 장식이 있으면 바탕을 구워 맨 아래에 깐다
		if (rs.backgroundImage !== "none" || pseudoOn(root, "::before") || pseudoOn(root, "::after")) {
			try { items.push({ type: "image", x: 0, y: 0, w: S.width, h: S.height, data: await bake(root, { x: 0, y: 0, w: S.width, h: S.height }, false), baked: "background", tag: "section" }); } catch {}
		}
		// 조상이 넘친 부분을 자르면(overflow) 굽는 상자도 그만큼 줄인다 — 잘라 쓴 그림(PPT 의 그림 자르기)이 PPTX 에서 원본 크기로 튀어나왔다 (2026.11.18)
		const clipped = (el, box) => {
			let x0 = box.x, y0 = box.y, x1 = box.x + box.w, y1 = box.y + box.h;
			for (let a = el.parentElement; a && a !== root && a !== document.body; a = a.parentElement) {
				const o = css(a);
				if (o.overflowX === "visible" && o.overflowY === "visible") continue;
				const c = R(a.getBoundingClientRect());
				if (o.overflowX !== "visible") { x0 = Math.max(x0, c.x); x1 = Math.min(x1, c.x + c.w); }
				if (o.overflowY !== "visible") { y0 = Math.max(y0, c.y); y1 = Math.min(y1, c.y + c.h); }
			}
			return x1 - x0 < 0.5 || y1 - y0 < 0.5 ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
		};
		// 묶음 — 도형마다 그것을 낳은 요소와 그 조상 요소의 번호(g)를 단다. 내보낼 때 같은 요소에서 나온 도형 둘 이상을
		// PowerPoint 그룹으로 묶는다 (exportPptx.ts groupSlides). 카드 하나가 상자 · 제목 · 본문으로 흩어지면 옮길 때 하나씩 끌어야 했다
		const groups = {};
		let gid = 0;
		/** 도형 하나를 (cx, cy) 를 축으로 deg 만큼 돌린다 — 가운데 자리를 옮기고 PowerPoint 회전 각을 더한다. 선은 두 끝을 옮긴다 */
		const turnItem = (it, cx, cy, deg) => {
			const a = (deg * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
			const rot = (x, y) => [cx + (x - cx) * cs - (y - cy) * sn, cy + (x - cx) * sn + (y - cy) * cs];
			if (it.type === "line") { [it.x1, it.y1] = rot(it.x1, it.y1); [it.x2, it.y2] = rot(it.x2, it.y2); return; }
			const [nx, ny] = rot(it.x + it.w / 2, it.y + it.h / 2);
			it.x = nx - it.w / 2;
			it.y = ny - it.h / 2;
			it.rot = (((it.rot || 0) + deg) % 360 + 360) % 360;
		};
		/** 돌리기만 한 요소의 각도 — 인라인 transform 이 rotate() 하나뿐이고 표가 없을 때. 아니면 0 (전처럼 굽는다) */
		const spinOf = (ch) => {
			if (!ch.style?.transform) return 0;
			const p = tfOf(ch);
			if (!p.rot || p.x || p.y || p.rest || ch.querySelector("table")) return 0;
			return p.rot;
		};
		const visit = async (el, chain) => {
			for (const ch of el.children) {
				if (!(ch instanceof Element) || ch.tagName === "SCRIPT" || ch.tagName === "STYLE" || !visible(ch)) continue;
				const me = [...chain, ++gid];
				// 그룹 이름 — PowerPoint 「선택 창」에서 알아보게 이름표 · 첫 줄 글 · class 순으로 고른다 (div 만으로는 어느 묶음인지 모른다)
				const line = (ch.innerText || "").trim().split(/\r?\n/)[0].trim();
				groups[gid] = ch.dataset?.name || ch.getAttribute("aria-label") || ch.id || (line && (line.length > 24 ? line.slice(0, 24) + "…" : line)) || (typeof ch.className === "string" && ch.className.trim().split(/\s+/)[0]) || ch.tagName.toLowerCase();
				const start = items.length;
				await one(ch, me);
				// 자손이 먼저 자기 번호를 달았으므로 아직 비어 있는 것이 이 요소가 낳은 도형이다
				for (let k = start; k < items.length; k++) if (!items[k].g) items[k].g = me;
			}
		};
		const one = async (ch, me, spun) => {
			// 돌린 요소 (회전 손잡이 · 서식 띠가 단 rotate 하나) — 돌리기를 잠시 풀고 재어, 그 안에서 나온 도형을 가운데를 축으로 돌려 PowerPoint 회전으로 넘긴다.
			// 그림으로 굽지 않으니 PowerPoint 에서도 글 · 도형을 고칠 수 있다. 뒤집기 · 다른 변형이 섞였거나 표가 들었으면 전처럼 통째로 굽는다 (2026.11.27)
			const deg = spun ? 0 : spinOf(ch);
			if (deg) {
				const old = ch.style.transform, c0 = ch.getBoundingClientRect(), cx = c0.left + c0.width / 2 - S.left, cy = c0.top + c0.height / 2 - S.top;
				const start = items.length;
				ch.style.transform = "none";
				try { await one(ch, me, true); } finally { ch.style.transform = old; }
				for (let k = start; k < items.length; k++) turnItem(items[k], cx, cy, deg);
				return;
			}
			const s = css(ch), r = R(ch.getBoundingClientRect()), op = opacityOf(ch);
			if (r.w < 0.5 || r.h < 0.5) return;
			// 화살표 — 끝에 촉이 달린 PowerPoint 선 하나 (촉 <i> 는 따로 넘기지 않는다)
			if (ch.hasAttribute("data-arrow")) {
				const c = color(s.color) || color(s.borderTopColor), w = parseFloat(s.borderTopWidth) || 2;
				if (c) items.push({ type: "line", x1: r.x, y1: r.y + w / 2, x2: r.x + r.w, y2: r.y + w / 2, color: c.hex, w, dash: s.borderTopStyle, arrow: ch.getAttribute("data-arrow") });
				return;
			}
			// 통째로 굽기 — 그 요소와 자식이 한 장의 그림이 된다
			if (needsDeep(ch, s)) {
				const pad = overflowOf(s), box = clipped(ch, { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 });
				if (!box) return;
				try { items.push({ type: "image", ...box, data: await bake(ch, box, true), alt: ch.getAttribute("alt") || "", baked: "whole", tag: ch.tagName.toLowerCase() }); } catch (e) { fails.push(`${ch.tagName} ${String(e)}`); }
				return;
			}
			// 바탕 · 테두리만 굽기 — 글자 · 자식은 그 위에 그대로 편집할 수 있게 남는다
			const shallow = needsShallow(ch, s);
			if (shallow) {
				const pad = overflowOf(s), box = { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
				try { items.push({ type: "image", ...box, data: await bake(ch, box, false), baked: "background", tag: ch.tagName.toLowerCase() }); } catch (e) { fails.push(`${ch.tagName} ${String(e)}`); }
			}
			// 상자
			const fill = color(s.backgroundColor);
			const bw = parseFloat(s.borderTopWidth) || 0, bc = color(s.borderTopColor);
			const sides = ["Top", "Right", "Bottom", "Left"].map((k) => (parseFloat(s["border" + k + "Width"]) || 0) > 0 && s["border" + k + "Style"] !== "none");
			const full = sides.every(Boolean);
			if (!shallow && (fill || (full && bc && bw))) {
				const geom = GEOM[ch.getAttribute("data-shape")] ? ch.getAttribute("data-shape") : undefined;
				items.push({ type: "box", ...r, geom, fill: fill ? { ...fill, alpha: fill.alpha * op } : null, line: !geom && full && bc && bw ? { ...bc, w: bw, dash: s.borderTopStyle } : null, radius: parseFloat(s.borderTopLeftRadius) || 0, round: s.borderTopLeftRadius.includes("%") && parseFloat(s.borderTopLeftRadius) >= 50, shadow: simpleShadow(s) });
			}
			// 한 변만 그은 선 (구분선 · 밑줄 강조)
			if (!shallow && !full) {
				["Top", "Right", "Bottom", "Left"].forEach((k, i) => {
					if (!sides[i]) return;
					const w = parseFloat(s["border" + k + "Width"]), c = color(s["border" + k + "Color"]);
					if (!c) return;
					const L = { Top: [r.x, r.y + w / 2, r.x + r.w, r.y + w / 2], Bottom: [r.x, r.y + r.h - w / 2, r.x + r.w, r.y + r.h - w / 2], Left: [r.x + w / 2, r.y, r.x + w / 2, r.y + r.h], Right: [r.x + r.w - w / 2, r.y, r.x + r.w - w / 2, r.y + r.h] }[k];
					items.push({ type: "line", x1: L[0], y1: L[1], x2: L[2], y2: L[3], color: c.hex, w, dash: s["border" + k + "Style"] });
				});
			}
			// 표
			if (ch.tagName === "TABLE") {
				const rows = [...ch.rows].map((tr) => [...tr.cells].map((td) => {
					const cs = css(td), c = color(cs.color), b = color(cs.backgroundColor) || color(css(tr).backgroundColor);
					// 칸 글자는 안쪽 span 마다 서식이 달라 조각(run)으로 넘긴다. 문단(p · div)이 나뉘면 줄을 바꾼다
					const runs = [];
					const blocks = [...td.querySelectorAll("p, div, li")].filter((e) => !e.querySelector("p, div, li") && (e.innerText || "").trim());
					if (blocks.length) blocks.forEach((bl, k) => { if (k) runs.push({ text: "\n", br: true }); runs.push(...runsOf(bl)); });
					else runs.push(...runsOf(td));
					const va = { top: "top", bottom: "bottom" }[cs.verticalAlign] || "middle";
					const pa = blocks[0] ? css(blocks[0]).textAlign : cs.textAlign;
					return { runs, text: td.innerText.trim(), size: parseFloat(cs.fontSize), bold: +cs.fontWeight >= 600, color: c ? c.hex : "000000", fill: b ? b.hex : null, align: pa, valign: va, font: fontOf(cs), colspan: td.colSpan, rowspan: td.rowSpan, border: color(cs.borderBottomColor)?.hex || null, bw: parseFloat(cs.borderBottomWidth) || 0, pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(parseFloat) };
				}));
				// 열 너비는 모든 칸의 좌우 경계에서 구한다 — 첫 행에 합친 칸(colspan)이 있으면 첫 행 칸 수가 열 수보다 적어 열이 통째로 밀린다 (2026.11.18)
				const edges = [...new Set([...ch.rows].flatMap((tr) => [...tr.cells].flatMap((td) => { const b = td.getBoundingClientRect(); return [Math.round(b.left * 2) / 2, Math.round(b.right * 2) / 2]; })))].sort((x, y) => x - y)
					.filter((x, i, a) => i === 0 || x - a[i - 1] > 2);
				const colW = edges.slice(1).map((x, i) => x - edges[i]);
				const rowH = [...ch.rows].map((tr) => tr.getBoundingClientRect().height);
				items.push({ type: "table", ...r, rows, colW, rowH });
				return;
			}
			// 글자
			if (isTextBlock(ch) && hasInlineOnly(ch)) {
				const pl = parseFloat(s.paddingLeft) + (parseFloat(s.borderLeftWidth) || 0), pr = parseFloat(s.paddingRight) + (parseFloat(s.borderRightWidth) || 0);
				const pt = parseFloat(s.paddingTop) + (parseFloat(s.borderTopWidth) || 0), pb = parseFloat(s.paddingBottom) + (parseFloat(s.borderBottomWidth) || 0);
				const mark = [...ch.children].find(isMark), runs = runsOf(ch, !!mark);
				if (runs.length) {
					const flex = s.display.includes("flex") || s.display.includes("grid");
					// 끝 맞춤은 표기가 엔진마다 다르다 — WebView2 는 flex-end 를 flow-end 로 돌려준다. 그래서 「end 로 끝나는가」로 본다
					// (2026.11.25 : flex-end 만 보아 아래 맞춤 글이 PPTX 에서 위 맞춤으로 나갔다)
					const END = /(^|-)end$/;
					const valign = flex ? (s.alignItems === "center" ? "middle" : END.test(s.alignItems) ? "bottom" : "top") : s.verticalAlign === "middle" ? "middle" : "top";
					let align = s.textAlign;
					if (flex && (s.justifyContent === "center")) align = "center";
					if (flex && (END.test(s.justifyContent) || s.justifyContent === "right")) align = "right";
					// 줄 높이는 늘 px 로 넘긴다 — normal 을 PowerPoint 기본 줄 간격에 맡기면 글꼴마다 어긋난다
					const fb = firstBaseline(ch);
					const lhRaw = parseFloat(s.lineHeight);
					const fm = fontMetrics(fb ? fb.s : s);
					const lh = isNaN(lhRaw) ? fm.asc + fm.desc : lhRaw;
					const top = r.y + pt;
					// 글머리 문단: 글상자를 표지 자리(내어쓰기만큼 왼쪽)에서 열고, 글머리와 글 사이를 내어쓰기 너비로 둔다
					const ti = mark ? Math.min(0, parseFloat(s.textIndent) || 0) : 0;
					const bullet = mark ? { ...(/^\d+/.test(mark.getAttribute("data-bu")) ? { num: parseInt(mark.getAttribute("data-bu"), 10) } : { char: mark.getAttribute("data-bu") || "•" }), indent: -ti || mark.getBoundingClientRect().width } : undefined;
					items.push({ type: "text", x: r.x + pl + ti, y: top, w: r.w - pl - pr - ti, h: r.h - pt - pb, runs, bullet, align: align === "start" ? "left" : align === "end" ? "right" : align, valign, lineHeight: lh, baseline: fb ? fb.y - S.top - top : null, size0: fb ? fb.size : parseFloat(s.fontSize), alpha: op });
				}
				return;
			}
			// 블록 자식과 섞인 맨 글자 — 글자 조각마다 따로
			for (const n of ch.childNodes) {
				if (n.nodeType !== 3 || !n.nodeValue.trim()) continue;
				const range = document.createRange(); range.selectNodeContents(n);
				const rr = R(range.getBoundingClientRect()), c = color(s.color);
				items.push({ type: "text", ...rr, runs: [{ text: n.nodeValue.trim(), size: parseFloat(s.fontSize), bold: +s.fontWeight >= 600, italic: s.fontStyle === "italic", color: c ? c.hex : "000000", font: fontOf(s) }], align: "left", valign: "top" });
			}
			await visit(ch, me);
		};
		await visit(root, []);
		return { w: S.width, h: S.height, background: bg, items, fails, groups };
	}

	// 시험 도구(tools/cdp.mjs)가 슬라이드 안에서 굽기 · 뽑기를 바로 부를 수 있게
	window.__rt = { bake, extract, styledClone };
	post({ t: "ready", w: root.getBoundingClientRect().width, h: root.getBoundingClientRect().height });
})();
