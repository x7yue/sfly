// biome 偶发工作区竞态的重试（support/biome-lint.ts，#582）：只对那一种内部错误重跑，别的原样返回。
import { describe, expect, it } from "vitest";
import {
	type BiomeDiagnostic,
	isWorkspaceRace,
	retryOnWorkspaceRace,
	WORKSPACE_RACE_ATTEMPTS,
} from "./support/biome-lint.js";

const race: BiomeDiagnostic = {
	category: "internalError/fs",
	message: "The file does not exist in the workspace.",
};
const raceWithPath: BiomeDiagnostic = {
	category: "internalError/fs",
	message: "The file /tmp/x/a.ts does not exist in the workspace.",
};
const plugin: BiomeDiagnostic = { category: "plugin", message: "pi 只能在 apps/assistant 里引入" };

/** 按顺序给出每次调用的诊断，并数调用了几次。 */
function script(...results: BiomeDiagnostic[][]) {
	let calls = 0;
	return {
		run: () => {
			const diagnostics = results[Math.min(calls, results.length - 1)] ?? [];
			calls++;
			return { diagnostics, files: 3 };
		},
		calls: () => calls,
	};
}

describe("biome 偶发工作区竞态的重试", () => {
	it("认得竞态的诊断：新旧两种写法（带路径、不带路径）", () => {
		expect(isWorkspaceRace(race)).toBe(true);
		expect(isWorkspaceRace(raceWithPath)).toBe(true);
	});

	it("不认别的：规则的诊断、别的内部错误、同类别但原因不同的错误", () => {
		expect(isWorkspaceRace(plugin)).toBe(false);
		expect(isWorkspaceRace({ category: "internalError/io", message: "disk full" })).toBe(false);
		expect(isWorkspaceRace({ category: "internalError/fs", message: "permission denied" })).toBe(
			false,
		);
		expect(isWorkspaceRace({ category: "parse", message: "does not exist in the workspace" })).toBe(
			false,
		);
	});

	it("第一次就干净：只跑一次，原样返回", () => {
		const s = script([plugin]);

		const result = retryOnWorkspaceRace(s.run);

		expect(result).toEqual({ diagnostics: [plugin], files: 3 });
		expect(s.calls()).toBe(1);
	});

	it("碰上竞态：重跑，返回干净的那一次的结果（竞态的诊断不在里面）", () => {
		const s = script([race], [raceWithPath], [plugin]);

		const result = retryOnWorkspaceRace(s.run);

		expect(result.diagnostics).toEqual([plugin]);
		expect(s.calls()).toBe(3);
	});

	it("规则的诊断和语法错误不重试：规则写坏了、样例有错都原样报出来", () => {
		const syntax: BiomeDiagnostic = { category: "parse", message: "unexpected token" };
		const s = script([plugin, syntax], []);

		const result = retryOnWorkspaceRace(s.run);

		expect(result.diagnostics).toEqual([plugin, syntax]);
		expect(s.calls()).toBe(1);
	});

	it("别的内部错误不重试", () => {
		const other: BiomeDiagnostic = { category: "internalError/io", message: "disk full" };
		const s = script([other], []);

		expect(retryOnWorkspaceRace(s.run).diagnostics).toEqual([other]);
		expect(s.calls()).toBe(1);
	});

	it("竞态的诊断和规则的诊断同时出现：重跑，只认干净的那一次", () => {
		const s = script([race, plugin], [plugin]);

		expect(retryOnWorkspaceRace(s.run).diagnostics).toEqual([plugin]);
		expect(s.calls()).toBe(2);
	});

	it("连着碰上：次数用完抛出，写明重试了几次、最后的诊断（不会无限重试，也不会悄悄放过）", () => {
		const s = script([race]);

		expect(() => retryOnWorkspaceRace(s.run)).toThrow(
			new RegExp(`连续 ${WORKSPACE_RACE_ATTEMPTS} 次报 internalError/fs[\\s\\S]*does not exist`),
		);
		expect(s.calls()).toBe(WORKSPACE_RACE_ATTEMPTS);
	});

	it("次数可以指定", () => {
		const s = script([race], [race], [plugin]);

		expect(() => retryOnWorkspaceRace(s.run, 2)).toThrow(/连续 2 次/);
		expect(s.calls()).toBe(2);
		expect(retryOnWorkspaceRace(script([race], [race], [plugin]).run, 3).diagnostics).toEqual([
			plugin,
		]);
	});
});
