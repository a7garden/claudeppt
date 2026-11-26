// 템플릿 파일 — 템플릿 한 벌을 PC 사이 · 팀원 사이에 주고받는 꼴과, 파일에서 템플릿을 들이는 길.
//
//   claudeppt-template/1 (.ctpl)   JSON 한 파일. { format, template } — template 은 settings.Template 에서 id 를 뺀 것
//   들이기                          .ctpl · .json 은 그대로 읽고, .pptx · .potx 는 슬라이드 마스터에서 뽑는다 (importPptx.pptxTemplate)
//
// 들인 템플릿은 설정(settings.json)의 템플릿 목록에 더한다. 같은 이름이 있으면 뒤에 번호를 붙인다 — 덮어쓰면 그 템플릿으로 만든 덱의 스타일이 바뀐다.
// 끌어 놓기(DropZone) · 「설정 › 템플릿」의 단추가 같이 쓴다.
import { api } from "./api";
import { tNow } from "./i18n";
import { normalizeTemplate, type Template, templateId, useSettings } from "./settings";

export const TEMPLATE_FORMAT = "claudeppt-template/1";
export const TEMPLATE_EXT = "ctpl";

/** 템플릿으로 들일 수 있는 파일인가 */
export const templateFile = (p: string) => /\.(ctpl|potx|pptx)$/i.test(p);

export function templateJson(t: Template) {
	const { id: _id, ...rest } = t;
	return JSON.stringify({ format: TEMPLATE_FORMAT, template: rest }, null, 2) + "\n";
}

function parseTemplate(text: string): Template {
	let v: any;
	try { v = JSON.parse(text); } catch { throw new Error(tNow("tplBadFile")); }
	const body = v?.format === TEMPLATE_FORMAT ? v.template : v?.template ?? v;
	if (!body || typeof body !== "object" || typeof body.name !== "string") throw new Error(tNow("tplBadFile"));
	return normalizeTemplate(body);
}

/** 이름이 겹치지 않게 — 「회사 양식」이 있으면 「회사 양식 2」 */
function freeName(name: string) {
	const used = new Set(useSettings.getState().s.templates.map((x) => x.name));
	const base = name.trim() || tNow("untitled");
	let n = base, i = 2;
	while (used.has(n)) n = `${base} ${i++}`;
	return n;
}

/** 파일 하나를 템플릿으로 들여 설정에 더한다. 더한 템플릿을 돌려준다 */
export async function addTemplateFromPath(path: string): Promise<Template> {
	const file = path.split(/[\\/]/).pop() || path;
	const name = file.replace(/\.(ctpl|json|potx|pptx)$/i, "");
	let t: Template;
	if (/\.(pptx|potx)$/i.test(path)) {
		const bytes = new Uint8Array(await api.absReadBytes(path));
		const { pptxTemplate } = await import("./importPptx");
		t = await pptxTemplate(bytes, name, useSettings.getState().s.lang);
	} else {
		t = parseTemplate(new TextDecoder().decode(await api.absReadBytes(path)));
		t.from = t.from || file;
	}
	t = { ...t, id: templateId(), name: freeName(t.name || name) };
	useSettings.getState().set((x) => ({ ...x, templates: [...x.templates, t] }));
	return t;
}

export async function saveTemplateFile(t: Template, path: string) {
	await api.absWriteBytes(path, new TextEncoder().encode(templateJson(t)));
}
