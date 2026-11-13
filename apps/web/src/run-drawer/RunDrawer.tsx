import type { RunView } from "@sfly/schema";
import { Link } from "@tanstack/react-router";
import { PlayIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { PanelWidthHandle } from "#/components/PanelWidthHandle";
import { usePanelWidth } from "#/lib/panel-width";
import { CancelRunButton } from "#/monitor/CancelRunDialog";
import { useLiveRun } from "#/monitor/live-run";
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
import { RunSummary } from "./RunSummary";
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
 * 打开时焦点先落在正文上（不是页脚的「取消」：再按一次 Enter 抽屉就关了）。
 */
/** 运行抽屉的默认宽度，也是它的下限。 */
const DRAWER_MIN_WIDTH = 460;

export function RunDrawer({ open, onOpenChange, finalFocus, ...props }: RunDrawerProps) {
	const width = usePanelWidth(DRAWER_MIN_WIDTH);
	const body = useRef<HTMLDivElement>(null);
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent showCloseButton finalFocus={finalFocus} initialFocus={body} style={{ width }}>
				<DrawerBody {...props} bodyRef={body} onClose={() => onOpenChange(false)} />
				<PanelWidthHandle label="调整运行抽屉宽度" min={DRAWER_MIN_WIDTH} />
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
	bodyRef,
	...local
}: Omit<RunDrawerProps, "open" | "onOpenChange" | "finalFocus"> & {
	onClose: () => void;
	bodyRef: React.RefObject<HTMLDivElement | null>;
}) {
	const formId = useId();
	const submit = useRef<HTMLButtonElement>(null);
	const [runId, setRunId] = useState<string | null>(null);
	const [form, setForm] = useState<{
		canSubmit: boolean;
		pending: boolean;
		version: number | null;
	}>({ canSubmit: false, pending: false, version: null });
	const onState = useCallback((s: typeof form) => setForm(s), []);
	// 检查加载完与「焦点落到正文上」谁先谁后都不一定：两件事都发生、焦点还在正文上（用户没有挪走）时才移交一次。
	const handedOver = useRef(false);
	const handOverFocus = () => {
		const holder = bodyRef.current;
		if (handedOver.current || form.version === null || !holder) return;
		if (document.activeElement !== holder) return;
		const first = holder.querySelector<HTMLElement>(
			'[data-slot="input"], [data-slot="textarea"], [data-slot="switch"]',
		);
		const target = first ?? (form.canSubmit ? submit.current : null);
		if (!target) return;
		handedOver.current = true;
		target.focus();
	};
	useEffect(handOverFocus);
	const triggered = (run: RunView) => {
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
			{/* biome-ignore lint/a11y/noStaticElementInteractions: 正文只是打开时的初始焦点落点（tabIndex -1），onFocus 把焦点转交给第一个参数，不是交互控件 */}
			<div
				ref={bodyRef}
				tabIndex={-1}
				onFocus={(event) => event.target === event.currentTarget && handOverFocus()}
				className="min-h-0 flex-1 overflow-auto px-4.5 py-3.5 focus:outline-hidden"
			>
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
							ref={submit}
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
	return (
		<>
			{run?.status === "running" && (
				<CancelRunButton
					runId={run.id}
					orchestrationId={orchestrationId}
					orchestrationVersion={run.orchestration_version}
					cancelling={run.cancel !== null}
				/>
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
