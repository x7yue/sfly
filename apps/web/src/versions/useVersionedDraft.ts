import { diffDocuments, isEmptyDiff } from "@sfly/orchestration";
import {
	domainKey,
	type OrchestrationDocument,
	type OrchestrationHeadView,
	orchestrationsApi,
	queryKey,
	type SavedVersionView,
} from "@sfly/schema";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { fromFlow, toFlow } from "#/components/canvas/flow";
import { callApi } from "#/lib/api";
import { clearDraft, loadDraft, onDraftChangedElsewhere, writeDraft } from "./draft";
import { versionConflictOf } from "./queries";

/** 一次编辑会话的起点：最新版本，或者浏览器里保存的本地草稿。 */
export interface EditStart {
	/** 每次重新载入（例如放弃本地修改）递增，用来重建画布状态。 */
	nonce: number;
	/** 打开页面（或重新载入）时控制面上的最新版本。 */
	head: OrchestrationHeadView;
	base: Base;
	/** 画布的初始内容。 */
	document: OrchestrationDocument;
	/** 是否从本地草稿恢复。 */
	fromDraft: boolean;
}

interface Base {
	version: number;
	author: string | null;
	document: OrchestrationDocument;
}

/** 按画布的方式规整文档（补齐布局、去掉没用到的包锁定），让“未修改”的判断不受这些差别影响。 */
const asCanvasDocument = (doc: OrchestrationDocument): OrchestrationDocument => {
	const { nodes, edges } = toFlow(doc);
	return fromFlow(nodes, edges, { default_agent: doc.default_agent, packages: doc.packages });
};

export function startEditing(
	orchestrationId: string,
	head: OrchestrationHeadView,
	nonce = 0,
): EditStart {
	const draft = loadDraft(orchestrationId);
	if (draft) {
		return {
			nonce,
			head,
			base: {
				version: draft.base_version,
				author: draft.base_author,
				document: draft.base_document,
			},
			document: draft.document,
			fromDraft: true,
		};
	}
	const document = asCanvasDocument(head.document);
	return {
		nonce,
		head,
		base: { version: head.number, author: head.author, document },
		document,
		fromDraft: false,
	};
}

const DRAFT_DEBOUNCE_MS = 300;

const randomTabId = (): string =>
	typeof crypto.randomUUID === "function"
		? crypto.randomUUID()
		: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * 编排的版本状态：未保存的修改实时写入本地草稿；保存时以编辑起点为 base_version，
 * 别人先保存了新版本时得到冲突（不自动合并）。
 */
export function useVersionedDraft(
	orchestrationId: string,
	start: EditStart,
	doc: OrchestrationDocument,
) {
	const queryClient = useQueryClient();
	const [base, setBase] = useState<Base>(start.base);
	const dirty = useMemo(() => !isEmptyDiff(diffDocuments(base.document, doc)), [base, doc]);

	// —— 本地草稿：有修改就写入（防抖），没有修改就清除；离开页面前立即写入 ——
	const pending = useRef<(() => void) | null>(null);
	/** 放弃本地修改 / 另存为新编排后不再写草稿（画布随后会重建或离开）。 */
	const dropped = useRef(false);
	const tabId = useMemo(randomTabId, []);
	/**
	 * 另一个标签页改写（或保存后清除）了同一份编排的本地草稿：这个标签页不再写草稿，
	 * 免得互相覆盖（草稿存在共用的 localStorage 里）；由用户决定载入那份草稿或直接保存。
	 */
	const [takenOver, setTakenOver] = useState(false);
	useEffect(
		() =>
			onDraftChangedElsewhere(orchestrationId, tabId, () => {
				dropped.current = true;
				pending.current = null;
				setTakenOver(true);
			}),
		[orchestrationId, tabId],
	);
	useEffect(() => {
		if (dropped.current) return;
		if (!dirty) {
			pending.current = null;
			clearDraft(orchestrationId);
			return;
		}
		const write = () => {
			pending.current = null;
			writeDraft(orchestrationId, {
				base_version: base.version,
				base_author: base.author,
				base_document: base.document,
				document: doc,
				updated_at: new Date().toISOString(),
				writer: tabId,
			});
		};
		pending.current = write;
		const timer = setTimeout(write, DRAFT_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [orchestrationId, dirty, base, doc, tabId]);
	useEffect(() => {
		const flush = () => pending.current?.();
		window.addEventListener("pagehide", flush);
		return () => {
			flush();
			window.removeEventListener("pagehide", flush);
		};
	}, []);

	const save = useMutation({
		mutationFn: (document: OrchestrationDocument) =>
			callApi(orchestrationsApi.saveVersion, {
				params: { id: orchestrationId },
				body: { base_version: base.version, document },
			}),
		onSuccess: (saved: SavedVersionView, document) => {
			setBase({ version: saved.number, author: saved.author, document });
			// 场景领域全部失效：列表、详情、版本历史（编辑起点由下面直接写入）。
			queryClient.invalidateQueries({ queryKey: domainKey(orchestrationsApi.get) });
			queryClient.setQueryData(
				queryKey(orchestrationsApi.head, { params: { id: orchestrationId } }),
				{
					orchestration_id: orchestrationId,
					number: saved.number,
					author: saved.author,
					created_at: saved.created_at,
					document: saved.document,
				} satisfies OrchestrationHeadView,
			);
		},
	});

	return {
		base,
		dirty,
		save,
		/** 保存被拦截：别人在编辑起点之后先保存了新版本。 */
		conflict: versionConflictOf(save.error),
		/** 另一个标签页改写了这份编排的本地草稿，这个标签页已停止写草稿。 */
		draftTakenOver: takenOver,
		/** 打开页面（或重新载入）时的最新版本。 */
		startHead: start.head,
		/** 本地草稿的编辑起点已经不是打开页面时的最新版本（保存时一定会冲突）。 */
		staleHead: start.head.number > base.version ? start.head : null,
		/** 删除本地草稿，并停止写入。 */
		dropDraft: () => {
			dropped.current = true;
			pending.current = null;
			clearDraft(orchestrationId);
		},
	};
}

export type Versioning = ReturnType<typeof useVersionedDraft>;
