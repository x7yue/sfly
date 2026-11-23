/** 节点包版本号的比较：画布（升级提示、节点包页的版本排序、添加节点时的默认版本）和控制面（局部编辑加节点时的默认版本）共用。 */

/**
 * 比较两个版本号（不是 PEP 440 的完整规则，只取它的核心）：release 段逐段数值比较（缺的段当 0，1.0 与 1.0.0 相等）；
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

/**
 * 两个版本号谁更新，按版本号相等时（`1.0` 和 `1.0.0`）再按字符串（码位）比，结果总是确定的：排序、取最新都用它。
 * 小于 0 表示 a 更旧。命令行（sdk/python/src/sfly/cli/scenario_ops.py）同一个规则，用例表在
 * testdata/version-order-cases.json。
 */
export function compareReleases(a: string, b: string): number {
	return compareVersions(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** 一组版本号里最新的（按版本号比较，不是发布时间；相等时见 {@link compareReleases}）；没有版本时 undefined。 */
export const newestVersion = (versions: readonly string[]): string | undefined =>
	versions.reduce<string | undefined>(
		(a, b) => (a === undefined || compareReleases(b, a) > 0 ? b : a),
		undefined,
	);
