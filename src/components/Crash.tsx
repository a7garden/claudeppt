// 화면 그리기 중 잡히지 않은 오류를 받는 자리.
// React 19 는 렌더 오류가 경계에 걸리지 않으면 루트 전체를 걷어 낸다 — 창에 바탕색만 남아 「화면이 날아간」 것처럼 보인다.
// 여기서 받아 오류 글을 보이고, 다시 그리기 · 처음 화면으로 돌아갈 길을 둔다. 덱 파일은 디스크에 있어 잃지 않는다.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { tNow } from "../lib/i18n";
import { useDeck } from "../lib/store";

const KEY = "last-crash";

interface State { error: Error | null; stack: string }

export default class Crash extends Component<{ children: ReactNode }, State> {
	state: State = { error: null, stack: "" };

	static getDerivedStateFromError(error: Error): Partial<State> { return { error }; }

	componentDidCatch(error: Error, info: ErrorInfo) {
		const stack = info.componentStack || "";
		this.setState({ stack });
		console.error("화면 오류", error, stack);
		// 다음에 원인을 찾을 수 있게 마지막 한 건을 남긴다 — 저장이 막혀도 화면은 그린다
		try { localStorage.setItem(KEY, JSON.stringify({ at: new Date().toISOString(), message: String(error?.stack || error), component: stack })); } catch {}
	}

	retry = () => this.setState({ error: null, stack: "" });

	home = async () => {
		await useDeck.getState().closeProject().catch(() => {});
		this.retry();
	};

	render() {
		const { error, stack } = this.state;
		if (!error) return this.props.children;
		return (
			<div className="crash" role="alert">
				<h2>{tNow("crashTitle")}</h2>
				<p>{tNow("crashBody")}</p>
				<pre>{String(error.stack || error)}{stack}</pre>
				<div className="crash-act">
					<button className="send" onClick={this.retry}>{tNow("crashRetry")}</button>
					<button className="ghost" onClick={this.home}>{tNow("crashHome")}</button>
				</div>
			</div>
		);
	}
}
