// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import type { OrchestrationDocument, OrchestrationNode } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	type CopiedNode,
	copiedNodeText,
	copyProblem,
	duplicateNode,
	placeCopy,
	readCopiedNode,
} from "../src/index.js";

const fetch: OrchestrationNode = {
	id: "fetch",
	kind: "package",
	package: "demo-checks",
	node: "http_check",
	agent: "agent-b",
	always: true,
	timeout: 30,
	retries: 2,
	position: { x: 252, y: 0 },
	inputs: { url: "https://example.test", note: "${{ params.biz_date }}" },
};

const source: OrchestrationDocument = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", position: { x: 0, y: 0 }, params: [] },
		fetch,
		{ id: "sub", kind: "subflow_entry", name: "子流程", position: { x: 0, y: 300 }, params: [] },
		{ id: "sleep_1", kind: "sleep", always: false, duration: "30s", position: { x: 504, y: 0 } },
	],
	edges: [
		{ from: "entry", to: "fetch", kind: "chain" },
		{ from: "fetch", to: "sleep_1", kind: "chain" },
	],
	packages: { "demo-checks": "1.2.0" },
};

const target: OrchestrationDocument = {
	nodes: [{ id: "entry", kind: "entry", position: { x: 0, y: 0 }, params: [] }],
	edges: [],
	packages: {},
};

function copied(doc: OrchestrationDocument, id: string): CopiedNode {
	const text = copiedNodeText(doc, id);
	if (!text.ok) throw new Error(`不能复制：${text.reason}`);
	const read = readCopiedNode(text.text);
	if (!read) throw new Error("读不出复制的节点");
	return read;
}

function placed<T extends { ok: boolean }>(edit: T): Extract<T, { ok: true }> {
	if (!edit.ok) throw new Error(`被拒绝：${(edit as { reason?: string }).reason}`);
	return edit as Extract<T, { ok: true }>;
}

const nodeOf = (doc: OrchestrationDocument, id: string) => doc.nodes.find((n) => n.id === id);

describe("复制到剪贴板的内容", () => {
	it("是带类型标记的 JSON：节点本身（不含位置），包节点带上锁定的版本", () => {
		const text = copiedNodeText(source, "fetch");
		if (!text.ok) throw new Error(text.reason);
		const { position: _, ...node } = fetch;
		expect(JSON.parse(text.text)).toEqual({
			type: "sfly/node",
			node,
			package: { name: "demo-checks", version: "1.2.0" },
		});
	});

	it("内置节点没有包版本", () => {
		const text = copiedNodeText(source, "sleep_1");
		if (!text.ok) throw new Error(text.reason);
		expect(JSON.parse(text.text)).toEqual({
			type: "sfly/node",
			node: { id: "sleep_1", kind: "sleep", always: false, duration: "30s" },
		});
	});

	it("入口节点和子流程入口节点不能复制；节点不存在时拒绝", () => {
		expect(copyProblem({ kind: "entry" })).toBe("入口节点不能复制或创建副本");
		expect(copyProblem({ kind: "subflow_entry" })).toBe("子流程入口节点不能复制或创建副本");
		expect(copyProblem({ kind: "package" })).toBeNull();
		expect(copiedNodeText(source, "entry")).toEqual({
			ok: false,
			reason: "入口节点不能复制或创建副本",
		});
		expect(copiedNodeText(source, "sub")).toEqual({
			ok: false,
			reason: "子流程入口节点不能复制或创建副本",
		});
		expect(copiedNodeText(source, "nope")).toEqual({ ok: false, reason: "节点 nope 不存在" });
	});
});

describe("读剪贴板里的节点", () => {
	it("读回复制的节点和包版本", () => {
		const read = copied(source, "fetch");
		expect(read.packageVersion).toBe("1.2.0");
		expect(read.node).toMatchObject({ id: "fetch", kind: "package", inputs: fetch.inputs });
	});

	it("不是节点、类型标记不对、结构不合法时得到 null", () => {
		const node = { id: "x", kind: "sleep", duration: "1s" };
		for (const text of [
			"",
			"hello",
			"fetch",
			"null",
			"[]",
			JSON.stringify({ node }),
			JSON.stringify({ type: "other", node }),
			JSON.stringify({ type: "sfly/node" }),
			JSON.stringify({ type: "sfly/node", node: { ...node, duration: "" } }),
			JSON.stringify({ type: "sfly/node", node: { ...node, kind: "nope" } }),
			JSON.stringify({ type: "sfly/node", node: { ...node, extra: 1 } }),
			// 入口节点不能粘贴。
			JSON.stringify({ type: "sfly/node", node: { id: "e", kind: "entry", params: [] } }),
			// 包版本必须与节点的包一致。
			JSON.stringify({
				type: "sfly/node",
				node: { id: "p", kind: "package", package: "a", node: "n" },
				package: { name: "b", version: "1.0.0" },
			}),
			JSON.stringify({
				type: "sfly/node",
				node: { id: "p", kind: "package", package: "a", node: "n" },
				package: { name: "a", version: "" },
			}),
		]) {
			expect(readCopiedNode(text), text).toBeNull();
		}
		expect(readCopiedNode(JSON.stringify({ type: "sfly/node", node }))).not.toBeNull();
	});
});

