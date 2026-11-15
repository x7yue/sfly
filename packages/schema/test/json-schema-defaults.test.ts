import { describe, expect, it } from "vitest";
import { OrchestrationDocument, toJsonSchema } from "../src/index.js";

// 导出的 JSON Schema 里，入口和子流程入口的参数列表带 `"default": []`：没写时等于空列表，和 zod 的默认值一致。
// 参数声明里有「去掉首尾空白」的转换，zod 导出时会把外层的 `.default` 当成只属于输出而丢掉，所以这里把它钉住。

interface NodeSchema {
	properties: { kind: { const: string }; params?: { default?: unknown } };
}

const nodeSchemas = (): NodeSchema[] => {
	const document = toJsonSchema(OrchestrationDocument) as {
		properties: { nodes: { items: { oneOf?: NodeSchema[]; anyOf?: NodeSchema[] } } };
	};
	const { items } = document.properties.nodes;
	return items.oneOf ?? items.anyOf ?? [];
};
const paramsDefault = (kind: string) =>
	nodeSchemas().find((n) => n.properties.kind.const === kind)?.properties.params?.default;

describe("场景文档的 JSON Schema 里 params 的默认值", () => {
	it("入口和子流程入口的参数列表默认是空列表", () => {
		expect(paramsDefault("entry")).toEqual([]);
		expect(paramsDefault("subflow_entry")).toEqual([]);
	});

	it("异步任务节点的参数映射默认是空对象", () => {
		expect(paramsDefault("async")).toEqual({});
	});

	it("zod 解析时的默认值和导出的一致", () => {
		const parsed = OrchestrationDocument.parse({
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "sub", kind: "subflow_entry" },
			],
			edges: [],
		});
		expect(parsed.nodes.map((n) => ("params" in n ? n.params : null))).toEqual([[], []]);
	});
});
