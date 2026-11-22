// 全栈冒烟：真实的控制面、真实的 Rust Agent、真实的 SDK 执行器，
// 在装好桩节点包的共享 venv 中跑通一条两个节点的链，后一个节点引用前一个节点的输出。
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agentBinary, repoRoot } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { describeWithAgent } from "./support/describe-with-agent.js";
import { eventually } from "./support/eventually.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 用真实的 sfly CLI 构建桩节点包，经 HTTP API 发布（触发前的预检要求锁定的包版本已发布）。 */
async function publishStubPackage(cp: TestControlPlane): Promise<void> {
	const out = await mkdtemp(join(tmpdir(), "sfly-stub-pkg-"));
	try {
		await promisify(execFile)(
			"uv",
			["run", "--locked", "--quiet", "sfly", "build", "testdata/stub-package", "--out", out],
			{ cwd: repoRoot },
		);
		const archive = await readFile(join(out, "sfly-stub-0.1.0.sflypkg"));
		const res = await cp.fetch("/packages", {
			method: "POST",
			headers: { "content-type": "application/octet-stream" },
			body: archive,
		});
		expect(res.status).toBe(201);
	} finally {
		await rm(out, { recursive: true, force: true });
	}
}

describeWithAgent("全栈冒烟：两个节点的链", () => {
	let cp: TestControlPlane;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let agent: RealAgent;

	beforeAll(async () => {
		const bin = agentBinary();
		[cp, venv] = await Promise.all([startTestControlPlane(), createStubVenv()]);
		await publishStubPackage(cp);
		agent = await startRealAgent({
			grpcUrl: cp.grpcUrl,
			name: "smoke-agent",
			venv: venv.path,
			bin,
		});
	}, 600_000);

	afterAll(async () => {
		await agent?.close();
		await cp?.close();
		await venv?.remove();
	});

	it("入口参数 → 节点 a → 节点 b（引用 a 的输出），运行成功", async () => {
		const api = new ApiClient(cp);
		const id = await api.orchestrationWith({
			default_agent: "smoke-agent",
			nodes: [
				{ id: "entry", kind: "entry", params: [{ name: "who", type: "string", required: true }] },
				{
					id: "a",
					kind: "package",
					package: "sfly-stub",
					node: "echo",
					inputs: { text: "你好，${{ params.who }}" },
				},
				{
					id: "b",
					kind: "package",
					package: "sfly-stub",
					node: "echo",
					inputs: { text: "${{ nodes.a.outputs.text }}！" },
				},
			],
			edges: [
				{ from: "entry", to: "a", kind: "chain" },
				{ from: "a", to: "b", kind: "chain" },
			],
			packages: { "sfly-stub": "0.1.0" },
		});

		const runId = await api.triggerOk(id, { who: "世界" });

		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 30_000);
		const a = await api.node(runId, "a");
		const b = await api.node(runId, "b");
		expect(a).toMatchObject({ status: "success", agent: "smoke-agent" });
		expect(a.outputs).toEqual({ text: "你好，世界" });
		expect(b.attempts[0]?.inputs).toEqual({ text: "你好，世界！" });
		expect(b.outputs).toEqual({ text: "你好，世界！" });

		const [registered] = (
			await api.getJson<{ agents: Array<{ info: { installed_packages: unknown } }> }>("/agents")
		).agents;
		expect(registered?.info.installed_packages).toEqual([{ name: "sfly-stub", version: "0.1.0" }]);
	}, 60_000);

	it("节点抛出异常时任务以 node_error 失败，运行失败", async () => {
		const api = new ApiClient(cp);
		const id = await api.orchestrationWith({
			default_agent: "smoke-agent",
			nodes: [
				{ id: "entry", kind: "entry" },
				{
					id: "boom",
					kind: "package",
					package: "sfly-stub",
					node: "fail",
					inputs: { message: "桩节点失败" },
				},
			],
			edges: [{ from: "entry", to: "boom", kind: "chain" }],
			packages: { "sfly-stub": "0.1.0" },
		});

		const runId = await api.triggerOk(id);

		await eventually(async () => expect((await api.run(runId)).status).toBe("failed"), 30_000);
		const node = await api.node(runId, "boom");
		expect(node.status).toBe("failed");
		expect(node.error?.kind).toBe("node_error");
		expect(node.error?.message).toMatch(/^RuntimeError: 桩节点失败/);
	}, 60_000);

	it("给节点传一个没有声明的输入：保存时警告、触发前预检拦下，写明声明了哪些输入，不派发到 Agent", async () => {
		// 没有声明的输入，执行器在运行时也会以 config_error 拒绝（agent/tests/execute.rs、sdk 的 test_runner.py 守着），
		// 但真实的节点包元信息控制面都有，所以在更早的地方就拦下了，任务不会占一次派发（#444）。
		const api = new ApiClient(cp);
		const id = await api.createOrchestration("写错输入名");
		const saved = await api.post(`/orchestrations/${id}/versions`, {
			base_version: 0,
			document: {
				default_agent: "smoke-agent",
				nodes: [
					{ id: "entry", kind: "entry" },
					{
						id: "typo",
						kind: "package",
						package: "sfly-stub",
						node: "echo",
						inputs: { text: "x", tex: "写错了的名字" },
						retries: 2,
					},
				],
				edges: [{ from: "entry", to: "typo", kind: "chain" }],
				packages: { "sfly-stub": "0.1.0" },
			},
		});
		expect(saved.status, await saved.clone().text()).toBe(201);
		const message = "节点 typo 的输入 tex 没有声明：节点类型 echo 声明的输入有 text；删掉这个输入";
		expect(((await saved.json()) as { warnings: unknown[] }).warnings).toEqual([
			{ code: "input_not_declared", node_id: "typo", input: "tex", message },
		]);

		const refused = await api.trigger(id);
		expect(refused.status).toBe(400);
		const { error } = (await refused.json()) as {
			error: { code: string; details: { code: string; message: string }[] };
		};
		expect(error.code).toBe("invalid_orchestration");
		expect(error.details).toMatchObject([{ code: "input_not_declared", message }]);
		const { runs } = await api.getJson<{ runs: unknown[] }>(`/orchestrations/${id}/runs`);
		expect(runs).toEqual([]);
	}, 60_000);

	it("超时的任务以 timeout 失败并按 retries 重试；最终失败后普通节点跳过、always 节点照常执行", async () => {
		const api = new ApiClient(cp);
		const id = await api.orchestrationWith({
			default_agent: "smoke-agent",
			nodes: [
				{ id: "entry", kind: "entry" },
				{
					id: "slow",
					kind: "package",
					package: "sfly-stub",
					node: "sleep",
					inputs: { seconds: 60 },
					timeout: 1,
					retries: 1,
				},
				{ id: "next", kind: "package", package: "sfly-stub", node: "echo", inputs: { text: "x" } },
				{
					id: "cleanup",
					kind: "package",
					package: "sfly-stub",
					node: "echo",
					always: true,
					inputs: { text: "slept=${{ nodes.slow.outputs.slept }}" },
				},
			],
			edges: [
				{ from: "entry", to: "slow", kind: "chain" },
				{ from: "slow", to: "next", kind: "chain" },
				{ from: "next", to: "cleanup", kind: "chain" },
			],
			packages: { "sfly-stub": "0.1.0" },
		});

		const runId = await api.triggerOk(id);

		await eventually(async () => expect((await api.run(runId)).status).toBe("failed"), 30_000);
		const slow = await api.node(runId, "slow");
		expect(slow.attempts.map((a) => [a.attempt, a.status, a.error?.kind])).toEqual([
			[1, "failed", "timeout"],
			[2, "failed", "timeout"],
		]);
		expect((await api.node(runId, "next")).status).toBe("skipped");
		const cleanup = await api.node(runId, "cleanup");
		expect(cleanup.status).toBe("success");
		expect(cleanup.outputs).toEqual({ text: "slept=null" });
	}, 60_000);

	it("取消运行：正在运行的节点感知到 ctx.cancelled() 并被终止，普通节点 cancelled，always 节点照常执行", async () => {
		const api = new ApiClient(cp);
		const dir = await mkdtemp(join(tmpdir(), "sfly-cancel-"));
		const ready = join(dir, "ready");
		const report = join(dir, "report");
		const id = await api.orchestrationWith({
			default_agent: "smoke-agent",
			nodes: [
				{ id: "entry", kind: "entry" },
				{
					id: "wait",
					kind: "package",
					package: "sfly-stub",
					node: "wait_cancel",
					inputs: { ready_file: ready, report_file: report },
				},
				{ id: "next", kind: "package", package: "sfly-stub", node: "echo", inputs: { text: "x" } },
				{
					id: "cleanup",
					kind: "package",
					package: "sfly-stub",
					node: "echo",
					always: true,
					inputs: { text: "cleaned" },
				},
			],
			edges: [
				{ from: "entry", to: "wait", kind: "chain" },
				{ from: "wait", to: "next", kind: "chain" },
				{ from: "next", to: "cleanup", kind: "chain" },
			],
			packages: { "sfly-stub": "0.1.0" },
		});
		try {
			const runId = await api.triggerOk(id);
			await eventually(async () => expect(await readFile(ready, "utf8")).not.toBe(""), 30_000);
			await api.cancelOk(runId);

			await eventually(async () => expect((await api.run(runId)).status).toBe("cancelled"), 30_000);
			expect(await readFile(report, "utf8")).toBe("cancelled");
			const wait = await api.node(runId, "wait");
			expect(wait.status).toBe("cancelled");
			expect(wait.attempts).toHaveLength(1);
			expect((await api.node(runId, "next")).status).toBe("cancelled");
			const cleanup = await api.node(runId, "cleanup");
			expect(cleanup.status).toBe("success");
			expect(cleanup.outputs).toEqual({ text: "cleaned" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});

describeWithAgent("全栈冒烟：Agent 从控制面下载并安装节点包", () => {
	let cp: TestControlPlane;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let agent: RealAgent;

	beforeAll(async () => {
		const bin = agentBinary();
		[cp, venv] = await Promise.all([startTestControlPlane(), createStubVenv({ sdkOnly: true })]);
		await publishStubPackage(cp);
		agent = await startRealAgent({
			grpcUrl: cp.grpcUrl,
			name: "install-agent",
			venv: venv.path,
			// 桩节点包没有第三方依赖；镜像地址指向一个不可用的本地端口，确保安装不访问外网。
			args: ["--index-url", "http://127.0.0.1:9/simple/"],
			bin,
		});
	}, 600_000);

	afterAll(async () => {
		await agent?.close();
		await cp?.close();
		await venv?.remove();
	});

	it("共享 venv 里没有节点包时，Agent 下载安装后执行任务，已安装列表随之更新", async () => {
		const api = new ApiClient(cp);
		const before = await api.getJson<{
			agents: Array<{ installed_packages: unknown }>;
		}>("/agents");
		expect(before.agents[0]?.installed_packages).toEqual([]);

		const id = await api.orchestrationWith({
			default_agent: "install-agent",
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "a", kind: "package", package: "sfly-stub", node: "about", inputs: {} },
			],
			edges: [{ from: "entry", to: "a", kind: "chain" }],
			packages: { "sfly-stub": "0.1.0" },
		});
		const runId = await api.triggerOk(id);

		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 60_000);
		expect((await api.node(runId, "a")).outputs).toEqual({
			package: "sfly-stub",
			version: "0.1.0",
		});
		const after = await api.getJson<{
			agents: Array<{ installed_packages: unknown; install: unknown }>;
		}>("/agents");
		expect(after.agents[0]).toMatchObject({
			installed_packages: [{ name: "sfly-stub", version: "0.1.0" }],
			install: { package: "sfly-stub", version: "0.1.0", state: "installed" },
		});
	}, 90_000);
});

describeWithAgent("全栈冒烟：开发模式 sfly dev", () => {
	let cp: TestControlPlane;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let devAgent: RealAgent;
	let otherAgent: RealAgent;
	let project: string;
	const writeNode = (marker: string) =>
		writeFile(
			join(project, "src", "smoke_dev", "__init__.py"),
			`from sfly import node\n\n\n@node\ndef about() -> dict:\n    return {"source": ${JSON.stringify(marker)}}\n`,
		);

	beforeAll(async () => {
		const bin = agentBinary();
		[cp, venv] = await Promise.all([startTestControlPlane(), createStubVenv({ sdkOnly: true })]);
		project = await mkdtemp(join(tmpdir(), "sfly-dev-project-"));
		await mkdir(join(project, "src", "smoke_dev"), { recursive: true });
		await writeFile(
			join(project, "pyproject.toml"),
			'[project]\nname = "smoke-dev"\nversion = "0.1.0"\ndependencies = []\n',
		);
		await writeNode("v1");
		const index = ["--index-url", "http://127.0.0.1:9/simple/"];
		[devAgent, otherAgent] = await Promise.all([
			startRealAgent({ grpcUrl: cp.grpcUrl, name: "dev-agent", venv: venv.path, args: index, bin }),
			startRealAgent({ grpcUrl: cp.grpcUrl, name: "other-agent", args: index, bin }),
		]);
	}, 600_000);

	afterAll(async () => {
		await devAgent?.close();
		await otherAgent?.close();
		await cp?.close();
		await venv?.remove();
		if (project) await rm(project, { recursive: true, force: true });
	});

	/** 一个只有 smoke-dev@dev 节点、派发到指定 Agent 的场景。 */
	const devScenarioOn = (api: ApiClient, agent: string) =>
		api.orchestrationWith({
			default_agent: agent,
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "a", kind: "package", package: "smoke-dev", node: "about", inputs: {} },
			],
			edges: [{ from: "entry", to: "a", kind: "chain" }],
			packages: { "smoke-dev": "dev" },
		});

	/** 触发并等运行结束，返回节点 a。 */
	const runScenario = async (api: ApiClient, id: string) => {
		const runId = await api.triggerOk(id);
		await eventually(
			async () => expect(["success", "failed"]).toContain((await api.run(runId)).status),
			60_000,
		);
		return api.node(runId, "a");
	};

	it("sfly dev 加载本地源码后可以在画布上选用 @dev 运行，修改源码后下一次运行生效；在线但没有加载的 Agent 触发前被拦下，触发时不在线、上线后没有加载的以 env_error 失败", async () => {
		const api = new ApiClient(cp);
		const socket = join(devAgent.workDir, "tasks", "agent.sock");
		const { stdout } = await promisify(execFile)(
			"uv",
			["run", "--locked", "--quiet", "sfly", "dev", project, "--socket", socket],
			{ cwd: repoRoot },
		);
		expect(stdout).toContain("smoke-dev@dev");
		await eventually(async () => {
			const { agents } = await api.getJson<{
				agents: Array<{ name: string; dev_packages: Array<{ name: string }> }>;
			}>("/agents");
			expect(agents.find((a) => a.name === "dev-agent")?.dev_packages).toMatchObject([
				{ name: "smoke-dev" },
			]);
		});

		const onDevAgent = await devScenarioOn(api, "dev-agent");
		expect(await runScenario(api, onDevAgent)).toMatchObject({
			status: "success",
			outputs: { source: "v1" },
		});
		await writeNode("v2-edited");
		expect(await runScenario(api, onDevAgent)).toMatchObject({
			status: "success",
			outputs: { source: "v2-edited" },
		});

		// 在线、没有加载它的 Agent：预检写明是哪个节点、哪台 Agent，不产生运行。
		const onOther = await devScenarioOn(api, "other-agent");
		const refused = await api.trigger(onOther);
		expect(refused.status).toBe(400);
		const { error } = (await refused.json()) as { error: { details: Array<{ code: string }> } };
		expect(error.details.map((d) => d.code)).toEqual(["dev_package_not_loaded"]);

		// 触发时不在线的 Agent：预检不知道它加载了什么，不阻断；它重新连上、没有加载，Agent 执行时以 env_error 失败。
		await otherAgent.close();
		await eventually(async () => {
			const { agents } = await api.getJson<{ agents: Array<{ name: string; status: string }> }>(
				"/agents",
			);
			expect(agents.find((a) => a.name === "other-agent")?.status).toBe("offline");
		});
		const runId = await api.triggerOk(onOther);
		otherAgent = await startRealAgent({
			grpcUrl: cp.grpcUrl,
			name: "other-agent",
			args: ["--index-url", "http://127.0.0.1:9/simple/"],
			bin: agentBinary(),
		});
		await eventually(async () => expect((await api.run(runId)).status).toBe("failed"), 60_000);
		const other = await api.node(runId, "a");
		expect(other.status).toBe("failed");
		expect(other.error?.kind).toBe("env_error");
		expect(other.error?.message).toContain("smoke-dev@dev");
	}, 120_000);
});
