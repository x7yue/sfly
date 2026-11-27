import type { AgentCredentialView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { type Flow, flowReducer, startFlow } from "./credential-flow";

const RAW = "sfly_agt_0123456789abcdef0123456789abcdef0123456789abcdef";
const credential: AgentCredentialView = {
	id: "00000000-0000-4000-8000-000000000001",
	prefix: "sfly_agt_0123",
	created_at: "2026-01-01T00:00:00.000Z",
	last_used_at: null,
	revoked_at: null,
	user: null,
};
const issued: Flow = { view: "issued", name: "agent-a", credential, token: RAW };

/** 原值（或它的任何一段）有没有留在状态里：整个状态序列化之后找。 */
const holdsToken = (flow: Flow) => JSON.stringify(flow).includes(RAW.slice(10));

describe("凭据弹窗的步骤", () => {
	it("已有的 Agent 从列表开始；给新名字签发先填名称", () => {
		expect(startFlow("agent-a")).toEqual({ view: "list", name: "agent-a" });
		expect(startFlow(null)).toEqual({ view: "name" });
	});

	it("原值只在 issued 里：收到之后在，点「我已保存，完成」回到列表就没有了", () => {
		const flow = flowReducer(
			{ view: "list", name: "agent-a" },
			{ type: "issued", name: "agent-a", credential, token: RAW },
			"agent-a",
		);
		expect(flow).toEqual(issued);
		expect(holdsToken(flow)).toBe(true);
		const done = flowReducer(flow, { type: "done" }, "agent-a");
		expect(done).toEqual({ view: "list", name: "agent-a" });
		expect(holdsToken(done)).toBe(false);
	});

	it("弹窗关掉（过渡动画结束）：回到起点，原值清掉；给新名字签发的关掉后回到填名称", () => {
		for (const start of ["agent-a", null]) {
			const closed = flowReducer(issued, { type: "closed" }, start);
			expect(closed).toEqual(startFlow(start));
			expect(holdsToken(closed)).toBe(false);
		}
	});

	it("新名字：填名称、签发成功直接进入显示原值；点完成之后留在这个名字的列表里（能看到刚签发的那条，没有原值）", () => {
		let flow = flowReducer(
			{ view: "name" },
			{ type: "issued", name: "worker-9", credential, token: RAW },
			null,
		);
		expect(flow).toEqual({ view: "issued", name: "worker-9", credential, token: RAW });
		flow = flowReducer(flow, { type: "done" }, null);
		expect(flow).toEqual({ view: "list", name: "worker-9" });
		expect(holdsToken(flow)).toBe(false);
	});

	it("吊销确认：从列表进去，取消回列表；确认框里也没有原值", () => {
		const list: Flow = { view: "list", name: "agent-a" };
		const asking = flowReducer(list, { type: "askRevoke", credential }, "agent-a");
		expect(asking).toEqual({ view: "revoke", name: "agent-a", credential });
		expect(holdsToken(asking)).toBe(false);
		expect(flowReducer(asking, { type: "backToList" }, "agent-a")).toEqual(list);
	});

	it("显示原值的时候，吊销确认、回到列表这类动作都不生效：原值不会被一次误操作带走，只有「完成」和关掉弹窗才清掉", () => {
		expect(flowReducer(issued, { type: "askRevoke", credential }, "agent-a")).toBe(issued);
		expect(flowReducer(issued, { type: "backToList" }, "agent-a")).toBe(issued);
	});
});
