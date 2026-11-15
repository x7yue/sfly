import { diffDocuments } from "@sfly/orchestration";
import { domainKey, orchestrationsApi, queryKey, type VersionSummaryView } from "@sfly/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { HistoryIcon, PencilRulerIcon, RotateCcwIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { notify } from "#/components/feedback/notify";
import { EmptyState, ErrorState } from "#/components/feedback/states";
import { Page, PageHeader, Panel } from "#/components/page";
import { ViaTag } from "#/components/via-tag";
import { apiQuery, callApi } from "#/lib/api";
import { formatDateTime } from "#/lib/format";
import { notifyInvalidatedPresets, splitPresetWarnings } from "#/presets/invalidated-toast";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DocumentDiffView } from "./DocumentDiffView";
import { clearDraft, hasDraft } from "./draft";
import { versionQuery } from "./queries";
import { marksOf, VersionCanvas } from "./VersionCanvas";

const useVersion = (orchestrationId: string, number: number | undefined) =>
	useQuery({ ...versionQuery(orchestrationId, number ?? 0), enabled: number !== undefined });

/**
 * 版本历史：列出版本号、作者和时间；任选 A / B 两个版本并排只读对比（差异节点有标记，下方列出差异）；
 * 恢复 = 用旧版本的内容生成一个新版本（不改写历史）。默认对比最新的两个版本。
 */
