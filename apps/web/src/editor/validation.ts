import {
	blocksTrigger,
	nodeNameWithId,
	nodeTypeOf,
	type PackageCatalog,
	type WarningShape,
} from "@sfly/orchestration";
import {
	isRemovedNodeKind,
	OrchestrationDocument,
	REMOVED_NODE_KINDS,
	type StoredOrchestrationDocument,
} from "@sfly/schema";

/**
 * 保存前的字段校验（纯逻辑，单测见 validation.test.ts）。字段错误阻止保存——它们要么会被控制面拒绝
 * （文档不符合 OrchestrationDocument，含已移除种类的节点，ADR 0028），要么会让文档有歧义（参数名重复）；静态检查的警告
 * （@sfly/orchestration 的 documentWarnings）只提示、不阻止保存，触发运行时才必须通过。
 *
 * 输入框里还没生效的值（例如在整数输入里填了 abc）不在文档里，由 field-drafts.tsx 另外记录。
 */
interface FieldErrorAt {
	/** 节点（或注释框）内的字段路径，例如 `params.0.name`、`duration`、`inputs.steps`、`title`。 */
	field: string;
	message: string;
	/** 来自还没生效的输入（字段草稿），错误已显示在输入框下面。 */
	draft?: boolean;
	/** 来自边输入边改的文本框：输入到一半多半还不合法，字段交互过才给用户看（field-drafts.tsx）。 */
	typed?: boolean;
}

/**
 * 字段错误出在哪个对象上，四选一：节点（`nodeId`）、注释框（`annotationId`，标题、备注）、
 * 便签（`stickyId`，标题、正文），或者都没有（场景级字段）。三个 ID 至多一个不是 undefined。
 */
export type FieldError = FieldErrorAt &
	(
		| { nodeId: string; annotationId?: undefined; stickyId?: undefined }
		| { annotationId: string; nodeId?: undefined; stickyId?: undefined }
		| { stickyId: string; nodeId?: undefined; annotationId?: undefined }
		| { nodeId?: undefined; annotationId?: undefined; stickyId?: undefined }
	);

const TYPED_FIELD = /^params\.\d+\.name$/;

const PARAM_NAME_MESSAGE = "参数名只能包含字母、数字和下划线，不能以数字开头";

function messageOf(path: readonly PropertyKey[], code: string, fallback: string): string {
	const last = path.at(-1);
	if (last === "name" && path.includes("params")) return PARAM_NAME_MESSAGE;
	if (code === "too_small") return "不能为空";
	return fallback;
}

export function documentFieldErrors(doc: StoredOrchestrationDocument): FieldError[] {
	const errors: FieldError[] = [];
	// 已移除种类的节点不在可以保存的文档里：另外报错，其余节点照常按 OrchestrationDocument 检查
	//（issue 的路径按去掉它们之后的位置算）。
	const kept = doc.nodes.filter((n) => !isRemovedNodeKind(n.kind));
	for (const node of doc.nodes) {
		if (!isRemovedNodeKind(node.kind)) continue;
		errors.push({
			nodeId: node.id,
			field: "kind",
			message: `已不再支持，不能保存。替换办法：${REMOVED_NODE_KINDS[node.kind].replacement}`,
		});
	}
	const parsed = OrchestrationDocument.safeParse({ ...doc, nodes: kept });
	if (!parsed.success) {
		for (const issue of parsed.error.issues) {
			const [head, index, ...rest] = issue.path;
			const at = typeof index === "number" ? index : -1;
			const node = head === "nodes" ? kept[at] : undefined;
			const annotation = head === "annotations" ? doc.annotations[at] : undefined;
			const sticky = head === "sticky_notes" ? doc.sticky_notes[at] : undefined;
			const field = (node || annotation || sticky ? rest : issue.path).map(String).join(".");
			const error = {
				field,
				message: messageOf(issue.path, issue.code, issue.message),
				typed: TYPED_FIELD.test(field),
			};
			if (node) errors.push({ ...error, nodeId: node.id });
			else if (annotation) errors.push({ ...error, annotationId: annotation.id });
			else if (sticky) errors.push({ ...error, stickyId: sticky.id });
			else errors.push(error);
		}
	}
	for (const node of kept) {
		if (node.kind !== "entry" && node.kind !== "subflow_entry") continue;
		const seen = new Set<string>();
		node.params.forEach((p, i) => {
			if (seen.has(p.name)) {
				errors.push({
					nodeId: node.id,
					field: `params.${i}.name`,
					message: `参数名 ${p.name} 重复`,
					typed: true,
				});
			}
			seen.add(p.name);
		});
	}
	return errors;
}

/** 一条提醒：节点、输入名与显示的文字（检查器「检查」一节逐条列出，可以「前往」节点）。 */
export interface InputNote {
	node_id: string;
	input: string;
	message: string;
}

/**
 * 提醒：包节点上填了、但节点类型没有声明的输入（通常是节点包升级后删掉了这个输入）。
 * 不阻止保存与触发，节点类型还没加载完时不算。检查器的「参数」页可以逐个移除。
 */
export function undeclaredInputNotes(
	doc: StoredOrchestrationDocument,
	catalog: PackageCatalog,
): InputNote[] {
	const notes: InputNote[] = [];
	for (const node of doc.nodes) {
		if (node.kind !== "package") continue;
		const type = nodeTypeOf(doc, node, catalog);
		if (!type) continue;
		for (const input of Object.keys(node.inputs)) {
			if (!type.inputs.properties[input]) {
				notes.push({
					node_id: node.id,
					input,
					message: `${nodeNameWithId(node)} 的输入 ${input} 没有在节点类型中声明`,
				});
			}
		}
	}
	return notes;
}

/**
 * 编辑器顶栏与检查器「检查」标题旁的检查结果，唯一的判断来源：字段错误（不能保存）最先，
 * 然后是警告，没有警告时带上提醒条数。
 */
export function checkSummary(
	fieldErrors: number,
	warnings: number,
	notes: number,
): { kind: "failed" | "warn" | "ok"; label: string } {
	if (fieldErrors > 0) return { kind: "failed", label: `${fieldErrors} 处字段错误` };
	if (warnings > 0) return { kind: "warn", label: `${warnings} 条警告` };
	return { kind: "ok", label: notes > 0 ? `检查通过 · ${notes} 条提醒` : "检查通过" };
}

/** 保存成功后提示里对警告的说明：注释框的警告不影响触发运行（blocksTrigger），其余要在触发运行前处理。 */
export function warningsSummary(warnings: readonly WarningShape[]): string {
	const blocking = warnings.filter(blocksTrigger).length;
	if (blocking === 0) return `${warnings.length} 条警告，不影响触发运行`;
	if (blocking === warnings.length) return `${warnings.length} 条警告，触发运行前需要处理`;
	return `${warnings.length} 条警告，其中 ${blocking} 条触发运行前需要处理`;
}
