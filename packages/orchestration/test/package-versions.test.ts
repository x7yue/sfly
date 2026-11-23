// 版本号的先后：用例在共用用例表 testdata/version-order-cases.json 里，命令行（Python）读同一张表。
import { describe, expect, it } from "vitest";
import table from "../../../testdata/version-order-cases.json" with { type: "json" };
import { compareReleases, compareVersions, newestVersion } from "../src/package-versions.js";

const cases = table as unknown as {
	older_newer: [string, string][];
	equal: [string, string][];
	newest: { versions: string[]; newest: string | null }[];
};

describe("共用用例表 testdata/version-order-cases.json", () => {
	it.each(cases.older_newer)("%s 比 %s 旧", (older, newer) => {
		expect(compareVersions(older, newer)).toBeLessThan(0);
		expect(compareVersions(newer, older)).toBeGreaterThan(0);
	});

	it.each(cases.equal)("%s 和 %s 按版本号相等，按字符串分出先后", (a, b) => {
		expect(compareVersions(a, b)).toBe(0);
		expect(Math.sign(compareReleases(a, b))).toBe(a < b ? -1 : 1);
	});

	it.each(cases.newest)("最新的：$versions → $newest", ({ versions, newest }) => {
		expect(newestVersion(versions) ?? null).toBe(newest);
	});
});
