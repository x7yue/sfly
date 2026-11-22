// PEP 440 版本号的规范化和相等比较（包索引里 wheel 文件名里的版本和归档登记的版本要比对，#556）。
// 判断「是不是同一个版本」的用例在共用用例表 testdata/pep440-cases.json 里：Python 的 `packaging` 是参照
// （sdk/python/tests/test_pep440_cases.py 用它检查这张表），这里的实现要和它一致。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalVersion, sameVersion } from "../src/packages/pep440.js";

const CASES = JSON.parse(
	readFileSync(new URL("../../../testdata/pep440-cases.json", import.meta.url), "utf8"),
) as { equal: string[][]; different: Array<[string, string]>; invalid: string[] };

describe("共用用例表 testdata/pep440-cases.json", () => {
	it.each(
		CASES.equal.map((group) => [group.join(" = "), group] as const),
	)("同一个版本：%s", (_name, group) => {
		const canonical = group.map((version) => canonicalVersion(version));
		expect(new Set(canonical).size, JSON.stringify(canonical)).toBe(1);
		expect(canonical[0]).toBeDefined();
		for (const a of group) for (const b of group) expect(sameVersion(a, b), `${a} ${b}`).toBe(true);
	});

	it.each(
		CASES.different.map(([a, b]) => [`${a} ≠ ${b}`, a, b] as const),
	)("不同的版本：%s", (_name, a, b) => {
		expect(canonicalVersion(a)).toBeDefined();
		expect(canonicalVersion(b)).toBeDefined();
		expect(sameVersion(a, b)).toBe(false);
	});

	it.each(
		CASES.invalid.map((version) => [JSON.stringify(version), version] as const),
	)("不是合法的版本号：%s", (_name, version) => {
		expect(canonicalVersion(version)).toBeUndefined();
		// 不合法的版本和任何版本（包括它自己）都不同。
		expect(sameVersion(version, version)).toBe(false);
	});
});

describe("canonicalVersion 的写法", () => {
	it.each([
		["0.4.0", "0.4"],
		["1.0", "1"],
		["01.02.03", "1.2.3"],
		["0.4.0-beta.1", "0.4b1"],
		["1.0.preview3", "1rc3"],
		["1.0-1", "1.post1"],
		["1.0.rev", "1.post0"],
		["1.0a1.post2.dev3", "1a1.post2.dev3"],
		["2!1.0", "2!1"],
		["1.0+Local_1-2", "1+local.1.2"],
		["1.0+01", "1+1"],
		["1.0.9007199254740993", "1.0.9007199254740993"],
		["1.0.0009007199254740993", "1.0.9007199254740993"],
	])("%s 规范化成 %s", (version, expected) => {
		expect(canonicalVersion(version)).toBe(expected);
	});
});
