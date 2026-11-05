import type { OrchestrationDocument } from "@sfly/schema";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ArrowLeftIcon, HistoryIcon, PlayIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { floatGroupClass, GroupDivider } from "#/components/canvas/CanvasDock";
import { StatusPill } from "#/components/status";
import type { Orchestration, OrchestrationHead } from "#/lib/api";
import { useOtherEditors } from "#/lib/presence";
import type { Versioning } from "#/versions/useVersionedDraft";
import { ConflictDialog } from "#/versions/VersionControls";
import { Button, buttonVariants } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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
	warnings,
	onShowChecks,
	mode,
	onMode,
	runState,
}: {
	orchestration: Orchestration;
	version: number;
	warnings: number;
	onShowChecks(): void;
	mode: EditorMode;
	onMode(mode: EditorMode): void;
	runState?: ReactNode;
}) {
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
					<StatusPill kind={warnings > 0 ? "warn" : "ok"}>
						{warnings > 0 ? `${warnings} 条警告` : "检查通过"}
					</StatusPill>
				</button>
			)}
			<GroupDivider />
			<fieldset
				aria-label="模式"
				className="m-0 inline-flex h-7.5 gap-0.5 rounded-[7px] border border-border-soft bg-sunk p-0.5"
			>
				{(
					[
						["edit", "编辑", "E"],
						["run", "运行状态", "R"],
					] as const
				).map(([value, label, key]) => (
					<button
						key={value}
						type="button"
						aria-pressed={mode === value}
						title={value === "run" ? "在画布上查看最近一次运行的状态" : undefined}
						onClick={() => onMode(value)}
						className={cn(
							"flex cursor-pointer items-center gap-1.5 rounded-[5px] px-2.5 text-xs text-fg-2 hover:text-fg-1",
							mode === value && "bg-raised-2 text-fg-1",
						)}
					>
						{label}
						<Kbd>{key}</Kbd>
					</button>
				))}
			</fieldset>
		</div>
	);
}

const initials = (nickname: string): string => {
	const chars = [...nickname.trim()];
	const first = chars[0] ?? "?";
	return /^[a-z0-9]$/i.test(first) ? chars.slice(0, 2).join("").toUpperCase() : first;
};

/** 在线编辑者：同一份场景还有别人（或自己的其他标签页）打开着画布时显示。 */
function OnlineEditors({ orchestrationId }: { orchestrationId: string }) {
	const names = useOtherEditors(orchestrationId);
	if (names.length === 0) return null;
	const summary =
		names.length <= 2
			? `${names.join("、")} 正在编辑`
			: `${names[0]} 等 ${names.length} 人正在编辑`;
	return (
		<>
			<output
				aria-live="polite"
				title={`正在编辑：${names.join("、")}`}
				className="flex items-center gap-1.5 px-1.5"
			>
				<span className="flex">
					{names.slice(0, 3).map((name, i) => (
						<span
							key={name}
							aria-hidden
							className={cn(
								"grid size-5.5 place-items-center rounded-full border border-surface bg-raised-2 text-2xs font-semibold text-fg-1",
								i > 0 && "-ml-1.5",
							)}
						>
							{initials(name)}
						</span>
					))}
				</span>
				<span className="max-w-48 truncate text-xs text-fg-2">{summary}</span>
			</output>
			<GroupDivider />
		</>
	);
}

/**
 * 右上控件组：在线编辑者、未保存状态（与字段错误）、版本历史、保存（Ctrl S）、运行。
 * 白色主操作只有一个：有未保存的修改时是保存，否则是运行。保存被拦截（409）时弹出冲突对话框。
 */
export function EditorTopRight({
	orchestration,
	doc,
	versioning,
	fieldErrors,
	onSave,
	onRun,
	onReload,
}: {
	orchestration: Orchestration;
	doc: OrchestrationDocument;
	versioning: Versioning;
	fieldErrors: number;
	onSave(): void;
	onRun(): void;
	onReload(head: OrchestrationHead): void;
}) {
	const { base, dirty, save, conflict } = versioning;
	const unsaved = dirty || base.version === 0;
	const [showConflict, setShowConflict] = useState(false);
	useEffect(() => {
		if (conflict) setShowConflict(true);
	}, [conflict]);
	return (
		<div className={cn(floatGroupClass, "top-3 right-3")}>
			<OnlineEditors orchestrationId={orchestration.id} />
			{fieldErrors > 0 ? (
				<StatusPill kind="failed" className="px-1">
					{fieldErrors} 处字段错误
				</StatusPill>
			) : conflict ? (
				<button type="button" className="cursor-pointer px-1" onClick={() => setShowConflict(true)}>
					<StatusPill kind="failed">保存被拦截</StatusPill>
				</button>
			) : (
				<StatusPill kind={dirty ? "warn" : "pending"} className="px-1">
					{dirty ? "有未保存的修改" : base.version === 0 ? "还没有保存过版本" : "已保存"}
				</StatusPill>
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
				disabled={save.isPending || fieldErrors > 0 || (!dirty && base.version > 0)}
				onClick={onSave}
			>
				{save.isPending ? "保存中…" : "保存"}
				<Kbd
					className={cn(
						unsaved &&
							"border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground",
					)}
				>
					Ctrl S
				</Kbd>
			</Button>
			<Button variant={unsaved ? "default" : "primary"} onClick={onRun}>
				<PlayIcon />
				运行
			</Button>
			{showConflict && (
				<ConflictDialog
					orchestration={orchestration}
					doc={doc}
					head={conflict?.head ?? versioning.staleHead}
					versioning={versioning}
					onClose={() => setShowConflict(false)}
					onReload={onReload}
				/>
			)}
		</div>
	);
}
