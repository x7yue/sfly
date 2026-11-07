// 切入点 A：节点包声明的最低 SDK 版本（requires_sdk，#79）。Agent 上 SDK 运行时的版本等于 Agent 版本（ADR 0010），
// 派发前控制面比较两者，不满足时任务以 env_error 失败、提示升级 Agent。触发前预检比较的是控制面版本：控制面只给
// 同版本的 Agent 派任务（ADR 0014），旧 Agent 会先自更新到控制面的版本，所以提示如实写控制面版本、请升级控制面。
// 早于 #79 构建的节点包没有这个字段，行为不变（其余测试里的节点包都没有它）。
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent, type HelloInit } from "./support/fake-agent.js";
import { packageArchive, packageMetadata, publishInit } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const VERSION = "1.0.0";

const document = (pkg: string, version: string) => ({
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [] },
		{ id: "p", kind: "package", package: pkg, node: "ping", inputs: { host: "example.com" } },
	],
	edges: [{ from: "entry", to: "p", kind: "chain" }],
	packages: { [pkg]: version },
});

interface Problem {
	code: string;
	message: string;
	node_id?: string;
}

describe("最低 SDK 版本", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	const connect = async (hello: HelloInit) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { agentVersion: VERSION, ...hello });
		agents.push(agent);
		return agent;
	};
	const start = async () => {
		cp = await startTestControlPlane({ version: VERSION });
		api = new ApiClient(cp);
	};
	const publish = async (requires_sdk: string) => {
		const archive = packageArchive(packageMetadata({ requires_sdk }));
		expect((await cp.fetch("/packages", publishInit(archive))).status).toBe(201);
	};

	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	it("Agent 版本低于节点包需要的 SDK 版本时，任务不派给它，以 env_error 失败并写明两个版本、提示升级 Agent", async () => {
		await start();
		const metadata = packageMetadata({ name: "demo-dev", version: "dev", requires_sdk: ">=1.1" });
		const agent = await connect({
			name: "agent-a",
			devPackages: [
				{ name: "demo-dev", source: "/src/demo-dev", metadataJson: JSON.stringify(metadata) },
			],
		});
		const runId = await api.triggerOk(await api.orchestrationWith(document("demo-dev", "dev")));

		await eventually(async () => {
			const node = await api.node(runId, "p");
			expect(node.status).toBe("failed");
			expect(node.error?.kind).toBe("env_error");
			expect(node.error?.message).toBe(
				"节点包 demo-dev@dev 需要 SDK >=1.1，Agent agent-a 的版本是 1.0.0：请升级 Agent",
			);
		});
		await agent.expectNoAssign();
		expect((await api.run(runId)).status).toBe("failed");
	});

	it("满足要求时照常派发", async () => {
		await start();
		await publish(">=1.0, <2");
		const agent = await connect({ name: "agent-a" });
		const runId = await api.triggerOk(
			await api.orchestrationWith(document("demo-checks", "1.2.0")),
		);

		const assign = await agent.nextAssign();
		await agent.succeed(assign, {});
		await eventually(async () => expect((await api.node(runId, "p")).status).toBe("success"));
	});

	it("触发前预检按控制面版本判断，提示写明控制面的版本并请升级控制面，拒绝触发", async () => {
		await start();
		await publish(">=1.1");
		await connect({ name: "agent-a" });
		const id = await api.orchestrationWith(document("demo-checks", "1.2.0"));

		const { problems } = await api.getJson<{ problems: Problem[] }>(
			`/orchestrations/${id}/preflight`,
		);
		expect(problems).toEqual([
			{
				code: "sdk_version_unsatisfied",
				node_id: "p",
				message:
					"节点 p：节点包 demo-checks@1.2.0 需要 SDK >=1.1，控制面的版本是 1.0.0：Agent 会先自更新到控制面的版本再执行任务，请升级控制面",
			},
		]);
		expect((await api.trigger(id)).status).toBe(400);
	});

	// 按 PEP 440 的语义比较；位数不同时补 0。控制面版本为 1.0.0（Agent 执行任务时也是这个版本）。
	it.each([
		[">=1.0", true],
		["==1", true],
		[">0.9.9, <2", true],
		["~=0.9", false],
		["~=1.0.0", true],
		["!=1.0.0", false],
		["<=0.9", false],
		[" >= 1.0.1 ", false],
	])("要求 %s 时 1.0.0 的 Agent 是否满足：%s", async (requirement, ok) => {
		await start();
		await publish(requirement);
		await connect({ name: "agent-a" });
		const id = await api.orchestrationWith(document("demo-checks", "1.2.0"));
		const { problems } = await api.getJson<{ problems: Problem[] }>(
			`/orchestrations/${id}/preflight`,
		);
		expect(problems.map((p) => p.code)).toEqual(ok ? [] : ["sdk_version_unsatisfied"]);
	});
});
