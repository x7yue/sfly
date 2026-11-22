import {
	effectiveTimeout,
	NODE_DEFAULTS,
	type NodeTypeIo,
	type TimeoutSource,
} from "@sfly/orchestration";

/** 生效的超时从哪来，写在界面上的样子（和 `sfly scenario show` 一致）。 */
export const TIMEOUT_SOURCE_LABEL: Record<TimeoutSource, string> = {
	node: "节点上设置",
	type: "节点类型声明",
	platform: "平台默认",
};

/** 超时输入框没填时的占位：生效的值和它从哪来，例如「43200（节点类型声明，秒）」。节点类型还没加载或找不到时按老样子写默认值。 */
export function timeoutPlaceholder(type: NodeTypeIo | null | undefined): string {
	if (!type) return `${NODE_DEFAULTS.timeout}（默认，秒）`;
	const { seconds, source } = effectiveTimeout({}, type);
	return `${seconds}（${TIMEOUT_SOURCE_LABEL[source]}，秒）`;
}

/**
 * 超时输入框下面的说明：从任务开始运行时计时；节点类型已知时再写生效的值和它从哪来，
 * 这个节点上设置了超时而节点类型也声明了时，写明盖过了节点类型声明的哪个值。
 */
export function timeoutHelp(
	node: { timeout?: number },
	type: NodeTypeIo | null | undefined,
): string {
	const base = "从任务开始运行时计时";
	if (!type) return base;
	const { seconds, source } = effectiveTimeout(node, type);
	const declared = effectiveTimeout({}, type);
	const overridden =
		source === "node" && declared.source === "type"
			? `，盖过节点类型声明的 ${declared.seconds} 秒`
			: "";
	return `${base}。生效 ${seconds} 秒：${TIMEOUT_SOURCE_LABEL[source]}${overridden}`;
}
