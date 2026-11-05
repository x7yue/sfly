import {
	type OrchestrationDocument,
	type OrchestrationHeadView,
	type OrchestrationView,
	orchestrationsApi,
} from "@sfly/schema";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { callApi } from "#/lib/api";
import { formatDateTime } from "#/lib/format";
import { Button } from "@/components/ui/button";
import { ConflictDialog } from "./ConflictDialog";
import type { Versioning } from "./useVersionedDraft";

function Banner({ children }: { children: React.ReactNode }) {
	return (
		<output className="flex items-center gap-2 rounded-lg border border-warn-line bg-surface px-3 py-2 text-xs text-fg-2 shadow-float [&>svg]:size-4 [&>svg]:flex-none [&>svg]:text-warn">
			{children}
		</output>
	);
}

/**
 * 画布顶部的本地草稿提示：本地草稿基于的版本已经不是最新版本（直接保存一定会被拦截，可以先查看差异）；
 * 或者另一个标签页改写了同一份草稿（这个标签页已停止写草稿，可以载入那份草稿）。
 */
export function DraftBanner({
	orchestration,
	doc,
	versioning,
	onReload,
}: {
	orchestration: OrchestrationView;
	doc: OrchestrationDocument;
	versioning: Versioning;
	onReload: (head: OrchestrationHeadView) => void;
}) {
	const [open, setOpen] = useState(false);
	const head = versioning.staleHead;
	if (versioning.draftTakenOver) {
		return (
			<Banner>
				<TriangleAlertIcon />
				<span>
					另一个标签页修改了这个场景的本地草稿，这个标签页的修改不再写入本地草稿（仍可直接保存）。
				</span>
				<Button
					size="sm"
					variant="ghost"
					onClick={() =>
						// 那个标签页可能已经保存（草稿随之清除）：按控制面上的最新版本重新载入。
						callApi(orchestrationsApi.head, { params: { id: orchestration.id } }).then(
							onReload,
							() => onReload(versioning.startHead),
						)
					}
				>
					载入那份草稿
				</Button>
			</Banner>
		);
	}
	if (!head || head.number === 0 || versioning.conflict) return null;
	return (
		<Banner>
			<TriangleAlertIcon />
			<span>
				本地草稿基于版本 {versioning.base.version}，{head.author ?? "别人"}
				{head.created_at ? ` 于 ${formatDateTime(head.created_at)}` : ""} 已保存了版本 {head.number}
				，直接保存会被拦截。
			</span>
			<Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
				查看差异
			</Button>
			<ConflictDialog
				open={open}
				onOpenChange={setOpen}
				orchestration={orchestration}
				doc={doc}
				head={head}
				versioning={versioning}
				onReload={onReload}
			/>
		</Banner>
	);
}
