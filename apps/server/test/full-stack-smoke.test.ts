// 全栈冒烟：真实的控制面、真实的 Rust Agent、真实的 SDK 执行器，
// 在装好桩节点包的共享 venv 中跑通一条两个节点的链，后一个节点引用前一个节点的输出。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentBinary, repoRoot } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
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

describe("全栈冒烟：两个节点的链", () => {
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
});

describe("全栈冒烟：Agent 从控制面下载并安装节点包", () => {
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

describe("全栈冒烟：开发模式 sfly dev", () => {
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

	const runOn = async (api: ApiClient, agent: string) => {
		const id = await api.orchestrationWith({
			default_agent: agent,
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "a", kind: "package", package: "smoke-dev", node: "about", inputs: {} },
			],
			edges: [{ from: "entry", to: "a", kind: "chain" }],
			packages: { "smoke-dev": "dev" },
		});
		const runId = await api.triggerOk(id);
		await eventually(
			async () => expect(["success", "failed"]).toContain((await api.run(runId)).status),
			60_000,
		);
		return api.node(runId, "a");
	};

	it("sfly dev 加载本地源码后可以在画布上选用 @dev 运行，修改源码后下一次运行生效；其他 Agent 以 env_error 失败", async () => {
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

		expect(await runOn(api, "dev-agent")).toMatchObject({
			status: "success",
			outputs: { source: "v1" },
		});
		await writeNode("v2-edited");
		expect(await runOn(api, "dev-agent")).toMatchObject({
			status: "success",
			outputs: { source: "v2-edited" },
		});

		const other = await runOn(api, "other-agent");
		expect(other.status).toBe("failed");
		expect(other.error?.kind).toBe("env_error");
		expect(other.error?.message).toContain("smoke-dev@dev");
	}, 120_000);
});
