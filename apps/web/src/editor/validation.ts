import { OrchestrationDocument } from "@sfly/schema";

/**
 * 保存前的字段校验（纯逻辑，单测见 validation.test.ts）。字段错误阻止保存——它们要么会被控制面拒绝
 * （文档不符合 OrchestrationDocument），要么会让文档有歧义（参数名重复）；静态检查的警告
 * （@sfly/orchestration 的 documentWarnings）只提示、不阻止保存，触发运行时才必须通过。
 *
 * 输入框里还没生效的值（例如在整数输入里填了 abc）不在文档里，由 field-drafts.tsx 另外记录。
 */
export interface FieldError {
	/** 出错的节点；编排级字段为 undefined。 */
	nodeId?: string;
	/** 节点内的字段路径，例如 `params.0.name`、`duration`、`inputs.steps`。 */
	field: string;
	message: string;
	/** 来自还没生效的输入（字段草稿），错误已显示在输入框下面。 */
	draft?: boolean;
}

const PARAM_NAME_MESSAGE = "参数名只能包含字母、数字和下划线，不能以数字开头";

function messageOf(path: readonly PropertyKey[], code: string, fallback: string): string {
	const last = path.at(-1);
	if (last === "name" && path.includes("params")) return PARAM_NAME_MESSAGE;
	if (code === "too_small") return "不能为空";
	return fallback;
}

export function documentFieldErrors(doc: OrchestrationDocument): FieldError[] {
	const errors: FieldError[] = [];
	const parsed = OrchestrationDocument.safeParse(doc);
	if (!parsed.success) {
		for (const issue of parsed.error.issues) {
			const [head, index, ...rest] = issue.path;
			const node = head === "nodes" && typeof index === "number" ? doc.nodes[index] : undefined;
			errors.push({
				nodeId: node?.id,
				field: (node ? rest : issue.path).map(String).join("."),
				message: messageOf(issue.path, issue.code, issue.message),
			});
		}
	}
	for (const node of doc.nodes) {
		if (node.kind !== "entry" && node.kind !== "subflow_entry") continue;
		const seen = new Set<string>();
		node.params.forEach((p, i) => {
			if (seen.has(p.name)) {
				errors.push({
					nodeId: node.id,
					field: `params.${i}.name`,
					message: `参数名 ${p.name} 重复`,
				});
			}
			seen.add(p.name);
		});
	}
	return errors;
}
