import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, it } from "vitest";

const usesAgent = /\b(agentBinary|startRealAgent|startAgentPair)\(/;
const marked = /^describeWithAgent\(|describe\.skipIf\(!bundleDir\)/m;

it("启动真实 Agent 的测试文件都用 describeWithAgent，macOS 上才会跳过而不是失败", () => {
	const unmarked = readdirSync(import.meta.dirname).filter((name) => {
		if (!name.endsWith(".test.ts") || name === basename(import.meta.filename)) return false;
		const source = readFileSync(join(import.meta.dirname, name), "utf8");
		return usesAgent.test(source) && !marked.test(source);
	});
	expect(
		unmarked,
		"把顶层 describe 换成 support/describe-with-agent.ts 的 describeWithAgent",
	).toEqual([]);
});
