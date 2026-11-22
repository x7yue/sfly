import type { AnnotationMembers } from "./annotations.js";
import { nodeNameWithId } from "./node-display.js";
import type { StructureDocument } from "./structure.js";

/**
 * 注释框写错时的警告（docs/SEMANTICS.md §1.6）：引用了不存在的节点或子流程、没有成员、同一个成员写了两次。
 * 注释框不影响执行，所以这些警告只提示，保存和触发都不被阻断（`blocksTrigger`）；画布打开、保存时也不会
 * 把这些成员自动清理掉。画框时跳过不存在的成员见 `annotationBoxes`。
 */

export type AnnotationWarningCode =
	| "annotation_unknown_node"
	| "annotation_unknown_subflow"
	| "annotation_no_members"
	| "annotation_duplicate_member";

export interface AnnotationWarning {
	code: AnnotationWarningCode;
	/** 写出注释框的标题和 ID，提到的节点写成「显示名称（节点 ID）」。 */
	message: string;
	/** 警告所指的注释框；校验面板的「前往」选中它。 */
	annotation_id: string;
	/**
	 * 指向成员的警告（引用了不存在的成员、成员写了两次）：是哪个成员，`nodes/<节点 ID>` 或 `subflows/<子流程入口节点 ID>`；
	 * 一个注释框里可能有几个。没有成员的警告不写。
	 */
	target?: string;
	/** 没有：问题出在注释框上，不在某个节点上（节点卡片上不显示警告标记）。 */
	node_id?: undefined;
	input?: undefined;
}

/** 注释框检查读取的部分：文档的节点，和注释框的标题与成员。 */
export interface AnnotationWarningDocument {
	nodes: StructureDocument["nodes"];
	annotations?: readonly (AnnotationMembers & { readonly title: string })[] | undefined;
}

/** 警告里区分注释框的部分：只有注释框的警告带 `annotation_id`，接口返回的警告（DocumentWarningView）也是。 */
export interface WarningShape {
	message: string;
	annotation_id?: string | undefined;
}

/**
 * 警告是否注释框的警告：别的警告指着节点或整个场景（`OrchestrationWarning` 靠 `annotation_id`
 * 这一个字段分成两类）。接口返回的警告（DocumentWarningView）形状相同，也能判断。
 */
export const isAnnotationWarning = <W extends WarningShape>(
	warning: W,
): warning is W & { annotation_id: string } => warning.annotation_id !== undefined;

/** 每个成员出现的次数，按第一次出现的顺序。 */
function counted(ids: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
	return counts;
}

/** 全部注释框的警告，按注释框在文档里的顺序；同一个注释框里先节点成员后子流程成员，按成员第一次出现的顺序。 */
export function annotationWarnings(doc: AnnotationWarningDocument): AnnotationWarning[] {
	const byId = new Map(doc.nodes.map((n) => [n.id, n]));
	const warnings: AnnotationWarning[] = [];
	for (const annotation of doc.annotations ?? []) {
		const title = annotation.title.trim();
		const label = title ? `注释框「${title}」（${annotation.id}）` : `注释框 ${annotation.id} `;
		const warn = (code: AnnotationWarningCode, message: string, target?: string) =>
			warnings.push({
				code,
				message: `${label}${message}`,
				annotation_id: annotation.id,
				...(target === undefined ? {} : { target }),
			});

		if (annotation.nodes.length + annotation.subflows.length === 0) {
			warn("annotation_no_members", "没有成员");
			continue;
		}
		for (const [id, count] of counted(annotation.nodes)) {
			const node = byId.get(id);
			if (!node) warn("annotation_unknown_node", `引用了不存在的节点 ${id}`, `nodes/${id}`);
			if (count > 1) {
				warn(
					"annotation_duplicate_member",
					`把节点 ${node ? nodeNameWithId(node) : id} 写了 ${count} 次`,
					`nodes/${id}`,
				);
			}
		}
		for (const [id, count] of counted(annotation.subflows)) {
			const entry = byId.get(id);
			if (entry?.kind !== "subflow_entry") {
				warn(
					"annotation_unknown_subflow",
					`引用了不存在的子流程 ${id}（子流程成员写子流程入口节点的节点 ID，不是子流程名称）`,
					`subflows/${id}`,
				);
			}
			if (count > 1) {
				warn(
					"annotation_duplicate_member",
					`把子流程 ${entry ? nodeNameWithId(entry) : id} 写了 ${count} 次`,
					`subflows/${id}`,
				);
			}
		}
	}
	return warnings;
}
