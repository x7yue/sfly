import {
	type OrchestrationDocument,
	removedNodesIn,
	removedNodesMessage,
	type StoredOrchestrationDocument,
	withoutRemovedFields,
} from "@sfly/schema";

/**
 * 可以保存的文档：没有已移除种类的节点（ADR 0028）。编辑器在有它们时不让保存（字段错误，validation.ts），
 * 这里是最后一道防线：保存接口的请求类型不含它们。
 */
export function savableDocument(document: StoredOrchestrationDocument): OrchestrationDocument {
	const removed = removedNodesIn(document);
	if (removed.length > 0) throw new Error(removedNodesMessage(removed));
	return document as OrchestrationDocument;
}

/**
 * 本地草稿：画布上未保存的编辑存在浏览器 localStorage 里（每个场景一份），刷新页面不丢失
 * （docs/ARCHITECTURE.md §6.4）。保存成功、放弃本地修改或另存为新场景后清除。
 */
export interface Draft {
	/** 草稿的编辑起点（版本号，0 = 还没有版本）；保存时作为 base_version 提交。 */
	base_version: number;
	base_author: string | null;
	/** 编辑起点的内容，用来判断是否还有未保存的修改。 */
	base_document: StoredOrchestrationDocument;
	document: StoredOrchestrationDocument;
	/** 最后一次写入草稿的时间（ISO）。 */
	updated_at: string;
	/** 写入草稿的标签页（每次打开编辑页面随机生成），用来发现其他标签页改写了同一份草稿。 */
	writer?: string;
}

const keyOf = (orchestrationId: string) => `sfly.draft.${orchestrationId}`;

export function loadDraft(orchestrationId: string): Draft | null {
	if (typeof window === "undefined") return null;
	const raw = window.localStorage.getItem(keyOf(orchestrationId));
	if (!raw) return null;
	try {
		const draft = JSON.parse(raw) as Draft;
		if (
			typeof draft.base_version !== "number" ||
			!Array.isArray(draft.document?.nodes) ||
			!Array.isArray(draft.base_document?.nodes)
		) {
			return null;
		}
		// 升级前存下的草稿还带着已移除的顶层字段（便签 `sticky_notes`，ADR 0028）：恢复时先丢掉，
		// 之后画布、对比、保存都只会看到现在支持的字段。
		return {
			...draft,
			document: withoutRemovedFields(draft.document),
			base_document: withoutRemovedFields(draft.base_document),
		};
	} catch {
		return null;
	}
}

/** 这个场景在本浏览器里是否有未保存的修改（例如触发运行前检查）。 */
export const hasDraft = (orchestrationId: string): boolean => loadDraft(orchestrationId) !== null;

export function writeDraft(orchestrationId: string, draft: Draft): void {
	try {
		window.localStorage.setItem(keyOf(orchestrationId), JSON.stringify(draft));
	} catch {
		// 配额满等情况：草稿只是辅助，不影响编辑。
	}
}

export function clearDraft(orchestrationId: string): void {
	window.localStorage.removeItem(keyOf(orchestrationId));
}

/**
 * 其他标签页改写或清除了这个场景的本地草稿时回调（`storage` 事件只在其他标签页写入时触发）。
 * 返回取消监听的函数。
 */
export function onDraftChangedElsewhere(
	orchestrationId: string,
	tabId: string,
	callback: () => void,
): () => void {
	const onStorage = (e: StorageEvent) => {
		if (e.storageArea !== window.localStorage || e.key !== keyOf(orchestrationId)) return;
		let writer: string | undefined;
		try {
			writer = e.newValue ? (JSON.parse(e.newValue) as Draft).writer : undefined;
		} catch {
			writer = undefined;
		}
		if (writer !== tabId) callback();
	};
	window.addEventListener("storage", onStorage);
	return () => window.removeEventListener("storage", onStorage);
}
