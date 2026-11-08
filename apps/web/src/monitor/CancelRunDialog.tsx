import {
	dashboardApi,
	domainKey,
	type OrchestrationDocument,
	orchestrationsApi,
	queryKey,
	type RunView,
	runListApi,
	runsApi,
} from "@sfly/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleStopIcon } from "lucide-react";
import { useRef, useState } from "react";
import { notify } from "#/components/feedback/notify";
import { callApi } from "#/lib/api";
import { ACTION } from "#/lib/copy";
import { shortId } from "#/lib/format";
import { versionQuery } from "#/versions/queries";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { runViewQuery, writeRunView } from "./live-run";
import { cancelImpact } from "./run-model";
import { COLLAPSE_BUTTON, COLLAPSE_LABEL } from "./top-bar";

const ids = (nodes: { node_id: string }[]) =>
	nodes.length === 0 ? "—" : [...new Set(nodes.map((n) => n.node_id))].join("、");

/**
 * 取消运行的确认弹窗（原型 ovCancel，docs/SEMANTICS.md §3.4）：列出影响，点「取消运行」确认。
 * 打开时焦点在「继续运行」（安全的默认项），误按 Enter 不会取消运行。
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
	const keep = useRef<HTMLButtonElement>(null);
	const impact = cancelImpact(run, doc);
	const cancel = useMutation({
		mutationFn: () => callApi(runsApi.cancel, { params: { id: run.id } }),
		onSuccess: (view) => {
			// 响应是在运行结束前生成的，可能晚于事件流推送的最终状态到达；按 latestRunView 合并，不覆盖最终状态（#47）。
			writeRunView(queryClient, view);
			// 列出这个运行的列表（运行记录、场景的运行、场景列表的最近运行、控制台）随之刷新，进入「取消中」。
			// 运行视图本身不重新获取：上面已经写入，之后由运行事件流更新。
			for (const key of [
				queryKey(runListApi.list),
				queryKey(runsApi.listForOrchestration),
				domainKey(orchestrationsApi.list),
				domainKey(dashboardApi.get),
			]) {
				void queryClient.invalidateQueries({ queryKey: key });
			}
			notify.info(force ? "已强制终止运行" : "已请求取消运行", {
				description: force ? undefined : "正在等待执行中的任务结束与 always 节点清理。",
			});
			onOpenChange(false);
		},
		onError: (error) =>
			notify.error(force ? "强制终止失败" : "取消失败", { description: error.message }),
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="w-[480px]" initialFocus={keep}>
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
				<DialogFooter>
					<Button ref={keep} variant="ghost" onClick={() => onOpenChange(false)}>
						{ACTION.keepRunning}
					</Button>
					<Button
						variant="danger-solid"
						disabled={cancel.isPending}
						onClick={() => cancel.mutate()}
					>
						{force ? ACTION.forceCancel : ACTION.cancelRun}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * 运行进行中的「取消运行」（清理期间为「强制终止」）按钮与确认弹窗：监控页顶栏、运行抽屉、运行记录卡片共用。
 * 按钮是中性样式，危险强调留在确认弹窗里；运行视图与绑定版本的文档（列出 always 节点）在打开时读取，
 * 与监控页同一份缓存。
 */
export function CancelRunButton({
	runId,
	orchestrationId,
	orchestrationVersion,
	cancelling,
	size,
	collapse,
}: {
	runId: string;
	orchestrationId: string;
	orchestrationVersion: number;
	/** 已请求取消、运行还没结束（按钮变成「强制终止」）。 */
	cancelling: boolean;
	size?: "sm";
	/** 窗口窄于 1280 时只显示图标（文字留给读屏与悬停提示），监控页顶栏用。 */
	collapse?: boolean;
}) {
	const label = cancelling ? ACTION.forceCancel : ACTION.cancelRun;
	const [open, setOpen] = useState(false);
	const run = useQuery({ ...runViewQuery(runId), enabled: open });
	const version = useQuery({
		...versionQuery(orchestrationId, orchestrationVersion),
		enabled: open && orchestrationVersion > 0,
	});
	return (
		<>
			{collapse ? (
				<Button size={size} title={label} className={COLLAPSE_BUTTON} onClick={() => setOpen(true)}>
					<CircleStopIcon className="xl:hidden" />
					<span className={COLLAPSE_LABEL}>{label}</span>
				</Button>
			) : (
				<Button size={size} onClick={() => setOpen(true)}>
					{label}
				</Button>
			)}
			{run.data && (
				<CancelRunDialog
					run={run.data}
					doc={version.data?.document}
					open={open}
					onOpenChange={setOpen}
				/>
			)}
		</>
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
