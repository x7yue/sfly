import { describe, expect, it } from "vitest";
import { idParts, KIND_META, nodeSlot } from "./node-display";

// 卡片上节点 ID 的两段（开头放不下时截断，结尾整段始终显示）：结尾按分隔符保留整段，不把单词切开。
describe("节点 ID 保留结尾", () => {
	it("保留最后一段；最后一段很短时带上前一段", () => {
		expect(idParts("order_monitor")).toEqual({ head: "order", tail: "_monitor" });
		expect(idParts("resource_monitor")).toEqual({ head: "resource", tail: "_monitor" });
		expect(idParts("stop_subflow_1")).toEqual({ head: "stop", tail: "_subflow_1" });
		expect(idParts("upgrade_strategy_atx_v2")).toEqual({
			head: "upgrade_strategy",
			tail: "_atx_v2",
		});
		expect(idParts("node-2.v3")).toEqual({ head: "node", tail: "-2.v3" });
	});

	it("前一段太长时只保留最后一段；拼起来就是原来的 ID", () => {
		expect(idParts("start_adaptor_restart_1")).toEqual({
			head: "start_adaptor",
			tail: "_restart_1",
		});
		const parts = idParts("build_documentation_1");
		expect(parts).toEqual({ head: "build_documentation", tail: "_1" });
		expect(parts.head + parts.tail).toBe("build_documentation_1");
	});

	it("没有分隔符时保留结尾 6 个字符；短 ID 整个是结尾", () => {
		expect(idParts("verifyreport")).toEqual({ head: "verify", tail: "report" });
		expect(idParts("ping")).toEqual({ head: "", tail: "ping" });
	});

	it("开头只剩一两个字时不拆：整个 ID 是结尾，不会在开头撑出空隙", () => {
		expect(idParts("cleanup")).toEqual({ head: "", tail: "cleanup" });
		expect(idParts("ab_monitor")).toEqual({ head: "", tail: "ab_monitor" });
		// 开头的分隔符不算分段。
		expect(idParts("_hidden")).toEqual({ head: "", tail: "_hidden" });
		expect(idParts("abc_monitor")).toEqual({ head: "abc", tail: "_monitor" });
	});
});

// 历史版本里留着的、已移除种类的节点（ADR 0028）：卡片上只写它是什么，不拿当时的配置当摘要。
describe.each(["feishu_notify", "timer", "sleep"] as const)("已移除种类的节点 %s", (kind) => {
	it("卡片头部写「已移除的节点类型」加种类名", () => {
		expect(KIND_META[kind].label).toBe(`已移除的节点类型 ${kind}`);
	});

	it("卡片摘要说明不再支持，不写当时的配置", () => {
		expect(nodeSlot({ id: "old", kind })).toEqual({
			text: "不再支持，删除后才能保存",
			empty: true,
		});
	});
});

describe("停止子流程节点的卡片摘要", () => {
	it("选了子流程写子流程入口的节点 ID，没选时写「未选择子流程」", () => {
		expect(nodeSlot({ id: "stop", kind: "stop_subflow", always: false, subflow: "mon" })).toEqual({
			text: "子流程入口 mon",
			empty: false,
		});
		expect(nodeSlot({ id: "stop", kind: "stop_subflow", always: false })).toEqual({
			text: "未选择子流程",
			empty: true,
		});
	});
});
