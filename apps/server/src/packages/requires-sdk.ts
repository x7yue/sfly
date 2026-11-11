import type { PackageMetadata } from "@sfly/schema";

/**
 * 节点包声明的最低 SDK 版本（`requires_sdk`，#79）与 Agent 版本的比较。SDK 运行时的版本等于 Agent 版本（ADR 0010）。
 * 要求的格式由 `@sfly/schema` 的 `RequiresSdk` 限定：逗号分隔的「比较符 + 数字版本号」，按 PEP 440 的语义比较，
 * 版本号位数不同时补 0（`1.0` == `1.0.0`）。最低 Agent 版本（`requires_agent`，requires-agent.ts）用同样的比较。
 */

/** 节点包的一个版本：名称和版本号（问题的说明里写明是哪个包）。 */
export interface PackageRef {
	name: string;
	version: string;
}

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

/** 版本（Agent 版本、控制面版本）是否满足要求；版本号不是纯数字（无法比较）时视为不满足。 */
export function satisfiesVersion(actual: string, requirement: string): boolean {
	const version = parse(actual);
	if (!version) return false;
	return requirement.split(",").every((raw) => {
		const match = CLAUSE.exec(raw.trim());
		const bound = match?.[2] ? parse(match[2]) : undefined;
		return match?.[1] !== undefined && bound !== undefined && holds(version, match[1], bound);
	});
}

/**
 * 派发前 Agent 版本不满足节点包的 SDK 要求时的错误信息；满足或节点包没有声明要求时返回 undefined。
 */
export function sdkRequirementProblem(
	metadata: Pick<PackageMetadata, "requires_sdk">,
	pkg: PackageRef,
	agent: { name: string; version: string },
): string | undefined {
	const requirement = metadata.requires_sdk;
	if (requirement === undefined || satisfiesVersion(agent.version, requirement)) return undefined;
	return `节点包 ${pkg.name}@${pkg.version} 需要 SDK ${requirement}，Agent ${agent.name} 的版本是 ${agent.version}：请升级 Agent`;
}

/**
 * 触发前预检的提示：比较的是控制面版本。控制面只给与自己同版本的 Agent 派任务（ADR 0014），版本不同的 Agent
 * 会先自更新到控制面的版本，所以执行时的 SDK 版本就是控制面版本；不满足时要升级的是控制面。
 */
export function controlPlaneSdkProblem(
	metadata: Pick<PackageMetadata, "requires_sdk">,
	pkg: PackageRef,
	controlPlaneVersion: string,
): string | undefined {
	const requirement = metadata.requires_sdk;
	if (requirement === undefined || satisfiesVersion(controlPlaneVersion, requirement))
		return undefined;
	return `节点包 ${pkg.name}@${pkg.version} 需要 SDK ${requirement}，控制面的版本是 ${controlPlaneVersion}：Agent 会先自更新到控制面的版本再执行任务，请升级控制面`;
}
