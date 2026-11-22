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

/** 行首的异常模块路径：小写字母、数字、下划线的名字加点，后面是首字母大写的异常类名，类名之后是冒号或行尾。 */
const MODULE_PATH = /^(?:[a-z_][a-z0-9_]*\.)+(?=[A-Z][A-Za-z0-9_.]*(?::|$))/;
/** 堆栈的开头：Python 的 `format_exc()` 在异常信息之后接它，不算异常信息的下一行。 */
const TRACEBACK = "Traceback (most recent call last)";

/**
 * 失败原因的一行：错误信息里第一行有内容的文字，去掉首尾空白和行首的异常模块路径（`sfly_std.assert_.AssertionFailed: x`
 * 取 `AssertionFailed: x`）；这一行以冒号（半角或全角）结尾、下一行紧接着有内容（不是空行，也不是堆栈的开头）时把下一行接上
 * （`…不通过：` + `第 1 条：…`），全角冒号后直接接，半角冒号后隔一个空格，只接一行。没有错误信息时是空串。
 *
 * 只显示一句错误的地方都按它取：运行监控的页头、「需要注意」和图表工作区、关注项的失败原因、画布检查器
 * （docs/DESIGN-SYSTEM.md §9）。只管这一行摘要，完整的错误信息原样保留；命令行有一份同样的实现
 * （`sdk/python/src/sfly/cli/error_headline.py`），两边共用用例表 `testdata/error-headline-cases.json`。
 */
export const errorHeadline = (message: string | null | undefined): string => {
	const lines = (message ?? "").split(/\r\n|\r|\n/).map((line) => line.trim());
	const at = lines.findIndex((line) => line !== "");
	if (at < 0) return "";
	const first = (lines[at] as string).replace(MODULE_PATH, "");
	const next = lines[at + 1] ?? "";
	if (!/[:：]$/.test(first) || next === "" || next.startsWith(TRACEBACK)) return first;
	return first.endsWith("：") ? `${first}${next}` : `${first} ${next}`;
};

/**
 * 节点失败时出错的位置（`error.location`，「模块.函数 第 N 行」）的标签：画布检查器和运行监控的节点信息里写在失败原因下面，
 * 运行通知的卡片里同样，一行摘要的地方（页头、「需要注意」、关注项、控制台「最近结束」）不写。
 */
export const ERROR_LOCATION_LABEL = "出错位置";
