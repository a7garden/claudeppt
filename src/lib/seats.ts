// 담당 — 덱 하나를 여러 Claude Code 세션이 나눠 고칠 때 세션 하나가 맡는 몫. src-tauri/src/seats.rs(CLI)와 같은 파일을 읽고 쓴다.
//
//   정의   .claudeppt/seats.json      번호 · 이름 · 색 · 맡은 쪽 · 권한 — 「담당」 창에서 사용자가 정한다 (CLI 는 join --name · 쪽 더하기 때만 쓴다)
//   맡음   .claudeppt/presence.json   담당 → 맡은 세션 · 마지막 명령 때 · 지금 하는 일 — CLI 가 쓴다. 앱은 「비우기」만
//   기록   .claudeppt/activity.jsonl  담당마다 한 일 — CLI 가 쓴다
//
// 판에 넣지 않는 앱 상태다 — 같은 PC 에서 도는 세션끼리 나눈다 (Remote Control 로 밖에서 붙은 세션도 이 PC 에서 돈다).
import { api } from "./api";
import type { Deck } from "./deck";

export interface Seat {
	no: number;
	name: string;
	color: string;
	/** 맡은 쪽 id — 「all」이면 모든 쪽. 번호가 아니라 id 라 쪽 순서가 바뀌어도 같은 쪽이다 */
	slides: "all" | string[];
	/** theme.css 를 고친다 */
	theme: boolean;
	/** 쪽 더하기 · 빼기 · 옮기기 (deck.json) */
	order: boolean;
	/** 판 되돌리기 · 릴리즈 */
	manage: boolean;
}
export interface Presence { session: string; since: number; seen: number; doing?: { text: string; slides: string[]; at: number } }
export interface Activity { at: number; seat: number; cmd: string; text: string }

/** 주홍(--accent)은 핀의 색이라 쓰지 않는다. seats.rs PALETTE 와 같은 차례 */
export const PALETTE = ["#4f8cff", "#3fb68b", "#b58cff", "#e0a83a", "#35b8c8", "#ff7eb6"];
/** 마지막 명령 뒤 이만큼 지나면 비어 있다고 본다 (seats.rs STALE_MS) */
export const STALE_MS = 30 * 60 * 1000;
/** 이 안에 명령을 불렀거나 하는 일을 알렸으면 「일하는 중」. 2026.11.25 : 3분 — 세션은 파일을 고치는 동안 CLI 를 부르지 않는다 */
export const BUSY_MS = 3 * 60 * 1000;
/** 쪽 목록에 「방금 고친 담당」 색을 두는 시간 */
export const TOUCH_MS = 60 * 1000;

const read = async <T,>(dir: string, rel: string, d: T): Promise<T> => {
	try { return JSON.parse(await api.readText(dir, rel)); } catch { return d; }
};

export async function readSeats(dir: string) {
	const seats = (await read<{ seats: Seat[] }>(dir, ".claudeppt/seats.json", { seats: [] })).seats || [];
	const presence = await read<Record<string, Presence>>(dir, ".claudeppt/presence.json", {});
	let activity: Activity[] = [];
	try {
		const lines = (await api.readText(dir, ".claudeppt/activity.jsonl")).split("\n").filter(Boolean).slice(-200);
		activity = lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
	} catch {}
	return { seats, presence, activity };
}

// 쓰기는 seats.rs 의 앱 명령(api.seatsUpdate · seatsVacate)으로만 — 바깥 세션 CLI 와 같은 잠금 · 바꿔 달기를 거친다.
// 2026.11.25 : 여기서 파일을 통째로 쓰던 때는 쓰는 도중 join 이 반쪽 파일을 읽고 담당을 「모든 권한」 1번으로 덮어썼다

/** 맡은 세션이 있는지 — 오래 조용했으면 비어 있다 */
export const taken = (p?: Presence) => !!p && Date.now() - p.seen < STALE_MS;
export const busy = (p?: Presence) => !!p && Date.now() - Math.max(p.seen, p.doing?.at || 0) < BUSY_MS;

/** 새 담당 — 다음 번호 · 번호 차례의 색 · 처음에는 맡은 쪽 없이 (사용자가 범위를 고른다) */
export function newSeat(seats: Seat[]): Seat {
	const no = Math.max(0, ...seats.map((s) => s.no)) + 1;
	return { no, name: "", color: PALETTE[(no - 1) % PALETTE.length], slides: [], theme: false, order: false, manage: false };
}

/** 이 담당이 이 파일을 판에 넣을 수 있는지 — seats.rs allows 와 같은 규칙 */
export function owns(seat: Seat, deck: Deck, rel: string): boolean {
	const m = /^slides\/(.+)\.html$/.exec(rel);
	if (m) {
		if (seat.slides === "all") return true;
		const listed = deck.slides.some((x) => x.id === m[1]);
		return seat.slides.includes(m[1]) || (!listed && seat.order);
	}
	if (rel === "theme.css") return seat.theme;
	if (rel === "deck.json") return seat.order;
	if (rel.startsWith("assets/")) return true;
	return seat.manage;
}

/** 세션에 붙여 넣을 말 — 스킬 「claudeppt」가 이 말로 담당을 맡는다 */
export const joinLine = (tpl: string, seat: Seat, dir: string) =>
	tpl.replace(/\{n\}/g, String(seat.no)).replace(/\{dir\}/g, dir).replace(/\{name\}/g, seat.name || String(seat.no));
