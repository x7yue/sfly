import { OrchestrationDocument } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	type AnnotationWarning,
	annotationWarnings,
	blocksTrigger,
	documentWarnings,
	type OrchestrationWarning,
} from "../src/index.js";

// 注释框写错时的警告（SEMANTICS §1.6）：引用不存在的节点或子流程、没有成员、同一个成员写了两次。
// 只提示，不阻断触发；画布和控制面用同一个函数，警告里带 annotation_id。

const base = {
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "fetch_1", kind: "sleep", duration: "5s", display_name: "创建测试用户" },
		{ id: "spawn", kind: "async" },
		{ id: "mon", kind: "subflow_entry", name: "监控" },
		{ id: "check", kind: "sleep", duration: "5s" },
	],
	edges: [
		{ from: "entry", to: "fetch_1", kind: "chain" },
		{ from: "fetch_1", to: "spawn", kind: "chain" },
		{ from: "spawn", to: "mon", kind: "dispatch" },
		{ from: "mon", to: "check", kind: "chain" },
	],
};

type AnnotationInput = {
	id?: string;
	title?: string;
	nodes?: string[];
	subflows?: string[];
};

const documentWith = (...annotations: AnnotationInput[]) =>
	OrchestrationDocument.parse({
		...base,
		annotations: annotations.map((a, i) => ({
			id: `annotation_${i + 1}`,
			title: "造测试数据",
			...a,
		})),
	});

const warningsOf = (...annotations: AnnotationInput[]) =>
	annotationWarnings(documentWith(...annotations));

describe("注释框的警告", () => {
	it("引用了不存在的节点：message 写出注释框的标题和 ID、不存在的节点，annotation_id 指向这个注释框", () => {
		expect(warningsOf({ nodes: ["fetch_1", "http_request_9"] })).toEqual([
			{
				code: "annotation_unknown_node",
				message: "注释框「造测试数据」（annotation_1）引用了不存在的节点 http_request_9",
				annotation_id: "annotation_1",
			},
		]);
	});

	it("引用了不存在的子流程：写的是子流程入口节点的节点 ID；普通节点、子流程名称都不是子流程", () => {
		const found = warningsOf({ subflows: ["mon", "gone", "check", "监控"] });
		expect(found.map((w) => [w.code, w.annotation_id])).toEqual([
			["annotation_unknown_subflow", "annotation_1"],
			["annotation_unknown_subflow", "annotation_1"],
			["annotation_unknown_subflow", "annotation_1"],
		]);
		expect(found.map((w) => w.message)).toEqual([
			"注释框「造测试数据」（annotation_1）引用了不存在的子流程 gone（子流程成员写子流程入口节点的节点 ID，不是子流程名称）",
			"注释框「造测试数据」（annotation_1）引用了不存在的子流程 check（子流程成员写子流程入口节点的节点 ID，不是子流程名称）",
			"注释框「造测试数据」（annotation_1）引用了不存在的子流程 监控（子流程成员写子流程入口节点的节点 ID，不是子流程名称）",
		]);
	});

	it("没有成员：nodes 和 subflows 都是空", () => {
		expect(warningsOf({ id: "annotation_4", title: "还没想好" })).toEqual([
			{
				code: "annotation_no_members",
				message: "注释框「还没想好」（annotation_4）没有成员",
				annotation_id: "annotation_4",
			},
		]);
	});

	it("成员都写错时不再说「没有成员」：写了成员，只是都不存在", () => {
		expect(warningsOf({ nodes: ["gone"] }).map((w) => w.code)).toEqual(["annotation_unknown_node"]);
	});

	it("同一个成员写了两次：节点和子流程各自检查，提到成员时写成「显示名称（节点 ID）」", () => {
		expect(
			warningsOf({ nodes: ["fetch_1", "entry", "fetch_1"], subflows: ["mon", "mon"] }),
		).toEqual([
			{
				code: "annotation_duplicate_member",
				message: "注释框「造测试数据」（annotation_1）把节点 创建测试用户（fetch_1） 写了 2 次",
				annotation_id: "annotation_1",
			},
			{
				code: "annotation_duplicate_member",
				message: "注释框「造测试数据」（annotation_1）把子流程 监控（mon） 写了 2 次",
				annotation_id: "annotation_1",
			},
		]);
	});

	it("同一个成员写了三次、同一个不存在的节点写了两次：每个成员各警告一次，写出次数", () => {
		const found = warningsOf({ nodes: ["fetch_1", "fetch_1", "fetch_1", "gone", "gone"] });
		expect(found.map((w) => [w.code, w.message])).toEqual([
			[
				"annotation_duplicate_member",
				"注释框「造测试数据」（annotation_1）把节点 创建测试用户（fetch_1） 写了 3 次",
			],
			["annotation_unknown_node", "注释框「造测试数据」（annotation_1）引用了不存在的节点 gone"],
			["annotation_duplicate_member", "注释框「造测试数据」（annotation_1）把节点 gone 写了 2 次"],
		]);
	});

	it("同一个节点既是节点成员又是子流程成员不算重复：节点成员只框它的卡片，子流程成员框整个子流程", () => {
		expect(warningsOf({ nodes: ["mon"], subflows: ["mon"] })).toEqual([]);
	});

	it("多个注释框各自警告，顺序按注释框在文档里的顺序；没有问题的注释框没有警告", () => {
		const found = warningsOf(
			{ title: "第一个", nodes: ["gone"] },
			{ title: "正常", nodes: ["fetch_1"] },
			{ title: "第三个" },
		);
		expect(found.map((w) => [w.annotation_id, w.code])).toEqual([
			["annotation_1", "annotation_unknown_node"],
			["annotation_3", "annotation_no_members"],
		]);
	});

	it("没有写标题（画布上草稿里还没填，文档本身不合法）时只写 ID", () => {
		const draft = { id: "annotation_1", title: " ", nodes: [], subflows: [] };
		expect(
			annotationWarnings({ nodes: documentWith().nodes, annotations: [draft] })[0]?.message,
		).toBe("注释框 annotation_1 没有成员");
	});

	it("没有注释框、没有 annotations 字段（升级前保存的文档）：没有警告", () => {
		expect(annotationWarnings({ nodes: documentWith().nodes })).toEqual([]);
		expect(warningsOf()).toEqual([]);
	});
});

describe("documentWarnings 带上注释框的警告，不阻断触发", () => {
	const doc = documentWith({ nodes: ["gone"] }, { subflows: [] });

	it("画布和控制面用的 documentWarnings 里有它们，其他检查的警告不受影响", () => {
		const all = documentWarnings(doc, new Map());
		expect(all.filter((w) => "annotation_id" in w)).toEqual(annotationWarnings(doc));
		expect(all.filter((w) => !("annotation_id" in w))).toEqual([]);
	});

	it("blocksTrigger：注释框的警告不阻断触发，其他警告阻断", () => {
		const unset = documentWarnings(
			OrchestrationDocument.parse({
				...doc,
				nodes: [...doc.nodes, { id: "stray", kind: "sleep", duration: "5s" }],
			}),
			new Map(),
		);
		const verdicts = unset.map((w: OrchestrationWarning) => [w.code, blocksTrigger(w)]);
		expect(verdicts).toContainEqual(["orphan_node", true]);
		expect(verdicts).toContainEqual(["annotation_unknown_node", false]);
		expect(verdicts).toContainEqual(["annotation_no_members", false]);
		const only: AnnotationWarning[] = annotationWarnings(doc);
		expect(only.some(blocksTrigger)).toBe(false);
	});
});
