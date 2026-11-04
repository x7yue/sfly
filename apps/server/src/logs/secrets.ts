import type { OrchestrationDocument } from "@sfly/schema";

/** secret 参数的值在日志里替换成的掩码（docs/SEMANTICS.md：secret 参数在界面和日志中打码显示）。 */
export const SECRET_MASK = "******";

/**
 * 一次运行中所有 secret 参数的值（文本形式）：每个链实例起点（入口 / 子流程入口节点）声明为 secret 的参数。
 * 非字符串的值按 JSON 文本匹配；空串不算。按长度从长到短排列，替换时先替换长的。
 */
export function secretValues(
	document: OrchestrationDocument,
	chains: ReadonlyArray<{ chainId: string; params: Record<string, unknown> }>,
): string[] {
	const values = new Set<string>();
	for (const chain of chains) {
		const start = document.nodes.find((n) => n.id === chain.chainId);
		if (!start || (start.kind !== "entry" && start.kind !== "subflow_entry")) continue;
		for (const param of start.params) {
			if (!param.secret) continue;
			const value = chain.params[param.name];
			if (value === undefined || value === null) continue;
			const text = typeof value === "string" ? value : JSON.stringify(value);
			if (text) values.add(text);
		}
	}
	return [...values].sort((a, b) => b.length - a.length);
}

/** 把文本中出现的 secret 值替换成掩码。 */
export function maskSecrets(text: string, secrets: readonly string[]): string {
	let masked = text;
	for (const secret of secrets) {
		if (masked.includes(secret)) masked = masked.split(secret).join(SECRET_MASK);
	}
	return masked;
}
