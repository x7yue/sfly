import { describe, expect, it } from "vitest";
import { idParts } from "./node-display";

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
		// 开头的分隔符不算分段。
		expect(idParts("_hidden")).toEqual({ head: "_", tail: "hidden" });
	});
});
