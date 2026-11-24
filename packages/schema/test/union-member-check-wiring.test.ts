import { describe, expect, it, vi } from "vitest";
import { buildClientExport } from "../src/client-export.js";
import { DECLARATION_RULES } from "../src/http/declarations.js";
import * as contract from "../src/index.js";
import { harvestRouteDocs } from "../src/route-docs.js";
import { buildRouteManifest } from "../src/route-manifest.js";

// 联合成员的核对（读契约注释的一边和生成的一边认出的成员要一样）真的接进了生成流程：生成类型（buildClientExport）和导出
// 路由清单（buildRouteManifest 带着 harvestRouteDocs 的说明）各自都调它，去掉任何一处调用，这里就红。
// 核对本身怎么判（不一致时抛什么）在 union-member-docs.test.ts。

vi.mock("../src/client-docs.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/client-docs.js")>();
	return { ...actual, checkMembers: vi.fn(actual.checkMembers) };
});
const { checkMembers } = await import("../src/client-docs.js");
const calls = () => vi.mocked(checkMembers).mock.calls;

describe("联合成员的核对接进了生成流程", () => {
	it("生成类型：每个 root 核对一次，会话事件那个有成员的联合在里面", () => {
		vi.mocked(checkMembers).mockClear();
		buildClientExport(contract.httpApis, contract);
		expect(calls().length).toBeGreaterThan(100);
		const persisted = calls().find(([where]) => where === "PersistedSessionEvent");
		expect(persisted, "会话事件的联合没有核对").toBeDefined();
		// 读到的成员不是空的：核对的不是两个空集合
		expect([...(persisted?.[1] ?? [])].length).toBeGreaterThan(5);
	}, 60_000);

	it("导出路由清单：带着说明的每个接口的每一部分都核对一次，有联合的那几处在里面", () => {
		vi.mocked(checkMembers).mockClear();
		buildRouteManifest(
			contract.httpContract,
			DECLARATION_RULES,
			harvestRouteDocs(contract.httpApis),
		);
		expect(calls().length).toBeGreaterThan(100);
		const where = calls().map(([w]) => w);
		expect(where.some((w) => w.includes("POST /orchestrations/:id/edits 的 body"))).toBe(true);
		expect(where.some((w) => w.includes("GET /sessions/:id/events 的事件 platform"))).toBe(true);
		// 联合在读到的层数以内的，两边认出的成员都不是空的
		const platform = calls().find(([w]) => w.includes("GET /sessions/:id/events 的事件 platform"));
		expect([...(platform?.[1] ?? [])].length).toBeGreaterThan(0);
		expect([...(platform?.[2] ?? [])].length).toBeGreaterThan(0);
	}, 60_000);

	it("导出路由清单：手写的说明函数（没有核对）照常工作", () => {
		vi.mocked(checkMembers).mockClear();
		const manifest = buildRouteManifest(contract.httpContract, DECLARATION_RULES, () => undefined);
		expect(manifest.routes.length).toBe(contract.httpContract.length);
		expect(calls().length).toBe(0);
	});
});
