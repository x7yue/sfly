// PEP 440 版本号的规范化（包索引里 wheel 文件名里的版本和归档登记的版本要比对，#556）。
import { describe, expect, it } from "vitest";
import { canonicalVersion, sameVersion } from "../src/packages/pep440.js";

describe("canonicalVersion", () => {
	it.each([
		["0.4.0", "0.4"],
		["1.0", "1"],
		["1.2.3", "1.2.3"],
		["01.02.03", "1.2.3"],
		["v1.2.3", "1.2.3"],
		["0.4.0-beta.1", "0.4b1"],
		["0.4.0b1", "0.4b1"],
		["0.4.0ALPHA", "0.4a0"],
		["1.0rc2", "1rc2"],
		["1.0.preview3", "1rc3"],
		["1.0-1", "1.post1"],
		["1.0.post2", "1.post2"],
		["1.0.rev", "1.post0"],
		["1.0.dev3", "1.dev3"],
		["1.0a1.post2.dev3", "1a1.post2.dev3"],
		["2!1.0", "2!1"],
		["1.0+Local_1-2", "1+local.1.2"],
	])("%s 规范化成 %s", (version, expected) => {
		expect(canonicalVersion(version)).toBe(expected);
	});

	it.each([
		"",
		"abc",
		"1..2",
		"1.0.0.",
		"dev",
		"1.0+",
		"0.4.0 beta",
		"1.0.0-x",
	])("%j 不是合法的版本号", (version) => {
		expect(canonicalVersion(version)).toBeUndefined();
	});
});

describe("sameVersion", () => {
	it("写法不同的同一个版本相同", () => {
		expect(sameVersion("0.4.0", "0.4")).toBe(true);
		expect(sameVersion("0.4.0-beta.1", "0.4.0b1")).toBe(true);
	});

	it("不同的版本不同；不合法的版本和任何版本都不同", () => {
		expect(sameVersion("0.6.0", "7.0.0")).toBe(false);
		expect(sameVersion("0.4.0", "0.4.1")).toBe(false);
		expect(sameVersion("0.4.0", "0.4.0b1")).toBe(false);
		expect(sameVersion("abc", "abc")).toBe(false);
	});
});
