import type { PackageSummary } from "@sfly/schema";

/** 节点包版本号的比较（编辑器的升级提示、节点包页的版本排序）。 */

/**
 * 比较两个版本号（PEP 440 的核心规则）：release 段逐段数值比较（缺的段当 0，1.0 与 1.0.0 相等）；
 * 字母段是预发布标记，排在同号正式版之前（1.0rc1 < 1.0）；都是字母时按字典序。
 * 返回值 < 0 表示 a 更旧。
 */
export function compareVersions(a: string, b: string): number {
	const ta = versionTokens(a);
	const tb = versionTokens(b);
	for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
		const x = ta[i];
		const y = tb[i];
		if (x === undefined && y === undefined) break;
		if (x === undefined) {
			if (typeof y === "string") return 1;
			if (y !== 0) return -1;
			continue;
		}
		if (y === undefined) {
			if (typeof x === "string") return -1;
			if (x !== 0) return 1;
			continue;
		}
		if (typeof x === "number" && typeof y === "number") {
			if (x !== y) return x - y;
			continue;
		}
		if (typeof x === "string" && typeof y === "string") {
			if (x !== y) return x < y ? -1 : 1;
			continue;
		}
		return typeof x === "string" ? -1 : 1;
	}
	return 0;
}

/** 把版本号切成数字/字母段：`1.0rc1` → [1, 0, "rc", 1]。 */
function versionTokens(version: string): Array<number | string> {
	const tokens: Array<number | string> = [];
	for (const m of version.toLowerCase().matchAll(/\d+|[a-z]+/g)) {
		tokens.push(/^\d/.test(m[0]) ? Number(m[0]) : m[0]);
	}
	return tokens;
}

/** 节点包的最新版本（按版本号比较，不是发布时间；故事 39）。 */
export const latestVersion = (packages: PackageSummary[] | undefined, name: string) => {
	const versions = packages?.find((p) => p.name === name)?.versions;
	if (!versions || versions.length === 0) return undefined;
	return versions.reduce((a, b) => (compareVersions(a.version, b.version) >= 0 ? a : b)).version;
};
