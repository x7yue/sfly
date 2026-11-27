import type { AgentCredentialView } from "@sfly/schema";

/**
 * 凭据弹窗走到哪一步（每台 Agent 的「凭据」、页头「为新 Agent 签发凭据」共用）。**凭据的原值只在 `issued` 这一步的状态里**：
 *
 * - `name`：给还没连过的名字签发时，先填名称（提交就是签发，成功后直接进入 `issued`）；
 * - `list`：这个名字的凭据列表（有效的、已吊销的；不含原值）和「签发新凭据」；
 * - `issued`：刚签发，原值（`token`）在这里，弹窗显示它一次；
 * - `revoke`：吊销确认（列表里点了某一个的「吊销」）。
 *
 * 原值的去向（API 响应 → 页面状态 → 剪贴板和安装命令）和各自什么时候清掉，见 PR 说明和 {@link flowReducer}：
 * 离开 `issued`（点「我已保存，完成」）、弹窗关掉（`closed`）都回到不带原值的状态。
 */
export type Flow =
	| { view: "name" }
	| { view: "list"; name: string }
	| { view: "issued"; name: string; credential: AgentCredentialView; token: string }
	| { view: "revoke"; name: string; credential: AgentCredentialView };

export type FlowAction =
	/** 签发成功：收到原值（给新名字签发时，名称就是填的那个，也从这里进入这个名字）。 */
	| { type: "issued"; name: string; credential: AgentCredentialView; token: string }
	/** 给新名字签发时没有收到响应（控制面可能已经签发了一枚、浏览器没拿到原值）：进这个名字的列表，那一枚在列表里。 */
	| { type: "unseen"; name: string }
	/** 点「我已保存，完成」：回到列表，原值清掉。 */
	| { type: "done" }
	/** 列表里点某个凭据的「吊销」。 */
	| { type: "askRevoke"; credential: AgentCredentialView }
	/** 吊销确认里点「取消」或吊销成功：回到列表。 */
	| { type: "backToList" }
	/** 弹窗关掉（过渡动画结束之后）：重新开始；原值清掉。 */
	| { type: "closed" };

/** 打开弹窗时的第一步：知道名字就是列表，不知道（给新名字签发）先填名称。 */
export const startFlow = (name: string | null): Flow =>
	name === null ? { view: "name" } : { view: "list", name };

export function flowReducer(flow: Flow, action: FlowAction, start: string | null): Flow {
	switch (action.type) {
		case "issued":
			return {
				view: "issued",
				name: action.name,
				credential: action.credential,
				token: action.token,
			};
		case "unseen":
			// 只在填名称和列表里发起签发：显示原值、吊销确认的时候没有签发请求在路上。
			return flow.view === "name" || flow.view === "list"
				? { view: "list", name: action.name }
				: flow;
		case "done":
			return "name" in flow ? { view: "list", name: flow.name } : startFlow(start);
		case "askRevoke":
			// 只从列表进：显示原值的时候收到这个动作也不动，原值不会被一次误操作带走。
			return flow.view === "list"
				? { view: "revoke", name: flow.name, credential: action.credential }
				: flow;
		case "backToList":
			return flow.view === "revoke" ? { view: "list", name: flow.name } : flow;
		case "closed":
			// 弹窗关掉：下次打开从头开始；新名字的流程回到填名称，原值（只在 issued 里）随旧状态一起丢掉。
			return startFlow(start);
	}
}
