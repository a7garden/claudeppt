// 요청 글의 쪽 멘션 — 「@3」 · 「@3-5」 처럼 쪽 번호로 슬라이드를 가리킨다.
//
// 번호는 보낼 때의 쪽 순서로 푼다. 푼 결과(쪽 id)를 턴에 남겨 두므로, 나중에 쪽 순서가 바뀌어도 지난 대화의 멘션은 같은 쪽을 가리킨다.
// 「a@3」 처럼 글자에 붙은 @ 는 멘션이 아니다 (메일 주소 등).
// 판은 「@v12」 로 가리킨다 — 그 판의 파일을 Claude 가 참고로 읽는다 (versions.ts versionContext). 쪽 멘션과 달리 숫자 앞에 v 가 붙어 섞이지 않는다.
import type { Commit } from "./api";
import type { Deck } from "./deck";

export interface Mention { no: number; id: string; file: string; title?: string }

/** 멘션 한 덩이 — 글 안의 자리와 가리키는 쪽 번호 범위 */
export interface MentionToken { start: number; end: number; from: number; to: number }

const RE = /(^|[^\p{L}\p{N}@])@(\d{1,4})(?:\s*[-~]\s*(\d{1,4}))?/gu;

export function mentionTokens(text: string): MentionToken[] {
	const out: MentionToken[] = [];
	for (const m of text.matchAll(RE)) {
		const start = m.index! + m[1].length;
		const a = +m[2], b = m[3] ? +m[3] : a;
		out.push({ start, end: m.index! + m[0].length, from: Math.min(a, b), to: Math.max(a, b) });
	}
	return out;
}

/** 글이 가리키는 쪽들 — 쪽 순서대로, 겹치지 않게. 덱에 없는 번호는 뺀다 */
export function mentionsIn(text: string, deck: Deck): Mention[] {
	const nos = new Set<number>();
	for (const t of mentionTokens(text)) for (let n = t.from; n <= Math.min(t.to, deck.slides.length); n++) if (n >= 1) nos.add(n);
	return [...nos].sort((a, b) => a - b).map((no) => {
		const s = deck.slides[no - 1];
		return { no, id: s.id, file: s.file, title: s.title };
	});
}

/** @ 뒤에 적는 중인 낱말 — 고르기 창을 띄울지 정한다. 글자에 붙은 @ · 범위(3-) 를 적는 중이면 띄우지 않는다 */
export function typingMention(text: string, caret: number): { start: number; q: string } | null {
	const before = text.slice(0, caret);
	const at = before.lastIndexOf("@");
	if (at < 0) return null;
	const q = before.slice(at + 1);
	if (/[\s@]/.test(q) || /[-~]/.test(q) || q.length > 20) return null;
	if (at > 0 && /[\p{L}\p{N}]/u.test(before[at - 1])) return null;
	return { start: at, q };
}

/** 고르기 창 후보 — 번호를 적으면 그 번호로 시작하는 쪽, 글을 적으면 제목에 그 글이 든 쪽. 비어 있으면 지금 쪽부터 */
export function mentionCandidates(deck: Deck, q: string, current: number, limit = 8): Mention[] {
	const all = deck.slides.map((s, i) => ({ no: i + 1, id: s.id, file: s.file, title: s.title }));
	const k = q.trim().toLowerCase();
	if (!k) return [...all.slice(current), ...all.slice(0, current)].slice(0, limit);
	if (/^\d+$/.test(k)) return all.filter((m) => String(m.no).startsWith(k)).slice(0, limit);
	return all.filter((m) => (m.title || "").toLowerCase().includes(k)).slice(0, limit);
}

// ── 판 멘션 ──

/** 보낼 때 푼 판 — 판 번호는 바뀌지 않지만, 지난 대화에서 그 판을 열 수 있게 커밋을 함께 남긴다 */
export interface VersionMention { n: number; hash: string; subject: string; date: string }
export interface VersionToken { start: number; end: number; n: number }

const VRE = /(^|[^\p{L}\p{N}@])@v(\d{1,5})(?![\p{L}\p{N}])/giu;

export function versionTokens(text: string): VersionToken[] {
	return [...text.matchAll(VRE)].map((m) => ({ start: m.index! + m[1].length, end: m.index! + m[0].length, n: +m[2] }));
}

/** 글이 가리키는 판들 — 번호 순, 겹치지 않게. 없는 판은 뺀다 */
export function versionMentionsIn(text: string, versions: Commit[]): VersionMention[] {
	const ns = [...new Set(versionTokens(text).map((t) => t.n))].sort((a, b) => a - b);
	return ns.map((n) => versions.find((c) => c.n === n)).filter((c): c is Commit => !!c).map((c) => ({ n: c.n, hash: c.hash, subject: c.subject, date: c.date }));
}

/** 「@v」 를 적는 중이면 판 고르기 창 — q 는 v 뒤 숫자. 지금 판(맨 위)은 지금 파일과 같아 빼고, 새 판부터 */
export function versionCandidates(versions: Commit[], q: string, limit = 8): Commit[] {
	const k = q.replace(/^v/i, "");
	const past = versions.slice(1);
	return (k ? past.filter((c) => String(c.n).startsWith(k)) : past).slice(0, limit);
}

/** @ 뒤에 적는 것이 판인가 — 「v」 · 「v1」 · 「V12」 */
export const isVersionQuery = (q: string) => /^v\d*$/i.test(q);
