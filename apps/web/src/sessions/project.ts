import type { SessionListItem } from "@sfly/schema";

/** 骨架里项目固定是 `default`：项目切换（#499）之前助手页和会话页都在这个项目里。 */
export const SESSION_PROJECT = "default";

/** 正在做的那个会话（同一个项目同一时刻只跑一轮）：新建会话遇到 `project_busy` 时给出它的链接。 */
export const busySession = (sessions: readonly SessionListItem[]): SessionListItem | undefined =>
	sessions.find((session) => session.status === "running");
