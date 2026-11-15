import type { AgentView, RunFocus } from "@sfly/schema";
import { useQueries } from "@tanstack/react-query";
import { runFocusQuery } from "#/focus/use-run-focus";
import { STATUS_POLL_MS } from "#/lib/polling";

/** 一个运行的关注项读数；`failed`：读取失败、也没有读到过数据（读到过再失败时保留旧的）。 */
export interface RunFocusRead {
	data: RunFocus | undefined;
	failed: boolean;
}

/** 按运行编号取读数。 */
export type FocusByRun = ReadonlyMap<string, RunFocusRead>;

/**
 * 页面上占着槽位的任务所属的运行的关注项读数（`points=0`，只要最新值、异常和排序）：一个运行只读一次，
 * 再分给它的各个槽位。放在页面上而不是每个槽位里读：同一个运行的槽位多了、后来又有新的，轮询也只有一个计时。
 * 和 Agent 列表一起每 `STATUS_POLL_MS` 重新读一次（Agent 管理页的刷新节奏）；query key 与 `useRunFocus` 相同，
 * 缓存里的读数与别的页面共用。
 */
export function useSlotFocus(agents: readonly AgentView[]): FocusByRun {
	const runIds = [...new Set(agents.flatMap((a) => a.running_tasks.map((t) => t.run_id)))];
	const results = useQueries({
		queries: runIds.map((id) => runFocusQuery(id, { points: 0, refetchInterval: STATUS_POLL_MS })),
	});
	return new Map(
		runIds.map((id, i) => {
			const result = results[i];
			return [id, { data: result?.data, failed: result?.data === undefined && !!result?.isError }];
		}),
	);
}
