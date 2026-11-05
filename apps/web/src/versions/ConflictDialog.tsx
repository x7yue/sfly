import { diffDocuments } from "@sfly/orchestration";
import {
	domainKey,
	type OrchestrationDocument,
	type OrchestrationHeadView,
	type OrchestrationView,
	orchestrationsApi,
	queryKey,
} from "@sfly/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useState } from "react";
import { apiQuery, callApi } from "#/lib/api";
import { formatDateTime } from "#/lib/format";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DocumentDiffView } from "./DocumentDiffView";
import type { Versioning } from "./useVersionedDraft";

/** 保存被拦截时对方保存的版本（409 的 details.head，或本地草稿过期时打开页面时的最新版本）。 */
export type ConflictHead = Pick<OrchestrationHeadView, "number" | "author" | "created_at">;

/**
 * 保存冲突弹窗（锁定焦点）：别人在编辑起点之后保存了新版本。显示对方的作者和时间、最新版本与本地修改的差异，
 * 然后选择放弃本地修改并载入最新版本，或者把本地修改另存为新场景。不做自动合并。
 */
export function ConflictDialog({
	open,
	onOpenChange,
	orchestration,
	doc,
	head,
	versioning,
	onReload,
}: {
	open: boolean;
	onOpenChange(open: boolean): void;
	orchestration: OrchestrationView;
	doc: OrchestrationDocument;
	head: ConflictHead | null;
	versioning: Versioning;
	/** 用最新版本重新开始编辑（放弃本地修改之后）。 */
	onReload(head: OrchestrationHeadView): void;
}) {
	const nameId = useId();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	// 每次打开都重新读取最新版本（对方可能又保存了）。
	const latest = useQuery({
		...apiQuery(orchestrationsApi.head, { params: { id: orchestration.id } }),
		enabled: open,
		staleTime: 0,
		refetchOnMount: "always",
	});
	const fresh = latest.data ?? null;
	const diff = useMemo(() => (fresh ? diffDocuments(fresh.document, doc) : null), [fresh, doc]);
	const [copyName, setCopyName] = useState("");
	useEffect(() => {
		if (open) setCopyName(`${orchestration.name}（我的修改）`);
	}, [open, orchestration.name]);

	const discard = () => {
		if (!fresh) return;
		versioning.dropDraft();
		queryClient.setQueryData(
			queryKey(orchestrationsApi.head, { params: { id: orchestration.id } }),
			fresh,
		);
		onOpenChange(false);
		onReload(fresh);
	};

	const saveAsNew = useMutation({
		mutationFn: async (name: string) => {
			const created = await callApi(orchestrationsApi.create, { body: { name } });
			await callApi(orchestrationsApi.saveVersion, {
				params: { id: created.id },
				body: { base_version: 0, document: doc },
			});
			return created;
		},
		onSuccess: (created) => {
			versioning.dropDraft();
			void queryClient.invalidateQueries({ queryKey: domainKey(orchestrationsApi.list) });
			onOpenChange(false);
			void navigate({ to: "/orchestrations/$id", params: { id: created.id } });
		},
	});

	const shown: ConflictHead | null = fresh ?? head;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="w-[640px]">
				<DialogHeader>
					<DialogTitle>保存被拦截：场景已有更新的版本</DialogTitle>
					<DialogDescription>
						你基于版本 {versioning.base.version} 编辑；
						{shown
							? `${shown.author ?? "别人"} 于 ${shown.created_at ? formatDateTime(shown.created_at) : "?"} 保存了版本 ${shown.number}。`
							: "最新版本已变化。"}
						不做自动合并：可以放弃本地修改并载入最新版本，或者把本地修改另存为新场景。
					</DialogDescription>
				</DialogHeader>
				<div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border-soft bg-sunk px-3 py-2.5">
					{latest.error ? (
						<p role="alert" className="m-0 text-sm text-danger-fg">
							读取最新版本失败：{latest.error.message}
						</p>
					) : diff && fresh ? (
						<DocumentDiffView
							diff={diff}
							beforeLabel={`最新版本 ${fresh.number}`}
							afterLabel="你的本地修改"
						/>
					) : (
						<p className="m-0 text-sm text-fg-3">正在读取最新版本…</p>
					)}
				</div>
				<form
					className="flex items-center gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						if (copyName.trim()) saveAsNew.mutate(copyName.trim());
					}}
				>
					<label htmlFor={nameId} className="flex-none text-xs text-fg-2">
						新场景名称
					</label>
					<Input
						id={nameId}
						className="flex-1"
						value={copyName}
						maxLength={120}
						onChange={(e) => setCopyName(e.target.value)}
					/>
					<Button type="submit" disabled={!copyName.trim() || saveAsNew.isPending}>
						{saveAsNew.isPending ? "另存中…" : "另存为新场景"}
					</Button>
				</form>
				{saveAsNew.error && (
					<p role="alert" className="m-0 text-sm text-danger-fg">
						另存失败：{saveAsNew.error.message}
					</p>
				)}
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						继续编辑
					</Button>
					<Button variant="danger" disabled={!fresh} onClick={discard}>
						放弃本地修改并载入最新版本
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
