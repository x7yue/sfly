// 切入点 A：节点包安装相关的控制面行为——派发时带上归档下载地址与 sha256，
// Agent 通过 InstallStatus 上报安装状态，已安装的包列表实时更新；安装失败的完整输出可以在任务详情里看到。
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { ErrorKind, FakeAgent, type HelloInit } from "./support/fake-agent.js";
import { packageArchive, publishInit, publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 入口节点 + 一个包节点。 */
function singleNode(
	pkg: string,
	version: string,
	node: string,
	inputs: Record<string, unknown> = {},
) {
	return {
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry", params: [] },
			{ id: "a", kind: "package", package: pkg, node, inputs },
		],
		edges: [{ from: "entry", to: "a", kind: "chain" }],
		packages: { [pkg]: version },
	};
}

interface AgentView {
	name: string;
	installed_packages: { name: string; version: string }[];
	install: { package: string; version: string; state: string; task_id: string } | null;
}

describe("节点包安装", () => {
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

	it("派发的任务带上节点包归档的下载地址和 sha256，Agent 可以据此下载并校验", async () => {
		const archive = packageArchive();
		expect((await cp.fetch("/packages", publishInit(archive))).status).toBe(201);
		await (await connect({ name: "agent-a" })).disconnect();
		const id = await api.orchestrationWith(
			singleNode("demo-checks", "1.2.0", "ping", { host: "h" }),
		);
		await api.triggerOk(id);

		const agent = await connect({ name: "agent-a" });
		const task = await agent.nextAssign();

		const expected = createHash("sha256").update(archive).digest("hex");
		expect(task.packageSha256).toBe(expected);
		const res = await fetch(task.packageUrl);
		expect(res.status).toBe(200);
		const downloaded = new Uint8Array(await res.arrayBuffer());
		expect(createHash("sha256").update(downloaded).digest("hex")).toBe(expected);
	});

	it("控制面没有这个包版本（开发版本）时，派发的任务没有下载地址", async () => {
		await (await connect({ name: "agent-a" })).disconnect();
		const id = await api.orchestrationWith(singleNode("not-published", "dev", "x"));
		await api.triggerOk(id);

		const agent = await connect({ name: "agent-a" });
		const task = await agent.nextAssign();
		expect(task.packageUrl).toBe("");
		expect(task.packageSha256).toBe("");
	});

	it("Agent 上报的安装状态和已安装的包列表实时反映在 Agent 列表里", async () => {
		const agent = await connect({
			name: "agent-a",
			installedPackages: [{ name: "sfly-stub", version: "0.1.0" }],
		});
		expect(await agentView("agent-a")).toMatchObject({
			installed_packages: [{ name: "sfly-stub", version: "0.1.0" }],
			install: null,
		});

		agent.send({
			case: "install",
			value: {
				package: "sfly-stub",
				version: "0.2.0",
				state: 1, // INSTALLING
				taskId: "t-1",
				installedPackages: [{ name: "sfly-stub", version: "0.1.0" }],
			},
		});
		await eventually(async () =>
			expect(await agentView("agent-a")).toMatchObject({
				install: { package: "sfly-stub", version: "0.2.0", state: "installing", task_id: "t-1" },
			}),
		);

		agent.send({
			case: "install",
			value: {
				package: "sfly-stub",
				version: "0.2.0",
				state: 2, // INSTALLED
				taskId: "t-1",
				output: "Installed 1 package",
				installedPackages: [
					{ name: "demo", version: "1.0.0" },
					{ name: "sfly-stub", version: "0.2.0" },
				],
			},
		});
		await eventually(async () =>
			expect(await agentView("agent-a")).toMatchObject({
				installed_packages: [
					{ name: "demo", version: "1.0.0" },
					{ name: "sfly-stub", version: "0.2.0" },
				],
				install: { package: "sfly-stub", version: "0.2.0", state: "installed", task_id: "t-1" },
			}),
		);
	});

	it("安装失败（依赖冲突）时任务以 env_error 失败、不重试，任务详情里有完整的 uv 输出", async () => {
		await publishPackage(cp, "sfly-b", "1.0.0", { about: [] });
		await (await connect({ name: "agent-a" })).disconnect();
		const id = await api.orchestrationWith(singleNode("sfly-b", "1.0.0", "about"));
		const runId = await api.triggerOk(id);
		const agent = await connect({ name: "agent-a" });
		const task = await agent.nextAssign();

		const uvOutput = [
			"安装节点包 sfly-b@1.0.0 失败（uv exit status: 1）",
			"",
			"$ uv pip install ...",
			"  × No solution found when resolving dependencies:",
			"  ╰─▶ Because you require sfly-dep==1.0 and sfly-dep==2.0, we can conclude that your requirements are unsatisfiable.",
			...Array.from({ length: 200 }, (_, i) => `line ${i}`),
		].join("\n");
		await agent.fail(task, uvOutput, ErrorKind.ENV_ERROR);

		await eventually(async () => {
			const node = await api.node(runId, "a");
			expect(node.status).toBe("failed");
			expect(node.error).toEqual({ kind: "env_error", message: uvOutput });
		});
		expect((await api.run(runId)).status).toBe("failed");
		await agent.expectNoAssign(300);
	});
});