describe("粘贴", () => {
	it("新节点放在给定位置，参数、Agent、执行设置都相同，ID 是新的，不带连线", () => {
		const edit = placed(placeCopy(source, copied(source, "fetch"), { x: 40, y: 500 }));
		expect(edit.id).toBe("fetch_1");
		const { id: _, position: __, ...rest } = fetch;
		expect(nodeOf(edit.doc, "fetch_1")).toEqual({
			...rest,
			id: "fetch_1",
			position: { x: 40, y: 500 },
		});
		expect(edit.doc.edges).toEqual(source.edges);
		expect(edit.doc.nodes.slice(0, -1)).toEqual(source.nodes);
	});

	it("新 ID 去掉原 ID 末尾的序号再编号，不与已有节点重复", () => {
		expect(placed(placeCopy(source, copied(source, "sleep_1"), { x: 0, y: 0 })).id).toBe("sleep_2");
		const twice = placed(placeCopy(source, copied(source, "fetch"), { x: 0, y: 0 })).doc;
		expect(placed(placeCopy(twice, copied(source, "fetch"), { x: 0, y: 0 })).id).toBe("fetch_2");
	});

	it("参数里的引用原样保留（静态检查照常给出警告）", () => {
		const edit = placed(placeCopy(target, copied(source, "fetch"), { x: 0, y: 0 }));
		const pasted = nodeOf(edit.doc, edit.id);
		expect(pasted?.kind === "package" && pasted.inputs.note).toBe("${{ params.biz_date }}");
	});

	it("目标场景没锁定这个节点包：带上原来的版本", () => {
		const edit = placed(placeCopy(target, copied(source, "fetch"), { x: 0, y: 0 }));
		expect(edit.doc.packages).toEqual({ "demo-checks": "1.2.0" });
	});

	it("目标场景已锁定别的版本：用目标场景的版本", () => {
		const locked = { ...target, packages: { "demo-checks": "1.3.0", other: "0.1.0" } };
		const edit = placed(placeCopy(locked, copied(source, "fetch"), { x: 0, y: 0 }));
		expect(edit.doc.packages).toEqual({ "demo-checks": "1.3.0", other: "0.1.0" });
	});

	it("内置节点不改包版本锁定；入口节点不能粘贴", () => {
		const edit = placed(placeCopy(target, copied(source, "sleep_1"), { x: 0, y: 0 }));
		expect(edit.doc.packages).toEqual({});
		const entry: CopiedNode = { node: { id: "e", kind: "entry", params: [] } };
		expect(placeCopy(target, entry, { x: 0, y: 0 })).toEqual({
			ok: false,
			reason: "入口节点不能复制或创建副本",
		});
	});

	it("不改动传入的文档", () => {
		const before = JSON.parse(JSON.stringify(target));
		placeCopy(target, copied(source, "fetch"), { x: 0, y: 0 });
		expect(target).toEqual(before);
	});
});

describe("显示名称随节点一起复制", () => {
	const named: OrchestrationDocument = {
		...source,
		nodes: source.nodes.map((n) => (n.id === "fetch" ? { ...n, display_name: "创建测试用户" } : n)),
	};

	it("复制的内容、粘贴和创建副本的节点都带着显示名称，名称不加后缀", () => {
		const text = copiedNodeText(named, "fetch");
		if (!text.ok) throw new Error(text.reason);
		expect(JSON.parse(text.text).node.display_name).toBe("创建测试用户");

		const pasted = placed(placeCopy(target, copied(named, "fetch"), { x: 40, y: 40 }));
		expect(nodeOf(pasted.doc, pasted.id)).toMatchObject({ display_name: "创建测试用户" });

		const copy = placed(duplicateNode(named, "fetch", { x: 0, y: 200 }));
		expect(nodeOf(copy.doc, copy.id)).toMatchObject({ display_name: "创建测试用户" });
		expect(copy.id).not.toBe("fetch");
	});

	it("没有显示名称的节点复制出来也没有", () => {
		const copy = placed(duplicateNode(source, "fetch", { x: 0, y: 200 }));
		expect(nodeOf(copy.doc, copy.id)).not.toHaveProperty("display_name");
	});
});

describe("创建副本", () => {
	it("同一场景里得到相同内容、新 ID、不带连线的节点", () => {
		const edit = placed(duplicateNode(source, "fetch", { x: 284, y: 32 }));
		expect(edit.id).toBe("fetch_1");
		const { id: _, position: __, ...rest } = fetch;
		expect(nodeOf(edit.doc, "fetch_1")).toEqual({
			...rest,
			id: "fetch_1",
			position: { x: 284, y: 32 },
		});
		expect(edit.doc.edges).toEqual(source.edges);
		expect(edit.doc.packages).toEqual(source.packages);
	});

	it("入口节点、子流程入口节点不能创建副本；节点不存在时拒绝", () => {
		expect(duplicateNode(source, "entry", { x: 0, y: 0 })).toEqual({
			ok: false,
			reason: "入口节点不能复制或创建副本",
		});
		expect(duplicateNode(source, "sub", { x: 0, y: 0 })).toEqual({
			ok: false,
			reason: "子流程入口节点不能复制或创建副本",
		});
		expect(duplicateNode(source, "nope", { x: 0, y: 0 })).toEqual({
			ok: false,
			reason: "节点 nope 不存在",
		});
	});
});