export function VersionHistory({
	orchestrationId,
	a,
	b,
	onPick,
}: {
	orchestrationId: string;
	a: number | undefined;
	b: number | undefined;
	onPick: (next: { a?: number; b?: number }) => void;
}) {
	const orchestration = useQuery(
		apiQuery(orchestrationsApi.get, { params: { id: orchestrationId } }),
	);
	const versions = useQuery(
		apiQuery(orchestrationsApi.versions, { params: { id: orchestrationId } }),
	);
	const list = versions.data?.versions ?? [];
	const latest = list[0]?.number;

	const pickedB = b ?? latest;
	const pickedA = a ?? (b === undefined ? list[1]?.number : undefined);
	const versionA = useVersion(orchestrationId, pickedA);
	const versionB = useVersion(orchestrationId, pickedB);
	const diff = useMemo(
		() =>
			versionA.data && versionB.data
				? diffDocuments(versionA.data.document, versionB.data.document)
				: null,
		[versionA.data, versionB.data],
	);
	const [restoring, setRestoring] = useState<VersionSummaryView | null>(null);

	const name = orchestration.data?.name ?? "…";
	const editorLink = (
		<Link
			to="/orchestrations/$id"
			params={{ id: orchestrationId }}
			className={buttonVariants({ variant: "default" })}
		>
			<PencilRulerIcon />
			打开编排画布
		</Link>
	);

	if (versions.data === undefined) {
		return (
			<Page>
				<PageHeader title={name} description="版本历史" actions={editorLink} />
				{versions.isError ? (
					<ErrorState
						title="无法加载版本历史"
						error={versions.error}
						onRetry={() => versions.refetch()}
					/>
				) : (
					<output aria-label="加载中" aria-busy="true" className="flex flex-col gap-2">
						<Skeleton className="h-8 w-72" />
						<Skeleton className="h-8 w-72" />
					</output>
				)}
			</Page>
		);
	}
	if (list.length === 0) {
		return (
			<Page>
				<PageHeader title={name} description="版本历史" actions={editorLink} />
				<Panel>
					<EmptyState
						icon={<HistoryIcon />}
						title="还没有保存过版本"
						description="在编排画布里保存后，这里会列出每个版本的作者和时间。"
					>
						{editorLink}
					</EmptyState>
				</Panel>
			</Page>
		);
	}

	const panes = [
		pickedA !== undefined && pickedA !== pickedB
			? { side: "a" as const, number: pickedA, query: versionA }
			: null,
		pickedB !== undefined ? { side: "b" as const, number: pickedB, query: versionB } : null,
	].filter((p) => p !== null);
	const comparing = panes.length > 1;

	return (
		<Page className="flex min-h-full flex-col">
			<PageHeader title={name} count={list.length} description="版本历史" actions={editorLink} />
			<div className="grid flex-none grid-cols-[300px_minmax(0,1fr)] gap-3">
				<Panel className="max-h-60 overflow-y-auto">
					<ul aria-label="版本" className="m-0 list-none p-1">
						{list.map((v) => (
							<VersionRow
								key={v.number}
								version={v}
								latest={v.number === latest}
								pickedA={v.number === pickedA}
								pickedB={v.number === pickedB}
								onPickA={() => onPick({ a: v.number, b: pickedB })}
								onPickB={() => onPick({ a: pickedA, b: v.number })}
								onRestore={() => setRestoring(v)}
							/>
						))}
					</ul>
				</Panel>
				<Panel aria-label="差异" className="max-h-60 overflow-y-auto px-4 py-3">
					{!comparing ? (
						<p className="m-0 text-sm text-fg-3">
							用每个版本右侧的 A / B 选择两个版本，并排对比它们的差异。
						</p>
					) : diff ? (
						<DocumentDiffView
							diff={diff}
							beforeLabel={`版本 ${pickedA}`}
							afterLabel={`版本 ${pickedB}`}
						/>
					) : (
						<p className="m-0 text-sm text-fg-3">加载中…</p>
					)}
				</Panel>
			</div>
			<div className={cn("mt-3 grid flex-1 gap-3", comparing ? "grid-cols-2" : "grid-cols-1")}>
				{panes.map((pane) => (
					<Panel key={pane.side} className="flex flex-col">
						<div className="flex h-10 items-center gap-2 border-b border-border-soft px-3 text-xs text-fg-2">
							{comparing && <span className="font-mono text-fg-3">{pane.side.toUpperCase()}</span>}
							<span className="font-mono text-sm text-fg-1">v{pane.number}</span>
							{pane.query.data && (
								<span className="truncate">
									{pane.query.data.author}
									<ViaTag via={pane.query.data.author_via} /> ·{" "}
									{formatDateTime(pane.query.data.created_at)}
								</span>
							)}
							<span className="ml-auto text-fg-3">只读</span>
						</div>
						<div className="relative min-h-90 flex-1">
							{pane.query.data ? (
								<VersionCanvas
									label={`版本 ${pane.number}（只读）`}
									document={pane.query.data.document}
									marks={diff && comparing ? marksOf(diff, pane.side) : undefined}
								/>
							) : pane.query.isError ? (
								<ErrorState
									title={`无法加载版本 ${pane.number}`}
									error={pane.query.error}
									onRetry={() => pane.query.refetch()}
								/>
							) : (
								<Skeleton className="absolute inset-3" />
							)}
						</div>
					</Panel>
				))}
			</div>
			{latest !== undefined && (
				<RestoreDialog
					orchestrationId={orchestrationId}
					version={restoring}
					next={latest + 1}
					onClose={() => setRestoring(null)}
					onRestored={(from, to) => {
						setRestoring(null);
						notify.success(`已用版本 ${from} 的内容生成版本 ${to}`);
						onPick({ a: from, b: to });
					}}
				/>
			)}
		</Page>
	);
}

/** A / B 选择按钮：选中是中性高亮（不用青色）。 */
function PickButton({
	side,
	number,
	pressed,
	onClick,
}: {
	side: "A" | "B";
	number: number;
	pressed: boolean;
	onClick(): void;
}) {
	return (
		<button
			type="button"
			aria-pressed={pressed}
			aria-label={`把版本 ${number} 放在${side === "A" ? "左侧（A）" : "右侧（B）"}`}
			onClick={onClick}
			className={cn(
				"grid size-6 cursor-pointer place-items-center rounded-sm font-mono text-2xs text-fg-3 hover:bg-raised hover:text-fg-1",
				pressed && "bg-track text-fg-1 hover:bg-track",
			)}
		>
			{side}
		</button>
	);
}

