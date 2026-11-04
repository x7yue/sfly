import { useMutation, useQueryClient } from "@tanstack/react-query";
import { cancelRun, type RunView } from "./api";

/**
 * 取消运行的按钮（#12，docs/SEMANTICS.md §3.4），作用于整个运行（所有链）。
 * 第一次：正在运行的任务优雅终止，未开始的普通节点取消，always 节点照常清理；
 * 清理期间按钮变成「强制终止」：always 节点也立即终止。
 */
export function CancelRunButton({ run }: { run: RunView }) {
	const queryClient = useQueryClient();
	const cancelling = run.cancel !== null;
	const cancel = useMutation({
		mutationFn: () => cancelRun(run.id),
		onSuccess: (view) => queryClient.setQueryData(["run", run.id], view),
	});
	if (run.status !== "running") return null;
	const onClick = () => {
		const question = cancelling
			? "强制终止：正在执行的清理（always）节点也会立即被杀掉，确定吗？"
			: "取消整个运行：正在运行的任务会被终止，未开始的节点不再执行，always 节点照常清理。确定吗？";
		if (window.confirm(question)) cancel.mutate();
	};
	return (
		<>
			{cancelling && (
				<span className="sf-tag sf-tag--warn" title={`由 ${run.cancel?.requested_by} 取消`}>
					取消中 · 等待清理
				</span>
			)}
			{cancel.error && <span className="sf-tag sf-tag--danger">{cancel.error.message}</span>}
			<button
				type="button"
				className="sf-btn sf-btn--danger sf-btn--sm"
				disabled={cancel.isPending}
				onClick={onClick}
			>
				{cancelling ? "强制终止" : "取消运行"}
			</button>
		</>
	);
}
