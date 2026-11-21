import type { OrchestrationDocument } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { countSecretPlaceholders, withoutSecretPlaceholders } from "./secret-defaults";

const document = (): OrchestrationDocument => ({
	nodes: [
		{
			id: "entry",
			kind: "entry",
			params: [
				{ name: "token", type: "string", required: false, secret: true, default: "******" },
				{ name: "fresh", type: "string", required: false, secret: true, default: "test-typed" },
				// 普通参数的默认值恰好是 ******：没有打码过，不是占位符。
				{ name: "plain", type: "string", required: false, secret: false, default: "******" },
				{ name: "none", type: "string", required: false, secret: true },
			],
		},
		{
			id: "sub",
			kind: "subflow_entry",
			params: [{ name: "key", type: "number", required: false, secret: true, default: "******" }],
		},
		{ id: "wait", kind: "package", package: "demo", node: "echo", always: false, inputs: {} },
	],
	edges: [],
	packages: {},
	annotations: [],
	sticky_notes: [],
});

describe("文档里「已设置」的敏感默认值（读取接口给的占位符）", () => {
	it("数出来：只有敏感参数的默认值是 ****** 才算，包括子流程入口", () => {
		expect(countSecretPlaceholders(document())).toBe(2);
	});

	it("去掉占位符：参数本身、新填的值、普通参数的默认值都不动", () => {
		const stripped = withoutSecretPlaceholders(document());
		expect(countSecretPlaceholders(stripped)).toBe(0);
		const params = (id: string) => {
			const node = stripped.nodes.find((n) => n.id === id);
			return node?.kind === "entry" || node?.kind === "subflow_entry" ? node.params : [];
		};
		expect(params("entry")).toMatchObject([
			{ name: "token", secret: true },
			{ name: "fresh", default: "test-typed" },
			{ name: "plain", default: "******" },
			{ name: "none" },
		]);
		expect(params("entry")[0]).not.toHaveProperty("default");
		expect(params("sub")[0]).not.toHaveProperty("default");
	});
});
