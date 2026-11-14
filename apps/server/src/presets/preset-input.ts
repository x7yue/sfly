import type { ParamDeclaration, PresetParamInput } from "@sfly/schema";
import type { z } from "zod";
import { presetProblems } from "./preset-validity.js";

type Declaration = z.infer<typeof ParamDeclaration>;

/**
 * `invalid_preset` 的 details 里的一项：和请求校验失败时的 zod issue 同一种格式，
 * `path` 指出字段（如 `["body", "params", 0, "value"]`），`message` 写明原因。
 */
export interface PresetIssue {
	code: "custom";
	path: Array<string | number>;
	message: string;
}

/**
 * 新建（以及修改时给了 `params`）运行预设时，对照最新版本入口节点的参数声明检查预设参数的完整清单
 * （docs/SEMANTICS.md §6「运行预设」）：至少一个；不重复；已声明且符合类型（{@link presetProblems}）；
 * 有值，字符串不为空。secret 参数这一版还不能设为预设参数。通过时返回「参数名 → 值」。
 */
export function checkPresetParams(
	params: readonly PresetParamInput[],
	declarations: readonly Declaration[],
): { values: Record<string, unknown> } | { issues: PresetIssue[] } {
	const issues: PresetIssue[] = [];
	const at = (path: Array<string | number>, message: string) =>
		issues.push({ code: "custom", path: ["body", "params", ...path], message });
	if (declarations.length === 0) {
		at([], "入口节点没有声明参数，不能新建运行预设");
		return { issues };
	}
	if (params.length === 0) {
		at([], "至少要有一个预设参数");
		return { issues };
	}
	const declared = new Map(declarations.map((d) => [d.name, d]));
	const values: Record<string, unknown> = {};
	const seen = new Set<string>();
	params.forEach(({ name, value }, i) => {
		if (seen.has(name)) {
			at([i, "name"], `参数 ${name} 重复了`);
			return;
		}
		seen.add(name);
		const decl = declared.get(name);
		const [problem] = presetProblems({ [name]: value }, declarations);
		if (!decl) at([i, "name"], `参数 ${name} 没有声明`);
		else if (decl.secret) at([i, "name"], `参数 ${name} 是 secret 参数，暂不支持设为预设参数`);
		else if (value === undefined || value === null) at([i, "value"], `参数 ${name} 要填一个值`);
		else if (problem?.reason === "type_mismatch") {
			at([i, "value"], `参数 ${name} 的值必须是 ${decl.type} 类型`);
		} else if (typeof value === "string" && value.trim() === "") {
			at([i, "value"], `参数 ${name} 不能为空`);
		} else values[name] = value;
	});
	return issues.length > 0 ? { issues } : { values };
}
