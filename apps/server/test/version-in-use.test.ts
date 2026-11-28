// 同一台 Agent 上同一个节点包的另一个版本正在执行（准备中、执行中）时拒绝（#449）：触发前的预检阻断（package_version_in_use），
// 绕过预检时（两个运行在 Agent 离线时都触发了）后派发的任务以 env_error 失败、不发给 Agent。两处用同一个判断，
// 数据来自控制面的任务记录；每次拒绝记一行（package_version_conflicts）。真实 Agent 上换掉代码的复现见 full-stack-version-conflict。
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ranFor } from "../src/engine/version-conflict.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent, type HelloInit } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

interface Problem {
	code: string;
	message: string;
	node_id?: string;
}

const devLoaded = (name: string): Pick<HelloInit, "devPackages"> => ({
	devPackages: [
		{
			name,
			source: `/src/${name}`,
			metadataJson: JSON.stringify({
				name,
				version: "dev",
				requires_python: ">=3.10",
				nodes: [
					{
						name: "echo",
						title: "Echo",
						entry: `${name}:echo`,
						inputs: { type: "object", properties: {}, required: [] },
						outputs: { type: "object", properties: { out: {} } },
					},
				],
			}),
		},
	],
});

describe("ranFor", () => {
	it("不到 1 分钟、分钟、小时和分钟", () => {
		expect(ranFor(59_999)).toBe("已经跑了不到 1 分钟");
		expect(ranFor(5 * 60_000)).toBe("已经跑了 5 分钟");
		expect(ranFor(60 * 60_000)).toBe("已经跑了 1 小时");
		expect(ranFor(125 * 60_000)).toBe("已经跑了 2 小时 5 分钟");
	});
});

