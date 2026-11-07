import { NodeStatus } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { doneCount } from "./chain-progress";

describe("链路进度", () => {
	it("成功、跳过与已停止的节点算已完成，其余不算", () => {
		const done = NodeStatus.options.filter((status) => doneCount([{ status }]) === 1);
		expect(done.sort()).toEqual(["skipped", "stopped", "success"]);
		expect(doneCount([{ status: "success" }, { status: "running" }, { status: "skipped" }])).toBe(
			2,
		);
	});
});
