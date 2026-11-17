// 슬라이드 런타임 — deck:// 이 슬라이드 HTML 을 내줄 때 </body> 앞에 끼워 넣는다 (원본 파일에는 없다).
// 앱 화면(부모 창)과 postMessage 로만 말한다. 슬라이드 좌표는 늘 1:1 픽셀(보통 1280×720)이다 — 확대 · 축소는 부모가 한다.
//
// 받는 말                         보내는 말
//   css                 CSS 만 다시 읽기       ready {w,h}
//   mode {mode}         view · pin · edit      hit {req, path, tag, text}
//   hit {req,x,y}       그 자리 요소 찾기       edit {path, html}         글자를 고쳤다
//   extract {req}       PPTX 용 좌표 뽑기      patch {path, style}       끌어 옮겼다 · 크기를 바꿨다
//                                              remove {path}             지웠다
//                                              extracted {req, data}
(() => {
	const root = document.querySelector(".slide") || document.body;
	const post = (m) => parent.postMessage({ __deck: 1, ...m }, "*");
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
	const label = (el) => {
		const t = (el.innerText || el.getAttribute("alt") || "").replace(/\s+/g, " ").trim();
		return t.length > 60 ? t.slice(0, 60) + "…" : t;
	};

	// ── 편집 ── 글자를 두 번 눌러 고친다 · 끌어 옮긴다 · 방향키로 1px(Shift 10px) · Delete 로 지운다
	let mode = "view", sel = null, drag = null;
	const style = document.createElement("style");
	style.textContent = `
		[data-deck-edit] .slide *:hover { outline: 1px dashed rgba(229,72,45,.55); outline-offset: 1px; cursor: default }
		[data-deck-edit] [data-deck-sel] { outline: 1.5px solid #e5482d !important; outline-offset: 1px }
		[data-deck-edit] [contenteditable=true] { outline: 1.5px solid #e5482d !important; cursor: text }`;
	document.head.appendChild(style);
	const select = (el) => {
		if (sel) sel.removeAttribute("data-deck-sel");
		sel = el;
		if (sel) sel.setAttribute("data-deck-sel", "");
	};
	const movable = (el) => el && el !== root && ["absolute", "fixed"].includes(css(el).position);

	addEventListener("pointerdown", (e) => {
		if (mode !== "edit") return;
		const el = e.target.closest("[contenteditable=true]") ? null : e.target;
		if (!el || el === root || el === document.body) return select(null);
		select(el);
		if (movable(el)) {
			drag = { el, x: e.clientX, y: e.clientY, l: parseFloat(css(el).left) || el.offsetLeft, t: parseFloat(css(el).top) || el.offsetTop, moved: false };
			e.preventDefault();
		}
	}, true);
	addEventListener("pointermove", (e) => {
		if (!drag) return;
		const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
		if (!drag.moved && Math.hypot(dx, dy) < 3) return;
		drag.moved = true;
		drag.el.style.left = Math.round(drag.l + dx) + "px";
		drag.el.style.top = Math.round(drag.t + dy) + "px";
	});
	addEventListener("pointerup", () => {
		if (drag?.moved) post({ t: "patch", path: pathOf(drag.el), style: { left: drag.el.style.left, top: drag.el.style.top } });
		drag = null;
	});
	addEventListener("dblclick", (e) => {
		if (mode !== "edit") return;
		const el = e.target;
		if (!el || el === root || !(el.innerText || "").trim()) return;
		el.contentEditable = "true";
		el.focus();
		const before = el.innerHTML;
		el.addEventListener("blur", () => {
			el.removeAttribute("contenteditable");
			if (el.innerHTML !== before) post({ t: "edit", path: pathOf(el), html: el.innerHTML });
		}, { once: true });
	});
	addEventListener("keydown", (e) => {
		if (mode !== "edit") return;
		const editing = document.activeElement?.isContentEditable;
		if (editing) { if (e.key === "Escape") document.activeElement.blur(); return; }
		if (!sel) return;
		if (e.key === "Delete" || e.key === "Backspace") {
			post({ t: "remove", path: pathOf(sel) });
			select(null);
		} else if (e.key.startsWith("Arrow") && movable(sel)) {
			const d = e.shiftKey ? 10 : 1, s = css(sel);
			const l = parseFloat(s.left) || 0, t = parseFloat(s.top) || 0;
			if (e.key === "ArrowLeft") sel.style.left = l - d + "px";
			if (e.key === "ArrowRight") sel.style.left = l + d + "px";
			if (e.key === "ArrowUp") sel.style.top = t - d + "px";
			if (e.key === "ArrowDown") sel.style.top = t + d + "px";
			clearTimeout(sel.__nudge);
			const el = sel;
			sel.__nudge = setTimeout(() => post({ t: "patch", path: pathOf(el), style: { left: el.style.left, top: el.style.top } }), 400);
			e.preventDefault();
		} else if (e.key === "Escape") select(null);
	});

	addEventListener("message", async (e) => {
		const m = e.data;
		if (!m || !m.__deck) return;
		if (m.t === "css") {
			document.querySelectorAll("link[rel=stylesheet]").forEach((l) => { l.href = l.href.split("?")[0] + "?t=" + Date.now(); });
		} else if (m.t === "mode") {
			mode = m.mode;
			document.documentElement.toggleAttribute("data-deck-edit", mode === "edit");
			if (mode !== "edit") select(null);
		} else if (m.t === "hit") {
			const el = document.elementFromPoint(m.x, m.y) || root;
			post({ t: "hit", req: m.req, path: pathOf(el), tag: el.tagName.toLowerCase(), text: el === root ? "" : label(el), cls: el.className && typeof el.className === "string" ? el.className : "" });
		} else if (m.t === "extract") {
			try { post({ t: "extracted", req: m.req, data: await extract() }); }
			catch (err) { post({ t: "extracted", req: m.req, error: String(err) }); }
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
	const opacityOf = (el) => { let o = 1; for (let e = el; e && e !== document.documentElement; e = e.parentElement) o *= +css(e).opacity || 1; return o; };
	const fontOf = (s) => (s.fontFamily.split(",")[0] || "").replace(/["']/g, "").trim();
	const isTextBlock = (el) => {
		let text = false;
		for (const n of el.childNodes) {
			if (n.nodeType === 3) { if (n.nodeValue.trim()) text = true; }
			else if (n.nodeType === 1) { if (!INLINE.has(n.tagName) || css(n).display.includes("block") || css(n).display === "flex") return false; }
		}
		return text || (el.innerText || "").trim() !== "";
	};
	// 숨은 iframe 에서는 글꼴 · 그림 준비가 끝없이 미뤄질 때가 있다 — 기다림마다 한도를 둔다
	const within = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
	const hasInlineOnly = (el) => [...el.children].every((c) => INLINE.has(c.tagName) && !css(c).display.includes("block"));

	async function raster(el, R) {
		const scale = 2;
		const c = document.createElement("canvas");
		c.width = Math.max(1, Math.round(R.w * scale)); c.height = Math.max(1, Math.round(R.h * scale));
		const g = c.getContext("2d");
		if (el.tagName === "IMG") {
			await within(el.decode?.(), 4000);
			const iw = el.naturalWidth || R.w, ih = el.naturalHeight || R.h, fit = css(el).objectFit;
			let dw = c.width, dh = c.height, dx = 0, dy = 0;
			if (fit === "contain" || fit === "cover") {
				const k = (fit === "contain" ? Math.min : Math.max)(c.width / iw, c.height / ih);
				dw = iw * k; dh = ih * k; dx = (c.width - dw) / 2; dy = (c.height - dh) / 2;
			}
			g.drawImage(el, dx, dy, dw, dh);
		} else {
			// 인라인 SVG — 계산된 색을 박아 독립 SVG 로 만든 뒤 그림으로 그린다 (currentColor · CSS 변수를 풀려고)
			const clone = el.cloneNode(true);
			const src = [el, ...el.querySelectorAll("*")], dst = [clone, ...clone.querySelectorAll("*")];
			src.forEach((s, i) => {
				const st = css(s);
				for (const k of ["fill", "stroke", "stroke-width", "opacity", "font-family", "font-size", "font-weight", "color", "stop-color"]) {
					const v = st.getPropertyValue(k); if (v) dst[i].style.setProperty(k, v);
				}
			});
			clone.setAttribute("width", R.w); clone.setAttribute("height", R.h);
			clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
			const img = new Image();
			img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(clone));
			await within(img.decode(), 4000);
			g.drawImage(img, 0, 0, c.width, c.height);
		}
		return c.toDataURL("image/png");
	}

	// 글자 조각. 브라우저가 실제로 줄을 바꾼 자리에서 조각을 나누고 soft 를 단다 — PPT 에서 같은 자리에 줄 바꿈(<a:br>)을 넣어
	// 한국어 낱말 끊기(keep-all)와 줄 수가 웹과 같게 된다. PowerPoint 는 한국어를 글자 단위로 끊는다.
	function runsOf(el) {
		const runs = [];
		const line = { top: null };
		const range = document.createRange();
		const topAt = (n, i) => { range.setStart(n, i); range.setEnd(n, i + 1); const r = range.getClientRects()[0]; return r ? Math.round(r.top) : null; };
		const walk = (node) => {
			for (const n of node.childNodes) {
				if (n.nodeType === 3) {
					const raw = n.nodeValue;
					if (!raw.trim() && !runs.length) continue;
					const s = css(n.parentElement), c = color(s.color);
					const style = {
						size: parseFloat(s.fontSize), bold: +s.fontWeight >= 600, italic: s.fontStyle === "italic",
						underline: s.textDecorationLine.includes("underline"), strike: s.textDecorationLine.includes("line-through"),
						color: c ? c.hex : "000000", alpha: c ? c.alpha : 1, font: fontOf(s),
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
		const bg = color(css(root).backgroundColor) || color(css(document.body).backgroundColor);
		const visit = async (el) => {
			for (const ch of el.children) {
				if (!(ch instanceof Element) || ch.tagName === "SCRIPT" || ch.tagName === "STYLE" || !visible(ch)) continue;
				const s = css(ch), r = R(ch.getBoundingClientRect()), op = opacityOf(ch);
				if (r.w < 0.5 || r.h < 0.5) continue;
				if (ch.tagName === "IMG" || ch.tagName.toLowerCase() === "svg" || ch.tagName === "CANVAS") {
					try { items.push({ type: "image", ...r, data: ch.tagName === "CANVAS" ? ch.toDataURL() : await raster(ch, r), alt: ch.getAttribute("alt") || "" }); } catch {}
					continue;
				}
				// 상자
				const fill = color(s.backgroundColor);
				const bw = parseFloat(s.borderTopWidth) || 0, bc = color(s.borderTopColor);
				const sides = ["Top", "Right", "Bottom", "Left"].map((k) => (parseFloat(s["border" + k + "Width"]) || 0) > 0 && s["border" + k + "Style"] !== "none");
				const full = sides.every(Boolean);
				let bgImg = null;
				const m = /url\(["']?(.*?)["']?\)/.exec(s.backgroundImage);
				if (m) bgImg = m[1];
				const grad = !m && s.backgroundImage.includes("gradient") ? color((/rgba?\([^)]*\)/.exec(s.backgroundImage) || [])[0]) : null;
				const f = fill || grad;
				if (f || (full && bc && bw)) {
					items.push({ type: "box", ...r, fill: f ? { ...f, alpha: f.alpha * op } : null, line: full && bc && bw ? { ...bc, w: bw, dash: s.borderTopStyle } : null, radius: parseFloat(s.borderTopLeftRadius) || 0, round: s.borderTopLeftRadius.includes("%") && parseFloat(s.borderTopLeftRadius) >= 50 });
				}
				// 한 변만 그은 선 (구분선 · 밑줄 강조)
				if (!full) {
					["Top", "Right", "Bottom", "Left"].forEach((k, i) => {
						if (!sides[i]) return;
						const w = parseFloat(s["border" + k + "Width"]), c = color(s["border" + k + "Color"]);
						if (!c) return;
						const L = { Top: [r.x, r.y + w / 2, r.x + r.w, r.y + w / 2], Bottom: [r.x, r.y + r.h - w / 2, r.x + r.w, r.y + r.h - w / 2], Left: [r.x + w / 2, r.y, r.x + w / 2, r.y + r.h], Right: [r.x + r.w - w / 2, r.y, r.x + r.w - w / 2, r.y + r.h] }[k];
						items.push({ type: "line", x1: L[0], y1: L[1], x2: L[2], y2: L[3], color: c.hex, w, dash: s["border" + k + "Style"] });
					});
				}
				if (bgImg) {
					try {
						const img = new Image(); img.src = bgImg; await within(img.decode(), 4000);
						const c = document.createElement("canvas"); c.width = r.w * 2; c.height = r.h * 2;
						const g = c.getContext("2d"), k = Math.max(c.width / img.naturalWidth, c.height / img.naturalHeight);
						g.drawImage(img, (c.width - img.naturalWidth * k) / 2, (c.height - img.naturalHeight * k) / 2, img.naturalWidth * k, img.naturalHeight * k);
						items.push({ type: "image", ...r, data: c.toDataURL("image/png") });
					} catch {}
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
					const colW = [...(ch.rows[0]?.cells || [])].map((td) => td.getBoundingClientRect().width);
					const rowH = [...ch.rows].map((tr) => tr.getBoundingClientRect().height);
					items.push({ type: "table", ...r, rows, colW, rowH });
					continue;
				}
				// 글자
				if (isTextBlock(ch) && hasInlineOnly(ch)) {
					const pl = parseFloat(s.paddingLeft) + (parseFloat(s.borderLeftWidth) || 0), pr = parseFloat(s.paddingRight) + (parseFloat(s.borderRightWidth) || 0);
					const pt = parseFloat(s.paddingTop) + (parseFloat(s.borderTopWidth) || 0), pb = parseFloat(s.paddingBottom) + (parseFloat(s.borderBottomWidth) || 0);
					const runs = runsOf(ch);
					if (runs.length) {
						const flex = s.display.includes("flex") || s.display.includes("grid");
						const valign = flex ? ({ center: "middle", "flex-end": "bottom", end: "bottom" }[s.alignItems] || "top") : s.verticalAlign === "middle" ? "middle" : "top";
						let align = s.textAlign;
						if (flex && (s.justifyContent === "center")) align = "center";
						if (flex && ["flex-end", "end", "right"].includes(s.justifyContent)) align = "right";
						const lh = parseFloat(s.lineHeight);
						const bullet = ch.tagName === "LI" && s.listStyleType !== "none";
						items.push({ type: "text", x: r.x + pl, y: r.y + pt, w: r.w - pl - pr, h: r.h - pt - pb, runs, align: align === "start" ? "left" : align === "end" ? "right" : align, valign, lineHeight: isNaN(lh) ? null : lh, bullet, alpha: op });
					}
					continue;
				}
				// 블록 자식과 섞인 맨 글자 — 글자 조각마다 따로
				for (const n of ch.childNodes) {
					if (n.nodeType !== 3 || !n.nodeValue.trim()) continue;
					const range = document.createRange(); range.selectNodeContents(n);
					const rr = R(range.getBoundingClientRect()), c = color(s.color);
					items.push({ type: "text", ...rr, runs: [{ text: n.nodeValue.trim(), size: parseFloat(s.fontSize), bold: +s.fontWeight >= 600, italic: s.fontStyle === "italic", color: c ? c.hex : "000000", font: fontOf(s) }], align: "left", valign: "top" });
				}
				await visit(ch);
			}
		};
		await visit(root);
		return { w: S.width, h: S.height, background: bg, items };
	}

	post({ t: "ready", w: root.getBoundingClientRect().width, h: root.getBoundingClientRect().height });
})();
