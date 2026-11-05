import type { OrchestrationDocument } from "@sfly/schema";

/**
 * secret 参数的值在日志和运行视图里替换成的掩码（docs/SEMANTICS.md §2.1：secret 参数在界面和日志中打码显示）。
 *
 * 打码按值匹配：一次运行里任何链实例（主链、子流程实例）起点声明为 secret 的参数值都是 secret 值。
 * secret 值经参数映射传进子流程时，子流程参数即使没有声明 secret，值仍是同一个字符串，照样被打码
 * （secret 属性按值传播）；子流程实例创建后，它声明的 secret 值也用于整个运行。
 */
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

/** 递归打码 JSON 值：字符串里出现的 secret 值替换成掩码；数字、布尔值等整个等于 secret 值（JSON 文本）时换成掩码。 */
export function maskDeep<T>(value: T, secrets: readonly string[]): T {
	if (secrets.length === 0) return value;
	return mask(value, secrets) as T;
}

function mask(value: unknown, secrets: readonly string[]): unknown {
	if (typeof value === "string") return maskSecrets(value, secrets);
	if (Array.isArray(value)) return value.map((item) => mask(item, secrets));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v, secrets)]));
	}
	if (value !== null && value !== undefined && secrets.includes(JSON.stringify(value))) {
		return SECRET_MASK;
	}
	return value;
}
