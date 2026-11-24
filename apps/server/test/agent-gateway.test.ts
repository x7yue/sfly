import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeAgent } from "./support/fake-agent.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("Agent 网关", () => {
	let cp: TestControlPlane;
	beforeAll(async () => {
		cp = await startTestControlPlane();
	});
	afterAll(async () => {
		await cp.close();
	});

	it("Agent 通过 gRPC 双向流发送 Hello 后收到 Welcome", async () => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		expect(agent.received.map((m) => m.body.case)).toEqual(["welcome"]);
		await agent.close();
		expect(agent.ended).toBe(true);
	});

	// Agent 的名称是身份，显示在命令行、控制台和场景里：和令牌的名称、显示名同一个检查（#670）。字符都用码位造出来。
	it("名称里有控制字符、8 位的控制序列、双向控制字符、零宽空格、标签字符、盲文空白、孤立的代理码元，或看起来是空的：Hello 被拒绝（InvalidArgument），说出第几个字符、哪个码位，连接不进连接表", async () => {
		const code = (...points: number[]) => String.fromCodePoint(...points);
		for (const [bad, expected] of [
			[`a${code(0x1b)}[2Jb`, "Agent 的名称的第 2 个字符是 U+001B"],
			[`a${code(0x9b)}b`, "Agent 的名称的第 2 个字符是 U+009B"],
			[`a${code(0x202e)}b`, "Agent 的名称的第 2 个字符是 U+202E"],
			[`a${code(0x200b)}b`, "Agent 的名称的第 2 个字符是 U+200B"],
			[`a${code(0xe0067)}`, "Agent 的名称的第 2 个字符是 U+E0067"],
			[`a${code(0x2800)}`, "Agent 的名称的第 2 个字符是 U+2800"],
			[`a${code(0xd800)}`, "Agent 的名称的第 2 个字符是 U+D800"],
			["   ", "Agent 的名称里没有看得见的字符"],
		] as const) {
			await expect(
				FakeAgent.connect(cp.grpcUrl, { name: bad }),
				JSON.stringify(bad),
			).rejects.toThrow(expected);
		}
		// 正常的名字（含中文、组合表情）照常连。
		for (const ok of ["agent-ok", "测试机", `dev-${code(0x1f469, 0x200d, 0x1f4bb)}`]) {
			const agent = await FakeAgent.connect(cp.grpcUrl, { name: ok });
			expect(agent.received.map((m) => m.body.case)).toEqual(["welcome"]);
			await agent.disconnect();
		}
	});

	it("多个 Agent 可以同时连接", async () => {
		const agents = await Promise.all(
			["a", "b", "c"].map((name) => FakeAgent.connect(cp.grpcUrl, { name })),
		);
		for (const agent of agents) expect(agent.received).toHaveLength(1);
		await Promise.all(agents.map((a) => a.disconnect()));
	});

	it("控制面关闭时连接中的 Agent 流随之结束", async () => {
		const own = await startTestControlPlane();
		const agent = await FakeAgent.connect(own.grpcUrl, { name: "agent-x" });
		await own.close();
		await expect(agent.next(undefined, { timeoutMs: 2000 })).rejects.toThrow();
		expect(agent.ended).toBe(true);
	});
});
