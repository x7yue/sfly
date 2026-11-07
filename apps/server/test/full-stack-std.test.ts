// 全栈：标准节点包 sfly-std（ADR 0017）像用户的节点包一样单独上传到真实的控制面，场景锁定它的版本，
// 真实的 Agent 从控制面安装它（依赖从 PyPI 镜像桩安装，不访问外网）并执行标准节点。
// 新增标准节点的全栈场景加在这个文件里（各自一个 it）。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logsApi } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type PypiStub, startPypiStub } from "./support/pypi-stub.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { buildStdPackage, type StdPackage, wheelhouse } from "./support/std-package.js";
import { publishArchive } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const AGENT = "std-agent";

describe("全栈：标准节点包 sfly-std", () => {
	let dir: string;
	let cp: TestControlPlane;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let pypi: PypiStub;
	let agent: RealAgent;
	let std: StdPackage;

	beforeAll(async () => {
		const bin = agentBinary();
		dir = await mkdtemp(join(tmpdir(), "sfly-full-std-"));
		let wheels: Awaited<ReturnType<typeof wheelhouse>>;
		[cp, venv, std, wheels] = await Promise.all([
			startTestControlPlane(),
			createStubVenv({ sdkOnly: true }),
			buildStdPackage(join(dir, "dist")),
			wheelhouse(join(dir, "wheels"), [], { withStdDependencies: true }),
		]);
		pypi = await startPypiStub(wheels);
		await publishArchive(cp, await readFile(std.path));
		agent = await startRealAgent({
			grpcUrl: cp.grpcUrl,
			name: AGENT,
			venv: venv.path,
			args: ["--index-url", pypi.indexUrl],
			bin,
		});
	}, 600_000);

	afterAll(async () => {
		await agent?.close();
		await cp?.close();
		await pypi?.close();
		await venv?.remove();
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	/** 只用 sfly-std 的场景：entry 之后按顺序串起 nodes，锁定刚上传的版本，运行到结束。 */
	async function runChain(nodes: Array<Record<string, unknown>>) {
		const api = new ApiClient(cp);
		const ids = ["entry", ...nodes.map((n) => n.id as string)];
		const id = await api.orchestrationWith({
			default_agent: AGENT,
			nodes: [
				{ id: "entry", kind: "entry" },
				...nodes.map((n) => ({ kind: "package", package: "sfly-std", ...n })),
			],
			edges: ids.slice(1).map((to, i) => ({ from: ids[i], to, kind: "chain" })),
			packages: { "sfly-std": std.version },
		});
		const runId = await api.triggerOk(id);
		await eventually(
			async () => expect(["success", "failed"]).toContain((await api.run(runId)).status),
			120_000,
		);
		return { api, runId };
	}

	it("上传后 Agent 从控制面安装 sfly-std 并运行 shell；后一个 shell 引用前一个的输出", async () => {
		const { api, runId } = await runChain([
			{ id: "hello", node: "shell", inputs: { command: "echo 你好" } },
			{
				id: "greet",
				node: "shell",
				inputs: {
					command: 'printf "%s世界" "$GREETING"',
					shell: "/bin/bash",
					env: { GREETING: "${{ nodes.hello.outputs.stdout }}" },
				},
			},
		]);

		expect((await api.run(runId)).status).toBe("success");
		const hello = await api.node(runId, "hello");
		expect(hello).toMatchObject({ status: "success", agent: AGENT });
		expect(hello.outputs).toEqual({ exit_code: 0, stdout: "你好\n" });
		expect((await api.node(runId, "greet")).outputs).toEqual({
			exit_code: 0,
			stdout: "你好\n世界",
		});
		const { agents } = await api.getJson<{
			agents: Array<{ installed_packages: Array<{ name: string; version: string }> }>;
		}>("/agents");
		expect(agents[0]?.installed_packages).toEqual([{ name: "sfly-std", version: std.version }]);
	}, 180_000);

	it("退出码不在 ok_exit_codes 中时 shell 失败，错误信息附 stderr 末尾，输出实时成为任务日志", async () => {
		const { api, runId } = await runChain([
			{
				id: "broken",
				node: "shell",
				inputs: { command: "echo 开始检查; echo 配置文件缺失 >&2; exit 2" },
			},
		]);

		expect((await api.run(runId)).status).toBe("failed");
		const broken = await api.node(runId, "broken");
		expect(broken.error?.kind).toBe("node_error");
		expect(broken.error?.message).toMatch(
			/^sfly_std\.shell\.CommandFailed: 命令退出码 2，不在 ok_exit_codes \[0\] 中：[\s\S]*配置文件缺失/,
		);
		const taskId = broken.attempts[0]?.task_id as string;
		const page = logsApi.page.response.parse(
			await api.getJson(`/tasks/${encodeURIComponent(taskId)}/logs`),
		);
		expect(page.lines.map((l) => [l.source, l.text])).toEqual(
			expect.arrayContaining([
				["stdout", "开始检查"],
				["stderr", "配置文件缺失"],
			]),
		);
	}, 180_000);

	it("assert 引用 shell 的输出并断言通过；断言不通过时运行失败，错误信息逐条列出", async () => {
		const count = {
			id: "count",
			node: "shell",
			inputs: { command: "printf '%s\\n' a b c | wc -l" },
		};
		const actual = {
			exit_code: "${{ nodes.count.outputs.exit_code }}",
			stdout: "${{ nodes.count.outputs.stdout }}",
		};
		const passing = await runChain([
			count,
			{
				id: "check",
				node: "assert",
				inputs: {
					actual,
					assertions: [
						{ path: "$.exit_code", op: "eq", value: 0 },
						{ path: "$.stdout", op: "ge", value: 3 },
						{ path: "$.stdout", op: "matches", value: "^\\s*3$" },
					],
				},
			},
		]);
		expect((await passing.api.run(passing.runId)).status).toBe("success");
		expect((await passing.api.node(passing.runId, "check")).outputs).toEqual({ passed: true });

		const failing = await runChain([
			count,
			{
				id: "check",
				node: "assert",
				inputs: {
					actual,
					assertions: [
						{ path: "$.exit_code", op: "eq", value: 0 },
						{ path: "$.stdout", op: "gt", value: 10 },
					],
				},
			},
		]);
		expect((await failing.api.run(failing.runId)).status).toBe("failed");
		const check = await failing.api.node(failing.runId, "check");
		expect(check.error?.kind).toBe("node_error");
		expect(check.error?.message).toMatch(
			/^sfly_std\.assert_\.AssertionFailed: 2 条断言中 1 条不通过：\n- 第 2 条：\$\.stdout 应 gt 10，实际是 "\s*3\\n"\n/,
		);
	}, 300_000);
});