function VersionRow({
	version,
	latest,
	pickedA,
	pickedB,
	onPickA,
	onPickB,
	onRestore,
}: {
	version: VersionSummaryView;
	latest: boolean;
	pickedA: boolean;
	pickedB: boolean;
	onPickA(): void;
	onPickB(): void;
	onRestore(): void;
}) {
	const picked = pickedA || pickedB;
	return (
		<li
			aria-current={picked || undefined}
			className={cn(
				"group flex items-center gap-2 rounded-md px-2 py-1.5",
				picked ? "selected-row" : "hover:bg-raised",
			)}
		>
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="flex items-center gap-1.5">
					<span className="font-mono text-sm text-fg-1">v{version.number}</span>
					{latest && <Badge>最新</Badge>}
				</span>
				<span className="text-xs break-words text-fg-3">
					{version.author}
					<ViaTag via={version.author_via} /> · {formatDateTime(version.created_at)}
				</span>
			</div>
			{!latest && (
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={`恢复版本 ${version.number}`}
								onClick={onRestore}
							/>
						}
					>
						<RotateCcwIcon />
					</TooltipTrigger>
					<TooltipContent>恢复：用这个版本的内容生成新版本</TooltipContent>
				</Tooltip>
			)}
			<span className="flex gap-0.5">
				<PickButton side="A" number={version.number} pressed={pickedA} onClick={onPickA} />
				<PickButton side="B" number={version.number} pressed={pickedB} onClick={onPickB} />
			</span>
		</li>
	);
}

function RestoreDialog({
	orchestrationId,
	version,
	next,
	onClose,
	onRestored,
}: {
	orchestrationId: string;
	version: VersionSummaryView | null;
	next: number;
	onClose: () => void;
	onRestored: (from: number, to: number) => void;
}) {
	const queryClient = useQueryClient();
	const draftExists = useMemo(
		() => version !== null && hasDraft(orchestrationId),
		[version, orchestrationId],
	);
	const restore = useMutation({
		mutationFn: (number: number) =>
			callApi(orchestrationsApi.restoreVersion, {
				params: { id: orchestrationId, number: String(number) },
			}),
		onSuccess: (saved, from) => {
			// 本地草稿基于旧的最新版本；恢复后从新版本开始编辑。
			clearDraft(orchestrationId);
			queryClient.removeQueries({
				queryKey: queryKey(orchestrationsApi.head, { params: { id: orchestrationId } }),
			});
			void queryClient.invalidateQueries({ queryKey: domainKey(orchestrationsApi.get) });
			onRestored(from, saved.number);
			notifyInvalidatedPresets(splitPresetWarnings(saved.warnings).presets);
		},
	});
	return (
		<Dialog
			open={version !== null}
			onOpenChange={(open) => {
				if (!open) {
					restore.reset();
					onClose();
				}
			}}
		>
			<DialogContent>
				{version && (
					<>
						<DialogHeader>
							<DialogTitle>恢复版本 {version.number}</DialogTitle>
							<DialogDescription>
								用版本 {version.number}（{version.author} · {formatDateTime(version.created_at)}
								）的内容生成新的版本 {next}。历史版本保持不变。
							</DialogDescription>
						</DialogHeader>
						{(draftExists || restore.error) && (
							<DialogBody>
								{draftExists && (
									<p className="m-0 text-sm text-warn-fg">
										本浏览器中有这个场景未保存的修改，恢复后会被放弃。
									</p>
								)}
								{restore.error && (
									<p role="alert" className="m-0 text-sm text-danger-fg">
										恢复失败：{restore.error.message}
									</p>
								)}
							</DialogBody>
						)}
						<DialogFooter>
							<Button variant="ghost" onClick={onClose}>
								取消
							</Button>
							<Button
								variant="primary"
								disabled={restore.isPending}
								onClick={() => restore.mutate(version.number)}
							>
								{restore.isPending ? "恢复中…" : `恢复为版本 ${next}`}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
