import { type OrchestrationDocument, queryKey, type RunView, runsApi } from "@sfly/schema";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { notify } from "#/components/feedback/notify";
import { callApi } from "#/lib/api";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cancelImpact, shortId } from "./run-model";

/** 确认时要输入的运行编号前几位。 */
const CONFIRM_CHARS = 4;

const ids = (nodes: { node_id: string }[]) =>
	nodes.length === 0 ? "—" : [...new Set(nodes.map((n) => n.node_id))].join("、");

/**
 * 取消运行的确认弹窗（原型 ovCancel，docs/SEMANTICS.md §3.4）：列出影响，输入运行编号前 4 位后才能确认。
 * 第一次取消：执行中的任务优雅终止，always 节点照常清理，未开始的节点标记为已取消；
 * 清理期间（已取消、运行还没结束）再次取消即强制终止：always 节点也立即终止。
 */
export function CancelRunDialog({
	run,
	doc,
	open,
	onOpenChange,
}: {
	run: RunView;
	doc: OrchestrationDocument | undefined;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const queryClient = useQueryClient();
	const force = run.cancel !== null;
	const [typed, setTyped] = useState("");
	const inputId = useId();
	const code = run.id.slice(0, CONFIRM_CHARS);
	const impact = cancelImpact(run, doc);
	const cancel = useMutation({
		mutationFn: () => callApi(runsApi.cancel, { params: { id: run.id } }),
		onSuccess: (view) => {
			queryClient.setQueryData(queryKey(runsApi.get, { params: { id: run.id } }), view);
			notify.info(force ? "已强制终止运行" : "已请求取消运行", {
				description: force ? undefined : "正在等待执行中的任务结束与 always 节点清理。",
			});
			onOpenChange(false);
		},
		onError: (error) =>
			notify.error(force ? "强制终止失败" : "取消失败", { description: error.message }),
	});

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) setTyped("");
				onOpenChange(next);
			}}
		>
			<DialogContent className="w-[480px]">
				<DialogHeader>
					<DialogTitle>
						{force ? "强制终止运行" : "取消运行"}{" "}
						<span className="font-mono">{shortId(run.id)}</span>？
					</DialogTitle>
					<DialogDescription>
						{force
							? "运行正在取消、等待清理。强制终止会立即结束包括 always 清理节点在内的所有任务。"
							: "这会同时取消主链和全部子流程实例。"}
					</DialogDescription>
				</DialogHeader>
				<ul aria-label="取消的影响" className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
					{force ? (
						<Impact
							title={`执行中的 ${impact.running.length} 个任务立即终止`}
							detail={ids(impact.running)}
						/>
					) : (
						<>
							<Impact
								title={`执行中的 ${impact.running.length} 个任务先优雅终止`}
								detail={`${ids(impact.running)} · 宽限期过后强制杀掉整棵进程树`}
							/>
							<Impact
								title="always 节点照常执行清理"
								detail={`${ids(impact.always)} · 清理期间可以再次取消以强制终止`}
								warn
							/>
							<Impact
								title={`未开始的 ${impact.cancelled.length} 个节点标记为已取消`}
								detail={ids(impact.cancelled)}
							/>
						</>
					)}
				</ul>
				<form
					id={`${inputId}-form`}
					onSubmit={(e) => {
						e.preventDefault();
						if (typed === code && !cancel.isPending) cancel.mutate();
					}}
				>
					<label htmlFor={inputId} className="mb-1.5 block text-sm text-fg-2">
						输入运行编号前 {CONFIRM_CHARS} 位 <span className="font-mono text-fg-1">{code}</span>{" "}
						以确认
					</label>
					<Input
						id={inputId}
						autoComplete="off"
						className="font-mono"
						value={typed}
						onChange={(e) => setTyped(e.target.value.trim())}
					/>
				</form>
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						继续运行
					</Button>
					<Button
						type="submit"
						form={`${inputId}-form`}
						variant="danger-solid"
						disabled={typed !== code || cancel.isPending}
					>
						{force ? "强制终止" : "取消运行"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function Impact({ title, detail, warn }: { title: string; detail: string; warn?: boolean }) {
	return (
		<li className="flex gap-2.5 rounded-md border border-border-soft bg-bg px-3 py-2">
			<span aria-hidden className={warn ? "text-warn" : "text-fg-3"}>
				{warn ? "!" : "•"}
			</span>
			<div className="min-w-0">
				<div>{title}</div>
				<div className="font-mono text-xs break-all text-fg-3">{detail}</div>
			</div>
		</li>
	);
}
