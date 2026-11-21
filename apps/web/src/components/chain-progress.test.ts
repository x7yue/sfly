import { NodeStatus } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { chainProgressText, chainSkippedText, doneCount } from "./chain-progress";

describe("链路进度", () => {
	it("成功与已停止的节点算已完成，其余不算", () => {
		const done = NodeStatus.options.filter((status) => doneCount([{ status }]) === 1);
		expect(done.sort()).toEqual(["stopped", "success"]);
		expect(doneCount([{ status: "success" }, { status: "running" }, { status: "skipped" }])).toBe(
			1,
		);
	});

	it("被跳过的节点不算已完成，单独计数：「1/4」「跳过 2」", () => {
		const nodes = [
			{ status: "success" },
			{ status: "failed" },
			{ status: "skipped" },
			{ status: "skipped" },
		];
		expect(chainProgressText(nodes)).toBe("1/4");
		expect(chainSkippedText(nodes)).toBe("跳过 2");
	});

	it("没有被跳过的节点时不写跳过", () => {
		expect(chainSkippedText([{ status: "success" }, { status: "running" }])).toBeNull();
	});
});
