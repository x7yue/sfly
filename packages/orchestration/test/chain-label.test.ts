import { describe, expect, it } from "vitest";
import { chainLabel, namedChainLabel, shortId, subflowLabel } from "../src/index.js";

describe("链和子流程的显示名称", () => {
	it("主链显示「主链」，不带实例短 ID", () => {
		expect(chainLabel({ chain_id: "entry", subflow: false })).toBe("主链");
		expect(chainLabel({ chain_id: "entry", subflow: false }, "6f1c2d3e-aaaa")).toBe("主链");
	});

	it("子流程显示名称；给出实例 ID 时带上它的前 8 位", () => {
		const chain = { chain_id: "sub", subflow: true, name: "监控" };
		expect(chainLabel(chain)).toBe("子流程 监控");
		expect(chainLabel(chain, "6f1c2d3e-0000-4000-8000-000000000000")).toBe(
			"子流程 监控 · 6f1c2d3e",
		);
	});

	it("没有名称字段的旧版本显示入口节点 ID；填了空名称显示「未命名子流程」", () => {
		expect(chainLabel({ chain_id: "sub", subflow: true })).toBe("子流程 sub");
		expect(chainLabel({ chain_id: "sub", subflow: true, name: null })).toBe("子流程 sub");
		expect(chainLabel({ chain_id: "sub", subflow: true, name: "  " })).toBe("子流程 未命名子流程");
		expect(subflowLabel({ id: "sub", name: "" })).toBe("未命名子流程");
	});

	it("只有名称时：null 是主链，名称为空的子流程显示「未命名子流程」", () => {
		expect(namedChainLabel(null)).toBe("主链");
		expect(namedChainLabel("监控")).toBe("子流程 监控");
		expect(namedChainLabel("")).toBe("子流程 未命名子流程");
	});

	it("shortId 取前 8 位", () => {
		expect(shortId("6f1c2d3e-0000")).toBe("6f1c2d3e");
	});
});
