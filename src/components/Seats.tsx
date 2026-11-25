// 담당 — 제목 줄의 담당 점과, 누르면 펴지는 담당 창. 덱을 나눠 고치는 Claude Code 세션들을 보고 관리한다 (seats.ts · CLI seats.rs).
//
//   SeatDots   담당마다 색 점에 번호. 일하는 중이면 고리가 숨쉬고, 맡은 세션이 없으면 속이 빈다. 담당이 없으면 사람 아이콘 하나
//   SeatPanel  담당마다 이름(그 자리에서 고친다) · 상태 · 지금 하는 일 · 맡은 범위 · 맡기는 말 복사 · 비우기.
//              「범위 고치기」를 펴면 쪽 번호와 권한(테마 · 쪽 구성 · 덱 관리)을 누른다. 아래에 맡은 담당이 없는 변경 · 최근 기록
//   seatColor  판 목록 · 쪽 목록이 담당 번호로 색을 찾는다
import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { busy, joinLine, newSeat, PALETTE, type Seat, taken } from "../lib/seats";
import { useDeck } from "../lib/store";

export const seatColor = (seats: Seat[], no: number) => seats.find((x) => x.no === no)?.color || PALETTE[(no - 1) % PALETTE.length];

/** 몇 초마다 다시 그린다 — 「3분 전」 · 일하는 중이 시간이 지나면 풀린다 */
export function useTick(ms: number, on = true) {
	const [, set] = useState(0);
	useEffect(() => {
		if (!on) return;
		const k = setInterval(() => set((x) => x + 1), ms);
		return () => clearInterval(k);
	}, [ms, on]);
}

export function SeatDots() {
	const t = useT();
	const seats = useDeck((s) => s.seats);
	const presence = useDeck((s) => s.presence);
	const strays = useDeck((s) => s.strays);
	const [open, setOpen] = useState(false);
	useTick(15000, seats.length > 0);
	return (
		<span className="seatwrap">
			<button className={"tb-btn seat-dots" + (open ? " on" : "")} onClick={() => setOpen(!open)} title={t("seats")} aria-label={t("seats")} aria-expanded={open}>
				{seats.length ? (
					seats.map((x) => (
						<i key={x.no} className={"sd" + (busy(presence[x.no]) ? " working" : "") + (taken(presence[x.no]) ? "" : " free")} style={{ "--c": x.color } as React.CSSProperties}>{x.no}</i>
					))
				) : (
					<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden><circle cx="6" cy="5.5" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M1.8 13c.6-2.3 2.2-3.5 4.2-3.5s3.6 1.2 4.2 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><path d="M10.5 3.6a2.2 2.2 0 0 1 0 4M12 9.8c1.1.5 1.9 1.6 2.2 3.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
				)}
				{/* 옆 단추(내보내기 · 릴리즈)처럼 글자로도 — 색 점만으로는 무엇인지 모른다 */}
				<span>{t("seats")}</span>
				{strays.length > 0 && <b className="sd-stray" aria-label={t("seatStrays")} />}
			</button>
			{open && <SeatPanel onClose={() => setOpen(false)} />}
		</span>
	);
}

const ago = (t: ReturnType<typeof useT>, at: number) => {
	const m = Math.floor((Date.now() - at) / 60000);
	return m < 1 ? t("seatNow") : t("seatAgo").replace("{m}", String(m));
};
const clock = (at: number) => new Date(at).toTimeString().slice(0, 5);

function SeatPanel({ onClose }: { onClose: () => void }) {
	const t = useT();
	const seats = useDeck((s) => s.seats);
	const activity = useDeck((s) => s.activity);
	const strays = useDeck((s) => s.strays);
	const running = useDeck((s) => s.running);
	const save = useDeck((s) => s.saveSeats);
	const [editing, setEditing] = useState<number | null>(null);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const k = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.(".seat-dots")) onClose(); };
		const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
		addEventListener("mousedown", k);
		addEventListener("keydown", esc);
		return () => { removeEventListener("mousedown", k); removeEventListener("keydown", esc); };
	}, [onClose]);
	const add = () => {
		const s = newSeat(seats);
		save([...seats, s]);
		setEditing(s.no);
	};
	const recent = activity.slice(-8).reverse();
	return (
		<div className="pop seats" ref={ref} role="dialog" aria-label={t("seats")}>
			<div className="seats-head">
				<b>{t("seats")}</b>
				<button className="ghost" onClick={add}>+ {t("seatAdd")}</button>
			</div>
			{running && <div className="seat-app"><i className="sp-run" aria-hidden />{t("seatApp")} · {t("seatBusy")}</div>}
			{!seats.length && <p className="seats-empty">{t("seatEmpty")}</p>}
			{seats.map((x) => (
				<SeatRow key={x.no} seat={x} editing={editing === x.no} onEdit={(on) => setEditing(on ? x.no : null)} />
			))}
			{strays.length > 0 && (
				<section className="seat-strays">
					<div className="seat-sub"><span title={t("seatStrayHint")}>{t("seatStrays")}</span><button onClick={() => useDeck.getState().clearStrays()}>{t("seatDone")}</button></div>
					{strays.slice(0, 5).map((x) => (
						<div key={x.path + x.at} className="seat-stray" title={`${t("seatStrayWho")}: ${x.seats.map((n) => t("seatNo").replace("{n}", String(n))).join(" · ")}`}>
							<span className="mono">{x.path}</span>
							<span className="who">{x.seats.map((n) => <i key={n} className="sd" style={{ "--c": seatColor(seats, n) } as React.CSSProperties}>{n}</i>)}</span>
							<span className="d">{clock(x.at)}</span>
						</div>
					))}
				</section>
			)}
			{recent.length > 0 && (
				<section className="seat-log">
					<div className="seat-sub"><span>{t("seatLog")}</span></div>
					{recent.map((a, i) => (
						<div key={a.at + ":" + i} className="seat-act">
							<span className="d">{clock(a.at)}</span>
							<i className="sd" style={{ "--c": seatColor(seats, a.seat) } as React.CSSProperties}>{a.seat}</i>
							<span className="s">{a.text}</span>
						</div>
					))}
				</section>
			)}
		</div>
	);
}

