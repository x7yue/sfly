import { type DocumentDiff, diffDocuments } from "@sfly/orchestration";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { getOrchestration } from "#/lib/api";
import { getVersion, listVersions, restoreVersion, type VersionSummary } from "./api";
import { DocumentDiffView } from "./DocumentDiffView";
import { clearDraft, hasDraft } from "./draft";
import { Modal } from "./Modal";
import { type NodeMark, ReadOnlyCanvas } from "./ReadOnlyCanvas";

const formatTime = (iso: string) => new Date(iso).toLocaleString();

/** 一侧画布上的差异标记：A 侧标出删除和修改的节点，B 侧标出新增和修改的节点。 */
function marksOf(diff: DocumentDiff, side: "a" | "b"): Map<string, NodeMark> {
	const marks = new Map<string, NodeMark>();
	for (const n of diff.nodes.changed) marks.set(n.id, "changed");
	for (const n of side === "a" ? diff.nodes.removed : diff.nodes.added) {
		marks.set(n.id, side === "a" ? "removed" : "added");
	}
	return marks;
}

const useVersion = (orchestrationId: string, number: number | undefined) =>
	useQuery({
		queryKey: ["orchestration", orchestrationId, "version", number],
		queryFn: () => getVersion(orchestrationId, number as number),
		enabled: number !== undefined,
		// 版本不可变。
		staleTime: Number.POSITIVE_INFINITY,
	});

