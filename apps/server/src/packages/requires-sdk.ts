import type { PackageMetadata } from "@sfly/schema";

/**
 * 节点包声明的最低 SDK 版本（`requires_sdk`，#79）与 Agent 版本的比较。SDK 运行时的版本等于 Agent 版本（ADR 0010）。
 * 要求的格式由 `@sfly/schema` 的 `RequiresSdk` 限定：逗号分隔的「比较符 + 数字版本号」，按 PEP 440 的语义比较，
 * 版本号位数不同时补 0（`1.0` == `1.0.0`）。
 */

const CLAUSE = /^(~=|==|!=|<=|>=|<|>)\s*([0-9]+(?:\.[0-9]+)*)$/;

function parse(version: string): number[] | undefined {
	return /^[0-9]+(?:\.[0-9]+)*$/.test(version) ? version.split(".").map(Number) : undefined;
}

function compare(a: number[], b: number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d !== 0) return Math.sign(d);
	}
	return 0;
}

function holds(version: number[], op: string, bound: number[]): boolean {
	const c = compare(version, bound);
	switch (op) {
		case ">=":
			return c >= 0;
		case ">":
			return c > 0;
		case "<=":
			return c <= 0;
		case "<":
			return c < 0;
		case "==":
			return c === 0;
		case "!=":
			return c !== 0;
		default: {
			// `~=X.Y.Z`：>= X.Y.Z 且前缀 X.Y 相同（PEP 440 的兼容版本）。
			const prefix = bound.slice(0, Math.max(bound.length - 1, 1));
			return c >= 0 && compare(version.slice(0, prefix.length), prefix) === 0;
		}
	}
}

/** Agent 版本是否满足要求；版本号不是纯数字（无法比较）时视为不满足。 */
export function satisfiesSdk(agentVersion: string, requirement: string): boolean {
	const version = parse(agentVersion);
	if (!version) return false;
	return requirement.split(",").every((raw) => {
		const match = CLAUSE.exec(raw.trim());
		const bound = match?.[2] ? parse(match[2]) : undefined;
		return match?.[1] !== undefined && bound !== undefined && holds(version, match[1], bound);
	});
}

/**
 * 节点包的 SDK 要求不满足时的提示（派发失败和触发前预检共用）；满足或节点包没有声明要求时返回 undefined。
 */
export function sdkRequirementProblem(
	metadata: Pick<PackageMetadata, "requires_sdk">,
	pkg: { name: string; version: string },
	agent: { name: string; version: string },
): string | undefined {
	const requirement = metadata.requires_sdk;
	if (requirement === undefined || satisfiesSdk(agent.version, requirement)) return undefined;
	return `节点包 ${pkg.name}@${pkg.version} 需要 SDK ${requirement}，Agent ${agent.name} 的版本是 ${agent.version}：请升级 Agent`;
}
