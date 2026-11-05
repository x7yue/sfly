import { isRetryable, NODE_DEFAULTS } from "@sfly/orchestration";
import type { OrchestrationNode } from "@sfly/schema";
import type { AttemptView, NodeRunView } from "./api";
import { ERROR_KIND_LABEL } from "./format";

/**
 * 失败处理的展示（#11，docs/SEMANTICS.md §3.2、§3.3）：错误类型标签、节点的失败 / 重试 / 跳过说明。
 * 样式在 failure.css；颜色只用状态色（失败红、重试橙），不用青色。
 */

const errorLabel = (kind: string) => ERROR_KIND_LABEL[kind] ?? kind;

/** 错误类型标签；不可重试的类型（env_error、config_error）带「不重试」标记。 */
export function ErrorKindTag({ kind }: { kind: string }) {
	return (
		<span className="sf-errkind" data-retryable={isRetryable(kind)} title={kind}>
			{errorLabel(kind)}
			<code>{kind}</code>
		</span>
	);
}

const retriesOf = (node: OrchestrationNode) =>
	node.kind === "package" ? (node.retries ?? NODE_DEFAULTS.retries) : 0;

const isAlways = (node: OrchestrationNode) => "always" in node && node.always;

/** 节点重试情况的一句话说明；没有需要说明的情况时为 null。 */
function retryNote(
	node: OrchestrationNode,
	status: string,
	attempts: AttemptView[],
	failed: AttemptView | undefined,
): string | null {
	const retries = retriesOf(node);
	const retried = Math.max(0, attempts.length - 1);
	if ((status === "queued" || status === "dispatched" || status === "running") && retried > 0) {
		return `正在进行第 ${retried} 次重试（最多重试 ${retries} 次）`;
	}
	if (status === "success") return retried > 0 ? `重试 ${retried} 次后成功` : null;
	if (status !== "failed" || !failed?.error) return null;
	if (!isRetryable(failed.error.kind)) return `${errorLabel(failed.error.kind)}不按重试次数重试`;
	if (retries === 0) return "没有配置重试";
	return `已重试 ${retried} 次，重试次数（${retries}）已用尽`;
}

/**
 * 节点检查器头部的失败说明：最近一次失败的错误类型和信息、重试情况；
 * 被跳过的节点说明原因；always 节点提示它在前面失败时照常执行。
 */
export function FailureSummary({
	node,
	state,
}: {
	node: OrchestrationNode;
	state: NodeRunView | undefined;
}) {
	const status = state?.status ?? "pending";
	const attempts = state?.attempts ?? [];
	const failed = [...attempts].reverse().find((a) => a.error);
	const note = retryNote(node, status, attempts, failed);
	const always = isAlways(node);
	const cancelled = status === "cancelled";
	if (!failed && !note && status !== "skipped" && !cancelled && !always) return null;
	return (
		<div className="sf-failure">
			{always && (
				<p className="sf-failure__always">
					<b>always</b> 前面的节点失败或运行被取消时照常执行（强制终止除外）；缺失的上游输出解析为
					null。
				</p>
			)}
			{status === "skipped" && (
				<p className="sf-hint">前面的节点失败，本节点不是 always，已跳过，没有执行。</p>
			)}
			{cancelled && (
				<p className="sf-hint">
					{attempts.at(-1)?.status === "cancelled"
						? "运行被取消，执行中的任务已被终止。"
						: "运行被取消，本节点没有执行。"}
				</p>
			)}
			{failed?.error && (
				<div className="sf-failure__error" data-final={status === "failed"}>
					<header>
						<ErrorKindTag kind={failed.error.kind} />
						<span className="sf-failure__attempt">第 {failed.attempt} 次尝试</span>
					</header>
					<pre>{failed.error.message || "（没有错误信息）"}</pre>
				</div>
			)}
			{note && <p className="sf-failure__note">{note}</p>}
		</div>
	);
}
