import type { ChainRunView } from "./http/runs.js";

/**
 * 运行里最终失败的节点，按失败的先后（GLOSSARY「第一个失败的节点」）：节点状态是失败（最后一次尝试失败）的节点，
 * 最后一次尝试结束得早的在前；同一时刻结束的按链实例的顺序（`chains` 的顺序：层级、开始时间、ID，与运行视图相同），
 * 再按节点在链上的顺序（每条链的 `nodes` 的顺序）。`endedAt` 是节点最后一次尝试的结束时间（毫秒），没有时排在最后。
 *
 * 第一项就是「第一个失败的节点」：控制台的最近结束、运行监控的页头和默认选中的节点、运行记录、运行通知都按这一份顺序，
 * 不各自挑。
 */
export function failuresInOrder<
	C extends { readonly nodes: readonly { readonly status: string }[] },
>(
	chains: readonly C[],
	endedAt: (node: C["nodes"][number]) => number | null,
): Array<{ chain: C; node: C["nodes"][number] }> {
	const failed = chains.flatMap((chain) =>
		chain.nodes.flatMap((node) =>
			node.status === "failed"
				? [{ chain, node, at: endedAt(node) ?? Number.POSITIVE_INFINITY }]
				: [],
		),
	);
	// Array.prototype.sort 是稳定的：同一时刻结束的（包括都没有结束时间的）保持链、节点的顺序。
	return failed
		.sort((a, b) => (a.at === b.at ? 0 : a.at - b.at))
		.map(({ chain, node }) => ({ chain, node }));
}

/** 运行视图里最终失败的节点，按失败的先后（{@link failuresInOrder}，结束时间取节点最后一次尝试的 `ended_at`）。 */
export const runViewFailures = (chains: readonly ChainRunView[]) =>
	failuresInOrder(chains, (node) => {
		const ended = node.attempts.at(-1)?.ended_at;
		return ended ? Date.parse(ended) : null;
	});

/**
 * 错误信息的第一行（之后是堆栈），去掉首尾空白；没有错误信息时是空串。只显示一句错误的地方都按它截：运行监控的页头和
 * 「需要注意」、关注项的失败原因、画布检查器（docs/DESIGN-SYSTEM.md 第 9 节）。
 */
export const errorHeadline = (message: string | null | undefined): string =>
	(message ?? "").trim().split("\n")[0]?.trim() ?? "";
