// 切入点 A：开发模式（sfly dev）的控制面行为——Agent 上报以开发模式加载的节点包（Hello / InstallStatus），
// Agent 列表里能看到它们（画布据此提供 dev 版本选项）；锁定 `包名@dev` 的编排可以保存、触发，
// 任务派发给节点指定的 Agent，不带下载地址；没有加载它的 Agent 以 env_error 失败。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { ErrorKind, FakeAgent, type HelloInit } from "./support/fake-agent.js";
import { packageArchive, publishInit } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const devMetadata = {
	name: "demo-dev",
	version: "dev",
	requires_python: ">=3.10",
	nodes: [
		{
			name: "ping",
			title: "Ping",
			entry: "demo_dev:ping",
			inputs: { type: "object", properties: { host: { type: "string" } }, required: [] },
			outputs: { type: "object", properties: { ok: {} } },
		},
	],
};

const devPackage = (source: string) => ({
	name: "demo-dev",
	source,
	metadataJson: JSON.stringify(devMetadata),
});

interface AgentView {
	name: string;
	dev_packages: { name: string; source: string; metadata: unknown }[];
}

describe("开发模式", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	const connect = async (hello: HelloInit) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, hello);
		agents.push(agent);
		return agent;
	};
	const agentView = async (name: string): Promise<AgentView | undefined> => {
		const { agents } = await api.getJson<{ agents: AgentView[] }>("/agents");
		return agents.find((a) => a.name === name);
	};

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	it("Agent 在 Hello 中上报的开发版本（源码目录与元信息）出现在 Agent 列表里", async () => {
		await connect({ name: "agent-dev", devPackages: [devPackage("/home/dev/demo-dev")] });
		await connect({ name: "agent-plain" });

		expect(await agentView("agent-dev")).toMatchObject({
			dev_packages: [{ name: "demo-dev", source: "/home/dev/demo-dev", metadata: devMetadata }],
		});
		expect((await agentView("agent-plain"))?.dev_packages).toEqual([]);
	});

	it("sfly dev 加载后，Agent 通过 InstallStatus 实时上报开发版本", async () => {
		const agent = await connect({ name: "agent-dev" });
		agent.send({
			case: "install",
			value: {
				package: "demo-dev",
				version: "dev",
				state: 2, // INSTALLED
				taskId: "",
				output: "Installed 1 package",
				installedPackages: [{ name: "demo-dev", version: "dev" }],
				devPackages: [devPackage("/src/demo-dev")],
			},
		});
		await eventually(async () =>
			expect(await agentView("agent-dev")).toMatchObject({
				installed_packages: [{ name: "demo-dev", version: "dev" }],
				install: { package: "demo-dev", version: "dev", state: "installed", task_id: "" },
				dev_packages: [{ name: "demo-dev", source: "/src/demo-dev", metadata: devMetadata }],
			}),
		);
	});

	it("锁定 包名@dev 的编排可以保存和触发：任务派发给节点指定的 Agent，不带下载地址", async () => {
		const id = await api.orchestrationWith({
			default_agent: "agent-dev",
			nodes: [
				{ id: "entry", kind: "entry", params: [] },
				{ id: "a", kind: "package", package: "demo-dev", node: "ping", inputs: {} },
			],
			edges: [{ from: "entry", to: "a", kind: "chain" }],
			packages: { "demo-dev": "dev" },
		});
		// 触发预检要求 Agent 已注册；dev 版本跳过“包版本未发布”检查。
		const agent = await connect({ name: "agent-dev", devPackages: [devPackage("/src")] });
		const runId = await api.triggerOk(id);

		const task = await agent.nextAssign();
		expect(task).toMatchObject({
			package: "demo-dev",
			packageVersion: "dev",
			packageUrl: "",
			packageSha256: "",
		});
		await agent.succeed(task, { ok: true });
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
	});

	it("开发版本的任务派发到没有加载它的 Agent 时以 env_error 失败；同一编排里的已发布版本照常带下载地址", async () => {
		expect((await cp.fetch("/packages", publishInit(packageArchive()))).status).toBe(201);
		const id = await api.orchestrationWith({
			default_agent: "agent-plain",
			nodes: [
				{ id: "entry", kind: "entry", params: [] },
				{
					id: "p",
					kind: "package",
					package: "demo-checks",
					node: "ping",
					inputs: { host: "example.com" },
				},
				{ id: "a", kind: "package", package: "demo-dev", node: "ping", inputs: {} },
			],
			edges: [
				{ from: "entry", to: "p", kind: "chain" },
				{ from: "p", to: "a", kind: "chain" },
			],
			packages: { "demo-checks": "1.2.0", "demo-dev": "dev" },
		});
		const agent = await connect({ name: "agent-plain" });
		const runId = await api.triggerOk(id);

		const published = await agent.nextAssign();
		expect(published.packageVersion).toBe("1.2.0");
		expect(published.packageUrl).not.toBe("");
		await agent.succeed(published, {});

		const dev = await agent.nextAssign();
		expect(dev.packageVersion).toBe("dev");
		const message = "开发版本 demo-dev@dev 没有在 Agent agent-plain 上加载";
		await agent.fail(dev, message, ErrorKind.ENV_ERROR);
		await eventually(async () => {
			const node = await api.node(runId, "a");
			expect(node.status).toBe("failed");
			expect(node.error).toEqual({ kind: "env_error", message });
		});
		expect((await api.run(runId)).status).toBe("failed");
		expect((await api.node(runId, "p")).status).toBe("success");
	});
});
