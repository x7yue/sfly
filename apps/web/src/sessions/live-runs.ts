import type { RunStatus } from "@sfly/schema";

/**
 * 会话页上同时开着运行事件流的运行数的上限。浏览器对同一来源的 HTTP/1.1 连接只给 6 条：会话页自己已经占一条（会话的事件流），
 * 一个会话可以有很多运行，在跑的每个都开一条的话，五个就把连接占满，页面自己的请求（发送、停止、结束会话）排不上队。
 * 这 6 条是整个浏览器共用、不分标签页的：人常常同时开着一个运行监控标签页（它自己也占一条）。所以会话页只给 2 个运行开流：
 * 会话的事件流 1 条、运行的 2 条、运行监控标签页的 1 条，共 4 条，还给两个页面的请求留 2 条（定 3 的话只剩 1 条）。
 * 这个名额只管会话页上的运行卡片：运行监控页、运行抽屉、画布自己用 `useLiveRun`，不看它。
 */
export const MAX_LIVE_RUN_STREAMS = 2;

/** 一个运行此刻读到了什么：状态；还在读第一次（`loading`）；读不到（`unreadable`：GET 出错，例如运行已经被清理）。 */
export type RunProbe = RunStatus | "loading" | "unreadable";

/**
 * 这一刻哪几个运行开事件流：**第一次读到「在跑」才给名额**，从最近的（事件序号大的）往下数 `limit` 个。
 * 还在读第一次的、一直读不到的都不占名额、不开流，先靠定时重新读（`runStatusQuery`）；读到「在跑」之后再换成订阅。
 * 否则打开一个运行都已结束的会话时，最近的几个会先开流、读到「已结束」才关，名额一批批往下挪，一条没必要的运行事件流都不该有。
 *
 * **更近的运行还在读第一次时，更早的运行也等着**（遇到 `loading` 就停）：第一次读的回应先后不一，更早的先读到「在跑」就占了名额、
 * 更近的随后读到又把它挤掉，开了又关一条没必要的流。等更近的都有了结果（在跑、已结束、读不到都算）再定，每个运行最多开一次。
 * 读不到的（`unreadable`）算有了结果，不挡后面的。
 *
 * 结束了的运行不占名额，名额留给更早的、还在跑的；没有名额的运行不开流，卡片上的状态靠定时重新读，慢一点但不会漏。
 * 时间线上的卡片和成果栏里的卡片用同一个结果，所以同一个运行在页面上最多一条事件流（`useLiveRun` 按运行共用连接）。
 */
export function liveRunIds(
	runs: readonly { seq: number; runId: string }[],
	probeOf: (runId: string) => RunProbe,
	limit: number = MAX_LIVE_RUN_STREAMS,
): ReadonlySet<string> {
	const picked = new Set<string>();
	const seen = new Set<string>();
	for (const { runId } of [...runs].sort((a, b) => b.seq - a.seq)) {
		if (picked.size >= limit) break;
		if (seen.has(runId)) continue;
		seen.add(runId);
		const probe = probeOf(runId);
		if (probe === "loading") break;
		if (probe === "running") picked.add(runId);
	}
	return picked;
}