/**
 * 版本历史：列出版本号、作者和时间；选择 A / B 两个版本只读并排查看并对比差异；
 * 恢复 = 用旧版本的内容生成一个新版本（不改写历史）。
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
	const orchestration = useQuery({
		queryKey: ["orchestration", orchestrationId],
		queryFn: () => getOrchestration(orchestrationId),
	});
	const versions = useQuery({
		queryKey: ["orchestration", orchestrationId, "versions"],
		queryFn: () => listVersions(orchestrationId),
	});
	const list = versions.data?.versions ?? [];
	const latest = list[0]?.number;

	// 默认对比最新的两个版本。
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

	const [restoring, setRestoring] = useState<VersionSummary | null>(null);
	const [restored, setRestored] = useState<{ from: number; to: number } | null>(null);

	if (versions.error) return <p className="p-8 text-red-600">加载失败：{versions.error.message}</p>;
	if (!versions.data) return <p className="p-8 text-gray-500">加载中…</p>;

	const panes = [
		pickedA !== undefined && pickedA !== pickedB
			? { side: "a" as const, number: pickedA, query: versionA }
			: null,
		pickedB !== undefined ? { side: "b" as const, number: pickedB, query: versionB } : null,
	].filter((p) => p !== null);

	return (
		<div className="sf-versions">
			<aside className="sf-versions__list">
				<div className="flex items-center gap-2 border-b border-[var(--sf-border)] px-3 py-3">
					<Link
						to="/orchestrations/$id"
						params={{ id: orchestrationId }}
						className="text-sm text-[var(--sf-accent)] hover:underline"
					>
						← 返回编辑
					</Link>
					<h1 className="truncate text-base font-semibold">
						{orchestration.data?.name ?? "…"} · 版本历史
					</h1>
				</div>
				{restored && (
					<p className="border-b border-[var(--sf-border)] px-3 py-2 text-sm text-[var(--sf-success)]">
						已用版本 {restored.from} 的内容生成版本 {restored.to}。
					</p>
				)}
				{list.length === 0 && (
					<p className="px-3 py-4 text-sm text-[var(--sf-text-muted)]">还没有保存过版本。</p>
				)}
				{list.map((v) => (
					<div
						key={v.number}
						className="sf-version"
						data-picked={v.number === pickedA || v.number === pickedB}
					>
						<span className="sf-version__no">v{v.number}</span>
						<span className="text-xs text-[var(--sf-text-muted)]">
							{v.number === latest ? "最新" : ""}
						</span>
						<span className="sf-pick">
							<button
								type="button"
								aria-pressed={v.number === pickedA}
								aria-label={`把版本 ${v.number} 放在左侧（A）`}
								onClick={() => onPick({ a: v.number, b: pickedB })}
							>
								A
							</button>
							<button
								type="button"
								aria-pressed={v.number === pickedB}
								aria-label={`把版本 ${v.number} 放在右侧（B）`}
								onClick={() => onPick({ a: pickedA, b: v.number })}
							>
								B
							</button>
						</span>
						<span className="sf-version__meta">
							{v.author} · {formatTime(v.created_at)}
							{v.number !== latest && (
								<button
									type="button"
									className="ml-2 text-[var(--sf-accent)] hover:underline"
									onClick={() => setRestoring(v)}
								>
									恢复
								</button>
							)}
						</span>
					</div>
				))}
			</aside>
			<main className="sf-versions__main">
				{panes.length > 0 ? (
					<div className="sf-versions__canvases">
						{panes.map((pane) => (
							<div key={pane.side} className="sf-versions__pane">
								<span className="sf-versions__pane-label">
									{panes.length > 1 ? `${pane.side.toUpperCase()} · ` : ""}版本 {pane.number}
									{pane.query.data
										? ` · ${pane.query.data.author} · ${formatTime(pane.query.data.created_at)}`
										: ""}
									（只读）
								</span>
								{pane.query.data && (
									<ReadOnlyCanvas
										document={pane.query.data.document}
										marks={diff && panes.length > 1 ? marksOf(diff, pane.side) : undefined}
									/>
								)}
							</div>
						))}
					</div>
				) : (
					<div className="flex-1" />
				)}
				{panes.length > 1 && (
					<section className="sf-versions__diff">
						<h2 className="mb-2 text-sm font-semibold">
							版本 {pickedA} → 版本 {pickedB} 的差异
						</h2>
						{diff ? (
							<DocumentDiffView
								diff={diff}
								beforeLabel={`版本 ${pickedA}`}
								afterLabel={`版本 ${pickedB}`}
							/>
						) : (
							<p className="text-sm text-[var(--sf-text-muted)]">加载中…</p>
						)}
					</section>
				)}
			</main>
			{restoring && latest !== undefined && (
				<RestoreDialog
					orchestrationId={orchestrationId}
					version={restoring}
					next={latest + 1}
					onClose={() => setRestoring(null)}
					onRestored={(to) => {
						setRestoring(null);
						setRestored({ from: restoring.number, to });
						onPick({ a: restoring.number, b: to });
					}}
				/>
			)}
		</div>
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
	version: VersionSummary;
	next: number;
	onClose: () => void;
	onRestored: (number: number) => void;
}) {
	const queryClient = useQueryClient();
	const [draftExists] = useState(() => hasDraft(orchestrationId));
	const restore = useMutation({
		mutationFn: () => restoreVersion(orchestrationId, version.number),
		onSuccess: (saved) => {
			// 本地草稿基于旧的最新版本；恢复后从新版本开始编辑。
			clearDraft(orchestrationId);
			queryClient.removeQueries({ queryKey: ["orchestration", orchestrationId, "head"] });
			queryClient.invalidateQueries({ queryKey: ["orchestration", orchestrationId] });
			queryClient.invalidateQueries({ queryKey: ["orchestrations"] });
			onRestored(saved.number);
		},
	});
	return (
		<Modal
			title={`恢复版本 ${version.number}`}
			description={`用版本 ${version.number}（${version.author} · ${formatTime(version.created_at)}）的内容生成新的版本 ${next}。历史版本保持不变。`}
			onClose={onClose}
			footer={
				<>
					<button type="button" className="sf-btn" onClick={onClose}>
						取消
					</button>
					<button
						type="button"
						className="sf-btn sf-btn--primary"
						disabled={restore.isPending}
						onClick={() => restore.mutate()}
					>
						{restore.isPending ? "恢复中…" : `恢复为版本 ${next}`}
					</button>
				</>
			}
		>
			{(draftExists || restore.error) && (
				<>
					{draftExists && (
						<p className="text-sm text-[var(--sf-warning)]">
							本浏览器中有这份编排未保存的修改，恢复后会被放弃。
						</p>
					)}
					{restore.error && (
						<p className="text-sm text-[var(--sf-danger)]">恢复失败：{restore.error.message}</p>
					)}
				</>
			)}
		</Modal>
	);
}
