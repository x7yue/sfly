import type { OrchestrationDocument, ParamDeclaration } from "@sfly/schema";
import type { z } from "zod";
import { matchesParamType } from "../engine/params.js";

type Declaration = z.infer<typeof ParamDeclaration>;

/**
 * 预设参数和最新版本对不上的一处（GLOSSARY「失效的运行预设」）：`missing` 是参数已不存在（被删除或改名），
 * `type_mismatch` 是保存的值不符合它现在的类型。
 */
export interface PresetProblem {
	param: string;
	reason: "missing" | "type_mismatch";
}

/** 场景版本入口节点的参数声明；没有入口节点时为空。 */
export function entryParams(document: OrchestrationDocument): Declaration[] {
	const entry = document.nodes.find((n) => n.kind === "entry");
	return entry?.kind === "entry" ? entry.params : [];
}

/**
 * 运行预设对照最新版本入口节点的参数声明是否可用（ADR 0023「按参数名称取值，只对照最新版本」）：
 * 按预设参数的顺序列出对不上的地方，空表示可用。类型检查与触发时补参数相同（不做类型转换，`json` 接受任何值）。
 * 最新版本新增的参数不算问题，默认值、是否必填、是否敏感也不参与判断。
 * 新建预设、触发、预设清单和保存版本时的警告都用它，不各写一套。
 */
export function presetProblems(
	values: Record<string, unknown>,
	declarations: readonly Declaration[],
): PresetProblem[] {
	const declared = new Map(declarations.map((d) => [d.name, d]));
	const problems: PresetProblem[] = [];
	for (const [param, value] of Object.entries(values)) {
		const decl = declared.get(param);
		if (!decl) problems.push({ param, reason: "missing" });
		else if (!matchesParamType(decl.type, value)) problems.push({ param, reason: "type_mismatch" });
	}
	return problems;
}
