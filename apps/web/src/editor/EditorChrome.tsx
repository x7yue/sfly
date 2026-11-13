import type { OrchestrationDocument, OrchestrationHeadView, OrchestrationView } from "@sfly/schema";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ArrowLeftIcon, HistoryIcon, PlayIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { floatGroupClass, GroupDivider } from "#/components/canvas/CanvasDock";
import { StatusPill } from "#/components/status";
import { shortcutKeys, shortcutText } from "#/lib/shortcuts";
import { ConflictDialog } from "#/versions/ConflictDialog";
import type { Versioning } from "#/versions/useVersionedDraft";
import { Button, buttonVariants } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { OnlineEditors } from "./OnlineEditors";
import { checkSummary } from "./validation";

/** 画布模式：编辑，或叠加一次运行的节点状态（只读，#41）。 */
export type EditorMode = "edit" | "run";

/** 顶部控件组（上边距 12 + 高 42）占住的高度。 */
export const TOP_GROUP_SPACE = 54;

/**
 * 左上控件组：返回、场景名、版本（编辑起点，或运行绑定的版本）、检查状态、模式切换（E / R）。
 * 「运行状态」模式（#41）下检查状态换成 `runState`（运行状态、编号、耗时）。
 */
export function EditorTopLeft({
	orchestration,
	version,
	fieldErrors,
	warnings,
	notes,
	onShowChecks,
	mode,
	onMode,
	runState,
}: {
	orchestration: OrchestrationView;
	version: number;
	/** 阻止保存的字段错误条数（检查结果里最先显示）。 */
	fieldErrors: number;
	warnings: number;
	/** 不影响保存与触发的提醒条数（validation.ts 的 undeclaredInputNotes）。 */
	notes: number;
	onShowChecks(): void;
	mode: EditorMode;
	onMode(mode: EditorMode): void;
	runState?: ReactNode;
}) {
	const summary = checkSummary(fieldErrors, warnings, notes);
	return (
		<div className={cn(floatGroupClass, "top-3 left-3")}>
			<Link
				to="/orchestrations"
				aria-label="返回场景编排"
				className={buttonVariants({ variant: "ghost", size: "icon" })}
			>
				<ArrowLeftIcon />
			</Link>
			<h1 className="m-0 max-w-80 truncate px-1 text-sm font-semibold">{orchestration.name}</h1>
			<span className="font-mono text-xs text-fg-3">
				{version === 0 ? "未保存过" : `v${version}`}
			</span>
			<GroupDivider />
			{mode === "run" ? (
				runState
			) : (
				<button
					type="button"
					className="cursor-pointer rounded-md px-1.5 py-1 hover:bg-raised"
					onClick={onShowChecks}
				>
					<StatusPill kind={summary.kind}>{summary.label}</StatusPill>
				</button>
			)}
			<GroupDivider />
			<fieldset
				aria-label="模式"
				className="m-0 inline-flex h-7.5 gap-0.5 rounded-lg border border-border-soft bg-sunk p-0.5"
			>
				{(
					[
						["edit", "编辑", "canvas-mode-edit"],
						["run", "运行状态", "canvas-mode-run"],
					] as const
				).map(([value, label, shortcut]) => (
					<button
						key={value}
						type="button"
						aria-pressed={mode === value}
						title={value === "run" ? "在画布上查看最近一次运行的状态" : undefined}
						onClick={() => onMode(value)}
						className={cn(
							"flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs text-fg-2 hover:text-fg-1",
							mode === value && "bg-raised-2 text-fg-1",
						)}
					>
						{label}
						<Kbd>{shortcutText(shortcut)}</Kbd>
					</button>
				))}
			</fieldset>
		</div>
	);
}

/**
 * 右上控件组：在线编辑者、保存状态、版本历史、保存（Ctrl S）、运行。保存状态只有需要处理的才带点：
 * 保存被拦截（红）、没有保存的修改或还没有保存过版本（琥珀，此时白色主操作是保存）；已保存是纯文字。
 * 字段错误属于检查结果，显示在左上控件组；保存按钮不因字段错误禁用，点它会把焦点放到出错的字段（ScenarioEditor 的 save）。
 * 白色主操作只有一个：有未保存的修改时是保存，否则是运行。保存被拦截（409）时弹出冲突对话框。
 */
export function EditorTopRight({
	orchestration,
	editors,
	doc,
	versioning,
	onSave,
	onRun,
	onReload,
}: {
	orchestration: OrchestrationView;
	/** 在线编辑者（useOtherEditors）。 */
	editors: readonly string[];
	doc: OrchestrationDocument;
	versioning: Versioning;
	onSave(): void;
	onRun(): void;
	onReload(head: OrchestrationHeadView): void;
}) {
	const { base, dirty, save, conflict } = versioning;
	const unsaved = dirty || base.version === 0;
	const [showConflict, setShowConflict] = useState(false);
	useEffect(() => {
		if (conflict) setShowConflict(true);
	}, [conflict]);
	return (
		<div className={cn(floatGroupClass, "top-3 right-3")}>
			<OnlineEditors names={editors} />
			{conflict ? (
				<button type="button" className="cursor-pointer px-1" onClick={() => setShowConflict(true)}>
					<StatusPill kind="failed">保存被拦截</StatusPill>
				</button>
			) : unsaved ? (
				<StatusPill kind="warn" className="px-1">
					{dirty ? "有未保存的修改" : "还没有保存过版本"}
				</StatusPill>
			) : (
				<span className="px-1 text-xs whitespace-nowrap text-fg-3">已保存</span>
			)}
			<Tooltip>
				<TooltipTrigger
					render={
						<Link
							to="/orchestrations/$id/versions"
							params={{ id: orchestration.id }}
							aria-label="版本历史"
							className={buttonVariants({ variant: "ghost", size: "icon" })}
						/>
					}
				>
					<HistoryIcon />
				</TooltipTrigger>
				<TooltipContent>版本历史</TooltipContent>
			</Tooltip>
			<Button
				variant={unsaved ? "primary" : "default"}
				disabled={save.isPending || (!dirty && base.version > 0)}
				onClick={onSave}
			>
				{save.isPending ? "保存中…" : "保存"}
				<Kbd
					className={cn(
						unsaved &&
							"border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground",
					)}
				>
					{shortcutText("canvas-save")}
				</Kbd>
			</Button>
			<Tooltip>
				<TooltipTrigger
					render={<Button variant={unsaved ? "default" : "primary"} onClick={onRun} />}
				>
					<PlayIcon />
					运行
				</TooltipTrigger>
				<TooltipContent>
					运行
					{shortcutKeys("canvas-run")
						.flat()
						.map((key) => (
							<Kbd key={key}>{key}</Kbd>
						))}
				</TooltipContent>
			</Tooltip>
			<ConflictDialog
				open={showConflict}
				onOpenChange={setShowConflict}
				orchestration={orchestration}
				doc={doc}
				head={conflict?.head ?? versioning.staleHead}
				versioning={versioning}
				onReload={onReload}
			/>
		</div>
	);
}