describe("同一台 Agent 上同一个节点包的另一个版本正在执行", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let clock: ManualClock;
	const agents: FakeAgent[] = [];

	const connect = async (name: string, init: Pick<HelloInit, "devPackages"> = {}) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name, slots: 4, ...init }, { clock });
		agents.push(agent);
		return agent;
	};
	const scenario = (pkg: string, version: string, agent = "agent-a", name = "场景") =>
		api.orchestrationWith(
			{
				default_agent: agent,
				nodes: [
					{ id: "entry", kind: "entry" },
					{ id: "a", kind: "package", package: pkg, node: "echo", inputs: {} },
				],
				edges: [{ from: "entry", to: "a", kind: "chain" }],
				packages: { [pkg]: version },
			},
			name,
		);
	const rejected = async (id: string): Promise<Problem[]> => {
		const res = await api.trigger(id);
		expect(res.status, await res.clone().text()).toBe(400);
		return ((await res.json()) as { error: { details: Problem[] } }).error.details;
	};
	const conflicts = async () => {
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			return (
				await client.query(
					"select stage, project_id, agent_name, package, version, message from package_version_conflicts order by id",
				)
			).rows as Array<Record<string, string>>;
		} finally {
			await client.end();
		}
	};

	beforeEach(async () => {
		clock = new ManualClock();
		// 时钟往前拨 12 分钟时租约不过期。
		cp = await startTestControlPlane({ clock, leaseMs: 3_600_000 });
		api = new ApiClient(cp);
		for (const version of ["1.0", "1.1"])
			await publishPackage(cp, "pkg", version, { echo: ["out"] });
		await publishPackage(cp, "other", "1.0", { echo: ["out"] });
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	it("pkg@1.0 在执行时触发用 pkg@1.1 的场景被预检阻断，说明写明 Agent、版本、运行和跑了多久；它结束之后同样的触发成功", async () => {
		const agent = await connect("agent-a");
		const runId = await api.triggerOk(await scenario("pkg", "1.0", "agent-a", "长跑"));
		const task = await agent.nextAssign();
		clock.advance(12 * 60_000);

		const newer = await scenario("pkg", "1.1");
		const expected = {
			code: "package_version_in_use",
			node_id: "a",
			message: `节点 a 用的是 pkg@1.1，但它派发到的 Agent agent-a 上正在执行 pkg@1.0（场景「长跑」的运行 /runs/${runId}，已经跑了 12 分钟）：同一台 Agent 上一个节点包只能装一个版本，装上 1.1 会换掉正在执行的代码。等那次运行结束再触发，或者把这个节点换到另一台 Agent`,
		};
		expect(await rejected(newer)).toEqual([expected]);
		expect(
			(await api.getJson<{ problems: Problem[] }>(`/orchestrations/${newer}/preflight`)).problems,
		).toEqual([expected]);
		// 只有触发被拒才计数，预检接口（打开触发对话框）不计。
		expect(await conflicts()).toEqual([
			{
				stage: "trigger",
				project_id: "default",
				agent_name: "agent-a",
				package: "pkg",
				version: "1.1",
				message: expected.message,
			},
		]);

		await agent.succeed(task, { out: "ok" });
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
		await api.triggerOk(newer);
		await agent.nextAssign();
	});

	it("开发版本和已发布版本之间同样阻断（两个方向）", async () => {
		const agent = await connect("agent-a", devLoaded("pkg"));
		const devRun = await api.triggerOk(await scenario("pkg", "dev"));
		const task = await agent.nextAssign();
		const [problem] = await rejected(await scenario("pkg", "1.0"));
		expect(problem?.code).toBe("package_version_in_use");
		expect(problem?.message).toContain("上正在执行 pkg@dev（");
		await agent.succeed(task, { out: "ok" });
		await eventually(async () => expect((await api.run(devRun)).status).toBe("success"));

		await api.triggerOk(await scenario("pkg", "1.0"));
		await agent.nextAssign();
		const [reverse] = await rejected(await scenario("pkg", "dev"));
		expect(reverse?.code).toBe("package_version_in_use");
		expect(reverse?.message).toContain("用的是 pkg@dev，");
	});

	it("不同节点包、同一个版本、不同的 Agent 都不受影响", async () => {
		const a = await connect("agent-a");
		const b = await connect("agent-b");
		await api.triggerOk(await scenario("pkg", "1.0"));
		await a.nextAssign();

		await api.triggerOk(await scenario("other", "1.0"));
		await a.nextAssign();
		await api.triggerOk(await scenario("pkg", "1.0"));
		await a.nextAssign();
		await api.triggerOk(await scenario("pkg", "1.1", "agent-b"));
		await b.nextAssign();
		expect(await conflicts()).toEqual([]);
	});

	it("绕过预检（Agent 离线时两个运行都触发了）：后派发的以 env_error 失败、不发给 Agent，先派发的照常执行", async () => {
		const first = await connect("agent-a");
		await first.disconnect();
		await eventually(async () => {
			const { agents: list } = await api.getJson<{ agents: { name: string; status: string }[] }>(
				"/projects/default/agents",
			);
			expect(list.find((a) => a.name === "agent-a")?.status).toBe("offline");
		});
		const older = await api.triggerOk(await scenario("pkg", "1.0", "agent-a", "先到"));
		const newer = await api.triggerOk(await scenario("pkg", "1.1"));

		const agent = await connect("agent-a");
		const task = await agent.nextAssign();
		expect(task.packageVersion).toBe("1.0");
		await agent.expectNoAssign();
		await eventually(async () => expect((await api.run(newer)).status).toBe("failed"));
		const node = await api.node(newer, "a");
		expect(node.attempts).toHaveLength(1);
		expect(node.attempts[0]?.error).toMatchObject({
			kind: "env_error",
			message: `节点 a 用的是 pkg@1.1，但它派发到的 Agent agent-a 上正在执行 pkg@1.0（场景「先到」的运行 /runs/${older}，已经跑了不到 1 分钟）：同一台 Agent 上一个节点包只能装一个版本，装上 1.1 会换掉正在执行的代码。等那次运行结束再触发，或者把这个节点换到另一台 Agent`,
		});
		expect((await conflicts()).map((c) => [c.stage, c.version])).toEqual([["dispatch", "1.1"]]);

		await agent.succeed(task, { out: "ok" });
		await eventually(async () => expect((await api.run(older)).status).toBe("success"));
	});
});
