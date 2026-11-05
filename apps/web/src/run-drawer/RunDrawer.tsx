import type { RunView } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PlayIcon } from "lucide-react";
import { useCallback, useId, useState } from "react";
import { notify } from "#/components/feedback/notify";
import { CancelRunDialog } from "#/monitor/CancelRunDialog";
import { shortId } from "#/monitor/run-model";
import { getVersion } from "#/versions/api";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Sheet,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { RunSummary, useLiveRun } from "./RunSummary";
import { TriggerForm, type TriggerOptions } from "./TriggerForm";

export interface RunDrawerProps extends TriggerOptions {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	orchestrationId: string;
	/** 场景名称与说明（标题与副标题）。 */
	name: string;
	description?: string;
	/** 标题前缀：「运行」或「再次运行」。 */
	title?: string;
	/**
	 * 触发成功后的去向：不给时抽屉切换为运行摘要；给了（例如监控页的「再次运行」）就交给调用方
	 * （进入新运行的监控页）并关闭抽屉。
	 */
	onTriggered?: (run: RunView) => void;
	/** 关闭后焦点回到哪里；默认回到打开前的元素（「运行」按钮）。 */
	finalFocus?: React.RefObject<HTMLElement | null>;
}

/**
 * 运行抽屉（原型 #/scenarios 的 drawerHTML）：右侧抽屉，先填写入口参数、查看触发前检查，触发后同一个抽屉
 * 显示运行摘要（各链进度、正在执行的节点、最新日志，实时更新），可以打开运行详情或取消运行。
 * 用于场景卡片的「运行」、编排画布的「运行」与监控页的「再次运行」。
 * 焦点锁定在抽屉里，Esc 关闭，关闭后焦点回到打开它的按钮；抽屉随页面卸载，离开页面即关闭。
 */
export function RunDrawer({ open, onOpenChange, finalFocus, ...props }: RunDrawerProps) {
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent showCloseButton finalFocus={finalFocus}>
				<DrawerBody {...props} onClose={() => onOpenChange(false)} />
			</SheetContent>
		</Sheet>
	);
}

/** 抽屉内容：每次打开都重新挂载，从表单阶段开始。 */
function DrawerBody({
	orchestrationId,
	name,
	description,
	title = "运行",
	onTriggered,
	onClose,
	onLocate,
	...local
}: Omit<RunDrawerProps, "open" | "onOpenChange" | "finalFocus"> & { onClose: () => void }) {
	const formId = useId();
	const [runId, setRunId] = useState<string | null>(null);
	const [form, setForm] = useState<{
		canSubmit: boolean;
		pending: boolean;
		version: number | null;
	}>({ canSubmit: false, pending: false, version: null });
	const onState = useCallback((s: typeof form) => setForm(s), []);
	const triggered = (run: RunView) => {
		notify.success(`已触发运行 ${shortId(run.id)}`);
		if (onTriggered) {
			onTriggered(run);
			onClose();
		} else {
			setRunId(run.id);
		}
	};
	const locate =
		onLocate &&
		((nodeId: string) => {
			onClose();
			onLocate(nodeId);
		});

	return (
		<>
			<SheetHeader>
				<div className="flex items-center gap-2">
					<SheetTitle className="truncate">
						{title} · {name}
					</SheetTitle>
					{runId ? (
						<SummaryVersion runId={runId} />
					) : (
						form.version !== null &&
						form.version > 0 && <Badge className="font-mono">v{form.version}</Badge>
					)}
				</div>
				<SheetDescription className="text-sm">
					{description || (runId ? "运行已触发，实时显示进度。" : "填写入口参数，检查通过后触发。")}
				</SheetDescription>
			</SheetHeader>
			<div className="min-h-0 flex-1 overflow-auto px-4.5 py-3.5">
				{runId ? (
					<RunSummary runId={runId} />
				) : (
					<TriggerForm
						orchestrationId={orchestrationId}
						formId={formId}
						options={{ ...local, onLocate: locate }}
						onTriggered={triggered}
						onState={onState}
					/>
				)}
			</div>
			<SheetFooter>
				{runId ? (
					<SummaryActions runId={runId} orchestrationId={orchestrationId} />
				) : (
					<>
						<SheetClose render={<Button variant="ghost" />}>取消</SheetClose>
						<span className="flex-1" />
						<Button
							type="submit"
							form={formId}
							variant="primary"
							disabled={!form.canSubmit || form.pending}
						>
							<PlayIcon />
							{form.pending ? "触发中…" : "触发运行"}
						</Button>
					</>
				)}
			</SheetFooter>
		</>
	);
}

function SummaryVersion({ runId }: { runId: string }) {
	const run = useLiveRun(runId).data;
	return run ? <Badge className="font-mono">v{run.orchestration_version}</Badge> : null;
}

/** 摘要阶段的底部：取消运行（运行中）、关闭、打开运行详情。 */
function SummaryActions({ runId, orchestrationId }: { runId: string; orchestrationId: string }) {
	const run = useLiveRun(runId).data;
	const [cancelOpen, setCancelOpen] = useState(false);
	const versionNumber = run?.orchestration_version;
	// 取消确认弹窗按运行绑定的版本列出 always 节点（与监控页同一份缓存）。
	const version = useQuery({
		queryKey: ["orchestration", orchestrationId, "version", versionNumber],
		queryFn: () => getVersion(orchestrationId, versionNumber as number),
		enabled: cancelOpen && !!versionNumber,
		staleTime: Number.POSITIVE_INFINITY,
	});
	return (
		<>
			{run?.status === "running" && (
				<>
					<Button variant="danger" onClick={() => setCancelOpen(true)}>
						{run.cancel ? "强制终止" : "取消运行"}
					</Button>
					<CancelRunDialog
						run={run}
						doc={version.data?.document}
						open={cancelOpen}
						onOpenChange={setCancelOpen}
					/>
				</>
			)}
			<span className="flex-1" />
			<SheetClose render={<Button />}>关闭</SheetClose>
			<Link
				to="/runs/$id"
				params={{ id: runId }}
				className={buttonVariants({ variant: "primary" })}
			>
				打开运行详情
			</Link>
		</>
	);
}
