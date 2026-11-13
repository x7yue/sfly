import {
	type AgentView,
	agentsApi,
	dashboardApi,
	domainKey,
	orchestrationsApi,
	queryKey,
	runListApi,
	runsApi,
} from "@sfly/schema";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { notify } from "#/components/feedback/notify";
import { callApi } from "#/lib/api";
import { shortId } from "#/lib/format";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { FormAlert } from "@/components/ui/form-field";

/**
 * 能「立即更新」的 Agent（ADR 0014）：在线、版本与控制面不一致，并且确实在更新流程中（下载中或等待任务结束）。
 * 更新失败、需要手动升级、正在替换，以及还没有自更新能力的旧 Agent（没有上报更新状态）都不能。
 */
export function canUpdateNow(agent: AgentView): boolean {
	return (
		agent.status === "online" &&
		agent.version_mismatch &&
		(agent.update.state === "downloading" || agent.update.state === "waiting_for_tasks")
	);
}

/**
 * 「立即更新」按钮与二次确认：确认框列出会被终止的任务（Agent 手上的任务，来自列表数据）。
 * 确认后控制面让这些任务以 agent_lost 失败、按重试配置重新派发，Agent 按取消流程终止它们后立即替换自己。
 */
export function UpdateNowButton({
	agent,
	controlPlaneVersion,
}: {
	agent: AgentView;
	controlPlaneVersion: string;
}) {
	const [open, setOpen] = useState(false);
	const queryClient = useQueryClient();
	const tasks = agent.running_tasks;
	const update = useMutation({
		mutationFn: () => callApi(agentsApi.updateNow, { params: { name: agent.name } }),
		onSuccess: ({ terminated_tasks }) => {
			// Agent 的更新状态和槽位、被终止任务所在的运行都变了。
			for (const key of [
				domainKey(agentsApi.list),
				domainKey(runsApi.get),
				queryKey(runListApi.list),
				domainKey(orchestrationsApi.list),
				domainKey(dashboardApi.get),
			]) {
				void queryClient.invalidateQueries({ queryKey: key });
			}
			setOpen(false);
			notify.info(`已通知 ${agent.name} 立即更新`, {
				description:
					terminated_tasks.length > 0
						? `终止了 ${terminated_tasks.length} 个任务，它们以 agent_lost 失败。`
						: undefined,
			});
		},
	});
	useEffect(() => {
		if (open) update.reset();
	}, [open, update.reset]);

	return (
		<>
			<Button size="sm" onClick={() => setOpen(true)}>
				立即更新
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="w-[480px]">
					<DialogHeader>
						<DialogTitle>
							立即更新 <span className="font-mono">{agent.name}</span>？
						</DialogTitle>
						<DialogDescription>
							不再等手上的任务结束：Agent
							按取消流程终止它们（取消标记、SIGTERM，宽限期过后强制杀掉进程树），
							然后更新到控制面的版本 <span className="font-mono">{controlPlaneVersion}</span>{" "}
							并重新启动。被终止的任务以 <span className="font-mono">agent_lost</span>{" "}
							失败，配置了重试的节点会在更新后的 Agent 上重新执行。
						</DialogDescription>
					</DialogHeader>
					<DialogBody>
						{tasks.length === 0 ? (
							<p className="m-0 text-sm text-fg-2">Agent 手上没有任务，确认后立即更新。</p>
						) : (
							<div className="flex flex-col gap-1.5 text-sm">
								<div className="text-fg-2">会被终止的 {tasks.length} 个任务：</div>
								<ul aria-label="会被终止的任务" className="m-0 flex list-none flex-col gap-1.5 p-0">
									{tasks.map((task) => (
										<li
											key={`${task.task_id}:${task.attempt}`}
											className="flex items-baseline gap-2 rounded-md border border-border-soft bg-bg px-3 py-1.5"
										>
											<span className="font-mono">{task.node_id}</span>
											<span className="text-xs text-fg-3">
												运行 <span className="font-mono">{shortId(task.run_id)}</span> · 第{" "}
												{task.attempt} 次尝试 · {task.status === "running" ? "执行中" : "派发中"}
											</span>
										</li>
									))}
								</ul>
							</div>
						)}
						{update.isError && <FormAlert>立即更新失败：{update.error.message}</FormAlert>}
					</DialogBody>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setOpen(false)}>
							取消
						</Button>
						<Button
							variant="danger-solid"
							disabled={update.isPending}
							onClick={() => update.mutate()}
						>
							立即更新
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
