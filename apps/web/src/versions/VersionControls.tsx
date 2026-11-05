import { diffDocuments } from "@sfly/orchestration";
import type { OrchestrationDocument } from "@sfly/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useState } from "react";
import {
	createOrchestration,
	getOrchestrationHead,
	type Orchestration,
	type OrchestrationHead,
} from "#/lib/api";
import { saveVersionFrom, type VersionSummary } from "./api";
import { DocumentDiffView } from "./DocumentDiffView";
import { Modal } from "./Modal";
import type { Versioning } from "./useVersionedDraft";

const formatTime = (iso: string) => new Date(iso).toLocaleString();

/**
 * 编辑器顶栏右侧：当前编辑起点的版本、是否有未保存的修改、版本历史入口和保存按钮。
 * 保存被拦截（409）时弹出冲突对话框。
 */
export function VersionControls({
	orchestration,
	doc,
	versioning,
	onReload,
}: {
	orchestration: Orchestration;
	doc: OrchestrationDocument;
	versioning: Versioning;
	/** 用最新版本重新开始编辑（放弃本地修改之后）。 */
	onReload: (head: OrchestrationHead) => void;
}) {
	const { base, dirty, save, conflict } = versioning;
	const [showConflict, setShowConflict] = useState(false);
	useEffect(() => {
		if (conflict) setShowConflict(true);
	}, [conflict]);

	return (
		<div className="ml-auto flex items-center gap-3">
			<span className="sf-tag">
				{base.version === 0
					? "还没有保存过版本"
					: `基于版本 ${base.version}${base.author ? ` · ${base.author}` : ""}`}
			</span>
			<span className="sf-dirty" data-dirty={dirty}>
				{dirty ? "有未保存的修改" : "没有未保存的修改"}
			</span>
			{save.isSuccess && !dirty && (
				<span className="sf-tag">
					已保存为版本 {save.data.number}
					{save.data.warnings.length > 0 ? `（${save.data.warnings.length} 条警告）` : ""}
				</span>
			)}
			{save.error &&
				(conflict ? (
					<button
						type="button"
						className="sf-tag sf-tag--danger underline"
						onClick={() => setShowConflict(true)}
					>
						保存被拦截：别人已保存了新版本
					</button>
				) : (
					<span className="sf-tag sf-tag--danger">保存失败：{save.error.message}</span>
				))}
			<Link
				to="/orchestrations/$id/versions"
				params={{ id: orchestration.id }}
				className="sf-link text-xs"
			>
				版本历史
			</Link>
			<button
				type="button"
				onClick={() => save.mutate(doc)}
				disabled={save.isPending || (!dirty && base.version > 0)}
				// 白色是唯一主操作：有未保存的修改时是保存，否则是触发运行（#9）。
				className={`sf-btn ${dirty || base.version === 0 ? "sf-btn--primary" : "sf-btn--ghost"}`}
			>
				{save.isPending ? "保存中…" : "保存"}
			</button>
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

/**
 * 本地草稿基于的版本已经不是最新版本时，在顶栏下方提示；
 * 另一个标签页改写了同一份草稿时，提示这个标签页已停止写草稿。
 */
export function StaleDraftBanner({
	orchestration,
	doc,
	versioning,
	onReload,
}: {
	orchestration: Orchestration;
	doc: OrchestrationDocument;
	versioning: Versioning;
	onReload: (head: OrchestrationHead) => void;
}) {
	const [open, setOpen] = useState(false);
	const head = versioning.staleHead;
	if (versioning.draftTakenOver) {
		return (
			<div className="sf-banner">
				<span>
					另一个标签页修改了这个场景的本地草稿，这个标签页的修改不再写入本地草稿（仍可直接保存）。
				</span>
				<button
					type="button"
					className="underline"
					onClick={() =>
						// 那个标签页可能已经保存（草稿随之清除）：按控制面上的最新版本重新载入。
						getOrchestrationHead(orchestration.id).then(onReload, () =>
							onReload(versioning.startHead),
						)
					}
				>
					载入那份草稿
				</button>
			</div>
		);
	}
	if (!head || head.number === 0 || versioning.conflict) return null;
	return (
		<div className="sf-banner">
			<span>
				本地草稿基于版本 {versioning.base.version}，{head.author ?? "别人"}
				{head.created_at ? ` 于 ${formatTime(head.created_at)}` : ""} 已保存了版本 {head.number}
				，直接保存会被拦截。
			</span>
			<button type="button" className="underline" onClick={() => setOpen(true)}>
				查看差异
			</button>
			{open && (
				<ConflictDialog
					orchestration={orchestration}
					doc={doc}
					head={
						head.author && head.created_at
							? { number: head.number, author: head.author, created_at: head.created_at }
							: null
					}
					versioning={versioning}
					onClose={() => setOpen(false)}
					onReload={onReload}
				/>
			)}
		</div>
	);
}

/**
 * 冲突对话框：对比最新版本与本地修改（节点、参数、连线），然后选择放弃本地修改并载入最新版本，
 * 或者把本地修改另存为新场景。不做自动合并。
 */
function ConflictDialog({
	orchestration,
	doc,
	head,
	versioning,
	onClose,
	onReload,
}: {
	orchestration: Orchestration;
	doc: OrchestrationDocument;
	head: VersionSummary | OrchestrationHead | null;
	versioning: Versioning;
	onClose: () => void;
	onReload: (head: OrchestrationHead) => void;
}) {
	const nameId = useId();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const latest = useQuery({
		queryKey: ["orchestration", orchestration.id, "latest-head"],
		queryFn: () => getOrchestrationHead(orchestration.id),
		staleTime: 0,
		gcTime: 0,
	});
	const diff = useMemo(
		() => (latest.data ? diffDocuments(latest.data.document, doc) : null),
		[latest.data, doc],
	);
	const [copyName, setCopyName] = useState(`${orchestration.name}（我的修改）`);

	const discard = () => {
		if (!latest.data) return;
		versioning.dropDraft();
		queryClient.setQueryData(["orchestration", orchestration.id, "head"], latest.data);
		onReload(latest.data);
	};

	const saveAsNew = useMutation({
		mutationFn: async (name: string) => {
			const created = await createOrchestration(name);
			await saveVersionFrom(created.id, 0, doc);
			return created;
		},
		onSuccess: (created) => {
			versioning.dropDraft();
			queryClient.invalidateQueries({ queryKey: ["orchestrations"] });
			navigate({ to: "/orchestrations/$id", params: { id: created.id } });
		},
	});

	const shown = latest.data ?? head;
	return (
		<Modal
			title="保存被拦截：场景已有更新的版本"
			description={
				<>
					你基于版本 {versioning.base.version} 编辑；
					{shown && shown.number > 0
						? `${shown.author ?? "别人"} 于 ${shown.created_at ? formatTime(shown.created_at) : "?"} 保存了版本 ${shown.number}。`
						: "最新版本已变化。"}
					不做自动合并：可以放弃本地修改并载入最新版本，或者把本地修改另存为新场景。
				</>
			}
			onClose={onClose}
			footer={
				<>
					<button type="button" className="sf-btn sf-btn--ghost" onClick={onClose}>
						继续编辑
					</button>
					<button
						type="button"
						className="sf-btn sf-btn--ghost sf-btn--danger"
						disabled={!latest.data}
						onClick={discard}
					>
						放弃本地修改并载入最新版本
					</button>
				</>
			}
		>
			{latest.error && (
				<p className="text-sm text-[var(--sf-danger)]">读取最新版本失败：{latest.error.message}</p>
			)}
			{!latest.data && !latest.error && (
				<p className="text-sm text-[var(--sf-text-muted)]">正在读取最新版本…</p>
			)}
			{diff && latest.data && (
				<DocumentDiffView
					diff={diff}
					beforeLabel={`最新版本 ${latest.data.number}`}
					afterLabel="你的本地修改"
				/>
			)}
			<form
				className="mt-4 flex items-center gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					if (copyName.trim()) saveAsNew.mutate(copyName.trim());
				}}
			>
				<label className="text-sm text-[var(--sf-text-muted)]" htmlFor={nameId}>
					新场景名称
				</label>
				<input
					id={nameId}
					className="sf-inp flex-1"
					value={copyName}
					onChange={(e) => setCopyName(e.target.value)}
				/>
				<button
					type="submit"
					className="sf-btn sf-btn--ghost"
					disabled={!copyName.trim() || saveAsNew.isPending}
				>
					{saveAsNew.isPending ? "另存中…" : "另存为新场景"}
				</button>
			</form>
			{saveAsNew.error && (
				<p className="mt-1 text-sm text-[var(--sf-danger)]">另存失败：{saveAsNew.error.message}</p>
			)}
		</Modal>
	);
}
