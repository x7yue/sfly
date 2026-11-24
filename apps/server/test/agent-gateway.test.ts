import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PROJECT } from "../src/projects/project-id.js";
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
	it("名称里有控制字符、8 位的控制序列、双向控制字符、零宽空格、标签字符、盲文空白，或看起来是空的：Hello 被拒绝（InvalidArgument），说出第几个字符、哪个码位，连接不进连接表", async () => {
		const code = (...points: number[]) => String.fromCodePoint(...points);
		for (const [bad, expected] of [
			[`a${code(0x1b)}[2Jb`, "Agent 的名称的第 2 个字符是 U+001B"],
			[`a${code(0x9b)}b`, "Agent 的名称的第 2 个字符是 U+009B"],
			[`a${code(0x202e)}b`, "Agent 的名称的第 2 个字符是 U+202E"],
			[`a${code(0x200b)}b`, "Agent 的名称的第 2 个字符是 U+200B"],
			[`a${code(0xe0067)}`, "Agent 的名称的第 2 个字符是 U+E0067"],
			[`a${code(0x2800)}`, "Agent 的名称的第 2 个字符是 U+2800"],
			["   ", "Agent 的名称里没有看得见的字符"],
		] as const) {
			await expect(
				FakeAgent.connect(cp.grpcUrl, { name: bad }),
				JSON.stringify(bad),
			).rejects.toThrow(expected);
		}
		// 孤立的代理码元到不了这里：protobuf 的字符串编成 UTF-8 时把它换成 U+FFFD（看得见的字符），这一层不会收到（storable.test.ts 直接测）。
		// 名称长度上限 64 个字符（按字符数）：65 个被拒绝，说上限，不回显名称。
		await expect(FakeAgent.connect(cp.grpcUrl, { name: "n".repeat(65) })).rejects.toThrow(
			"Agent 的名称不能超过 64 个字符",
		);
		await expect(FakeAgent.connect(cp.grpcUrl, { name: "n".repeat(65) })).rejects.not.toThrow(
			/n{20}/,
		);
		for (const exact of ["n".repeat(64), code(0x1f600).repeat(64)]) {
			const agent = await FakeAgent.connect(cp.grpcUrl, { name: exact });
			await agent.disconnect();
		}
		// 名称不合格时的报错不带出原样的名称。
		for (const bad of [`a${code(0x1b)}[2Jb`, `a${code(0x202e)}b`]) {
			const error = await FakeAgent.connect(cp.grpcUrl, { name: bad }).then(
				() => undefined,
				(caught: unknown) => caught as Error,
			);
			expect(String(error?.message), JSON.stringify(bad)).not.toContain(bad);
		}
		// 正常的名字（含中文、组合表情）照常连。
		for (const ok of ["agent-ok", "测试机", `dev-${code(0x1f469, 0x200d, 0x1f4bb)}`]) {
			const agent = await FakeAgent.connect(cp.grpcUrl, { name: ok });
			expect(agent.received.map((m) => m.body.case)).toEqual(["welcome"]);
			await agent.disconnect();
		}
	});

	it("名称的检查在凭据的检查之前：不合格的名称不经认证拒绝连接的报错原样回显（凭据属于别的名字、没有凭据的旧方式、名字太长）", async () => {
		const code = (...points: number[]) => String.fromCodePoint(...points);
		const worker = (await cp.current.agentCredentials.issue(DEFAULT_PROJECT, "worker-1")).token;
		const bads = [`a${code(0x1b)}[2Jb`, `x${code(0x202e)}y`, "n".repeat(65)];
		for (const bad of bads) {
			for (const token of [worker, "", "no-such-credential"]) {
				const error = await FakeAgent.connect(cp.grpcUrl, { name: bad, token }).then(
					() => undefined,
					(caught: unknown) => caught as Error,
				);
				const label = JSON.stringify({ bad, token });
				expect(error, label).toBeInstanceOf(Error);
				// 报的是名称不合格（InvalidArgument），不是认证的报错；报错里没有原样的名称。
				expect(error?.message, label).toContain("Hello.name 不合格");
				expect(error?.message, label).not.toContain(bad);
				expect(error?.message, label).not.toContain("属于");
				expect(error?.message, label).not.toContain("没有登记");
			}
		}
		// 合格的名字照旧走认证：凭据属于别的名字时认证拒绝。
		await expect(
			FakeAgent.connect(cp.grpcUrl, { name: "worker-2", token: worker }),
		).rejects.toThrow("这个 Agent 凭据属于「worker-1」");
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