function SeatRow({ seat, editing, onEdit }: { seat: Seat; editing: boolean; onEdit: (on: boolean) => void }) {
	const t = useT();
	const deck = useDeck((s) => s.deck)!;
	const dir = useDeck((s) => s.dir);
	const seats = useDeck((s) => s.seats);
	const p = useDeck((s) => s.presence[seat.no]);
	const save = useDeck((s) => s.saveSeats);
	const patch = (q: Partial<Seat>) => save(seats.map((x) => (x.no === seat.no ? { ...x, ...q } : x)));
	const held = taken(p);
	const working = busy(p);
	const order = (id: string) => deck.slides.findIndex((x) => x.id === id) + 1;
	// 맡은 쪽 — 지금 목차 번호로. 목차에서 빠진 쪽은 세지 않는다
	const nums = seat.slides === "all" ? null : seat.slides.map(order).filter((n) => n > 0).sort((a, b) => a - b);
	const scope = [
		nums == null ? t("seatAllSlides") : nums.length ? t("seatSlidesN").replace("{n}", nums.join(" · ")) : t("seatNoSlides"),
		seat.theme && t("seatTheme"),
		seat.order && t("seatOrder"),
		seat.manage && t("seatManage"),
	].filter(Boolean).join(" · ");
	const toggleSlide = (id: string) => {
		const cur = seat.slides === "all" ? deck.slides.map((x) => x.id) : seat.slides;
		patch({ slides: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
	};
	const copy = () => {
		navigator.clipboard.writeText(joinLine(t("seatJoinLine"), seat, dir)).then(
			() => useDeck.getState().notify(t("seatCopied"), "ok"),
			(e) => useDeck.getState().notify(String(e), "err"),
		);
	};
	// 다른 담당이 맡은 쪽 — 쪽 번호 아래 그 담당 색 줄. 겹쳐 맡기는 것을 막지는 않는다 (한 쪽을 둘이 보며 고치는 일도 있다)
	const other = (id: string) => seats.find((x) => x.no !== seat.no && Array.isArray(x.slides) && x.slides.includes(id));
	return (
		<div className={"seat" + (working ? " working" : "") + (held ? "" : " free")} style={{ "--c": seat.color } as React.CSSProperties}>
			<div className="seat-top">
				<i className="sd big">{seat.no}</i>
				<input className="seat-name" defaultValue={seat.name} key={seat.name} placeholder={t("seatNamePh")} aria-label={`${t("seatNo").replace("{n}", String(seat.no))} · ${t("seatName")}`}
					onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { (e.target as HTMLInputElement).value = seat.name; (e.target as HTMLInputElement).blur(); } }}
					onBlur={(e) => { const v = e.target.value.trim(); if (v !== seat.name) patch({ name: v }); }} />
				<span className="seat-state">{working ? t("seatBusy") : held ? `${t("seatHeld")} · ${ago(t, p!.seen)}` : t("seatFree")}</span>
			</div>
			{p?.doing && held && (
				<div className="seat-doing">
					{p.doing.text}
					{p.doing.slides.length > 0 && <span className="mono"> · {t("seatSlidesN").replace("{n}", p.doing.slides.map(order).filter((n) => n > 0).join(" · "))}</span>}
				</div>
			)}
			<div className="seat-scope"><span>{scope}</span></div>
			{editing && (
				<div className="seat-edit">
					<div className="seat-slides" role="group" aria-label={t("seatScope")}>
						<button className="all" aria-pressed={seat.slides === "all"} onClick={() => patch({ slides: seat.slides === "all" ? [] : "all" })}>{t("seatAllSlides")}</button>
						{deck.slides.map((x, i) => {
							const o = other(x.id);
							return (
								<button key={x.id} aria-pressed={seat.slides === "all" || seat.slides.includes(x.id)} onClick={() => toggleSlide(x.id)}
									title={[x.title || `${i + 1}`, o ? `${t("seatOwner")}: ${t("seatNo").replace("{n}", String(o.no))}${o.name ? " · " + o.name : ""}` : ""].filter(Boolean).join(" · ")}
									style={o ? ({ "--o": o.color } as React.CSSProperties) : undefined} className={o ? "taken" : ""}>
									{i + 1}
								</button>
							);
						})}
					</div>
					<div className="seat-perms">
						<button aria-pressed={seat.theme} onClick={() => patch({ theme: !seat.theme })} title={t("seatThemeHint")}>{t("seatTheme")}</button>
						<button aria-pressed={seat.order} onClick={() => patch({ order: !seat.order })} title={t("seatOrderHint")}>{t("seatOrder")}</button>
						<button aria-pressed={seat.manage} onClick={() => patch({ manage: !seat.manage })} title={t("seatManageHint")}>{t("seatManage")}</button>
					</div>
				</div>
			)}
			<div className="seat-acts">
				<button onClick={copy}>{t("seatCopy")}</button>
				<button onClick={() => onEdit(!editing)} aria-expanded={editing}>{editing ? t("seatDone") : t("seatEdit")}</button>
				{held && <button onClick={() => useDeck.getState().vacate(seat.no)} title={t("seatVacateHint")}>{t("seatVacate")}</button>}
				{!held && <button className="rm" onClick={() => save(seats.filter((x) => x.no !== seat.no))}>{t("seatRemove")}</button>}
			</div>
		</div>
	);
}
