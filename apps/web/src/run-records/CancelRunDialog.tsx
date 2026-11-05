import { domainKey, type RunListItem, runsApi } from "@sfly/schema";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { notify } from "#/components/feedback/notify";
import { callApi } from "#/lib/api";
import { shortId } from "#/monitor/run-model";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";

/**
 * 卡片上的「取消运行」（docs/SEMANTICS.md §3.4）：确认后取消整个运行（所有链）。
 * 已在取消中（清理期间）时按钮变成「强制终止」：always 节点也立即终止。
 */
export function CancelRunButton({ run }: { run: RunListItem }) {
	const [open, setOpen] = useState(false);
	const queryClient = useQueryClient();
	const force = run.cancelling;
	const cancel = useMutation({
		mutationFn: () => callApi(runsApi.cancel, { params: { id: run.id } }),
		onSuccess: () => {
			setOpen(false);
			notify.success(force ? "已强制终止运行" : "已请求取消运行", {
				description: force ? undefined : "正在运行的任务终止后，always 节点照常清理。",
			});
			void queryClient.invalidateQueries({ queryKey: domainKey(runsApi.get) });
		},
		onError: (error) => notify.error("取消运行失败", { description: error.message }),
	});
	const id = shortId(run.id);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger render={<Button size="sm" variant="ghost" />}>
				{force ? "强制终止" : "取消运行"}
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{force ? `强制终止运行 ${id}？` : `取消运行 ${id}？`}</DialogTitle>
					<DialogDescription>
						{force
							? "正在执行的清理（always）节点也会立即终止。"
							: "正在运行的任务会优雅终止，未开始的节点标记为已取消，always 节点照常执行清理。"}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose render={<Button variant="ghost" />}>返回</DialogClose>
					<Button
						variant="danger-solid"
						disabled={cancel.isPending}
						onClick={() => cancel.mutate()}
					>
						{force ? "强制终止" : "取消运行"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
