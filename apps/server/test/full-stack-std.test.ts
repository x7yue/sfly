// 全栈：标准节点包 sfly-std（ADR 0017、0030）由平台管理员发布到公共项目（POST /projects/public/packages，#565），
// 场景锁定它的版本，真实的 Agent 从控制面安装它（依赖从 PyPI 镜像桩安装，不访问外网）并执行三个标准节点
// （shell、start_process、stop_process）。辅助函数在业务节点里的用法在 full-stack-std-helpers.test.ts。
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { logsApi } from "@sfly/schema";
import { afterAll, beforeAll, expect, it } from "vitest";
import { systemClock } from "../src/clock.js";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { describeWithAgent } from "./support/describe-with-agent.js";
import { eventually } from "./support/eventually.js";
import { type PypiStub, startPypiStub } from "./support/pypi-stub.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import {
	buildStdPackage,
	buildStdPackageVariant,
	publishIntoPublicProject,
	type StdPackage,
	wheelhouse,
} from "./support/std-package.js";
import { publishTestPackage } from "./support/stub-package.js";
import { makeTempDir } from "./support/temp-dir.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const AGENT = "std-agent";

describeWithAgent("全栈：标准节点包 sfly-std", () => {
	let dir: string;
	let cp: TestControlPlane;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let pypi: PypiStub;
	let agent: RealAgent;
	let std: StdPackage;

	beforeAll(async () => {
		const bin = agentBinary();
		dir = await makeTempDir("sfly-full-std-");
		let wheels: Awaited<ReturnType<typeof wheelhouse>>;
		// 指标点的时间戳来自真实 Agent 的系统时钟，控制面也用系统时钟：否则超出保留期的可接收范围而被丢弃（#32）。
		[cp, venv, std, wheels] = await Promise.all([
			startTestControlPlane({ clock: systemClock }),
			createStubVenv({ sdkOnly: true }),
			buildStdPackage(join(dir, "dist")),
			wheelhouse(join(dir, "wheels"), [], { withStdDependencies: true }),
		]);
		pypi = await startPypiStub(wheels);
		await publishIntoPublicProject(cp, new Uint8Array(await readFile(std.path)), {
			name: "sfly-std",
			version: std.version,
		});
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

	/** 只用 sfly-std 的场景：entry 之后按顺序串起 nodes，锁定 sfly-std 的 version（默认刚上传的版本），返回场景 ID。 */
	async function saveChain(nodes: Array<Record<string, unknown>>, version = std.version) {
		const ids = ["entry", ...nodes.map((n) => n.id as string)];
		return new ApiClient(cp).orchestrationWith({
			default_agent: AGENT,
			nodes: [
				{ id: "entry", kind: "entry" },
				...nodes.map((n) => ({ kind: "package", package: "sfly-std", ...n })),
			],
			edges: ids.slice(1).map((to, i) => ({ from: ids[i], to, kind: "chain" })),
			packages: { "sfly-std": version },
		});
	}

	/** 触发场景并等运行结束。 */
	async function runToEnd(orchestrationId: string) {
		const api = new ApiClient(cp);
		const runId = await api.triggerOk(orchestrationId);
		await eventually(
			async () => expect(["success", "failed"]).toContain((await api.run(runId)).status),
			120_000,
		);
		return { api, runId };
	}

	/** saveChain 后立即运行到结束。 */
	async function runChain(nodes: Array<Record<string, unknown>>) {
		return runToEnd(await saveChain(nodes));
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
		// 没有打开 save_output：两个产物引用是空值。
		const rest = { stderr: "", stdout_file: null, stderr_file: null };
		expect(hello.outputs).toEqual({ exit_code: 0, stdout: "你好\n", ...rest });
		expect((await api.node(runId, "greet")).outputs).toEqual({
			exit_code: 0,
			stdout: "你好\n世界",
			...rest,
		});
		const { agents } = await api.getJson<{
			agents: Array<{ installed_packages: Array<{ name: string; version: string }> }>;
		}>("/projects/default/agents");
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

	it("start_process 启动的进程在节点结束后继续运行，日志在后台进程目录；always 的 stop_process 在前面失败后停止它", async () => {
		const { api, runId } = await runChain([
			{ id: "server", node: "start_process", inputs: { command: "echo 已启动; exec sleep 300" } },
			{
				id: "alive",
				node: "shell",
				inputs: { command: "kill -0 ${{ nodes.server.outputs.pid }} && exit 1" },
			},
			{
				id: "stop",
				node: "stop_process",
				always: true,
				inputs: { pid: "${{ nodes.server.outputs.pid }}", grace: 5 },
			},
		]);

		expect((await api.run(runId)).status).toBe("failed");
		const server = await api.node(runId, "server");
		expect(server.status).toBe("success");
		const { pid, log_file } = server.outputs as { pid: number; log_file: string };
		expect(log_file.endsWith(`/procs/${runId}/server.log`)).toBe(true);
		expect(await readFile(log_file, "utf8")).toBe("已启动\n");
		// alive 节点在 server 结束后检查到进程仍在运行（kill -0 成功），按设计以退出码 1 失败。
		expect((await api.node(runId, "alive")).error?.message).toMatch(/命令退出码 1/);
		const stop = await api.node(runId, "stop");
		expect(stop).toMatchObject({
			status: "success",
			outputs: { was_running: true, exit_code: 143 },
		});
		expect(() => process.kill(pid, 0)).toThrow();
	}, 180_000);

	it("shell 打开 save_output 保存的完整输出，另一台 Agent 上的节点用 ctx.artifacts.download 下载，内容一致", async () => {
		// 后续节点在测试用的节点包 sfly-download 里（testdata/download-package），由另一台 Agent 执行：
		// 它有自己的共享 venv 和工作目录，拿不到上游 Agent 上的文件，只能从控制面下载。
		const OTHER = "std-agent-other";
		await publishTestPackage(cp, "testdata/download-package", "sfly-download-0.1.0.sflypkg");
		const otherVenv = await createStubVenv({ sdkOnly: true });
		const other = await startRealAgent({
			grpcUrl: cp.grpcUrl,
			name: OTHER,
			venv: otherVenv.path,
			args: ["--index-url", pypi.indexUrl],
		});
		try {
			// 超过 64 KiB：输出里的 stdout 只有末尾，完整内容只在产物里。
			const full = Array.from({ length: 20_000 }, (_, i) => `第 ${i + 1} 行\n`).join("");
			const api = new ApiClient(cp);
			const { runId } = await runToEnd(
				await api.orchestrationWith({
					default_agent: AGENT,
					nodes: [
						{ id: "entry", kind: "entry" },
						{
							id: "produce",
							kind: "package",
							package: "sfly-std",
							node: "shell",
							inputs: {
								command: 'i=1; while [ $i -le 20000 ]; do echo "第 $i 行"; i=$((i+1)); done',
								save_output: true,
							},
						},
						{
							id: "consume",
							kind: "package",
							package: "sfly-download",
							node: "fetch_artifact",
							agent: OTHER,
							inputs: { ref: "${{ nodes.produce.outputs.stdout_file }}" },
						},
					],
					edges: [
						{ from: "entry", to: "produce", kind: "chain" },
						{ from: "produce", to: "consume", kind: "chain" },
					],
					packages: { "sfly-std": std.version, "sfly-download": "0.1.0" },
				}),
			);

			expect((await api.run(runId)).status).toBe("success");
			const produce = await api.node(runId, "produce");
			expect(produce.agent).toBe(AGENT);
			// stdout 的尾部超过 16 KiB，运行视图里只给大小（#633）：全文用 /tasks/:id/io 取。
			const outputs = (await api.nodeOutputs(runId, "produce")) as {
				stdout: string;
				stdout_file: string;
			};
			expect(Buffer.byteLength(full)).toBeGreaterThan(64 * 1024);
			expect(outputs.stdout.length).toBeLessThan(full.length);
			expect(full.endsWith(outputs.stdout)).toBe(true);
			const consume = await api.node(runId, "consume");
			expect(consume).toMatchObject({ status: "success", agent: OTHER });
			expect(consume.outputs).toEqual({
				size: Buffer.byteLength(full),
				sha256: createHash("sha256").update(full).digest("hex"),
			});
		} finally {
			await other.close();
			await otherVenv.remove();
		}
	}, 300_000);

	it("单独发布新版本后，锁定旧版本的场景行为不变：shell 在 Agent 上按锁定的版本执行", async () => {
		// 新版本把 shell 的默认解释器改成 /bin/bash：同一条命令在两个版本上的结果不同，能看出 Agent 执行的是哪个版本。
		const next = await buildStdPackageVariant(join(dir, "dist-next"), {
			version: "99.0.0",
			edits: [["src/sfly_std/shell.py", '= "/bin/sh"', '= "/bin/bash"']],
		});
		// $0 是实际执行命令的解释器：不用 $BASH_VERSION 区分，有的系统上 /bin/sh 就是 bash。
		const chain = [{ id: "probe", node: "shell", inputs: { command: 'echo "$0"' } }];
		// 场景先锁定已发布的版本，之后才发布新版本。
		const locked = await saveChain(chain);
		await publishIntoPublicProject(cp, new Uint8Array(await readFile(next.path)), {
			name: "sfly-std",
			version: next.version,
		});
		const upgraded = await saveChain(chain, next.version);

		const installed = async () =>
			(
				await new ApiClient(cp).getJson<{
					agents: Array<{ installed_packages: Array<{ name: string; version: string }> }>;
				}>("/projects/default/agents")
			).agents[0]?.installed_packages;
		const outputOf = async ({ api, runId }: { api: ApiClient; runId: string }) => {
			expect((await api.run(runId)).status).toBe("success");
			return (await api.node(runId, "probe")).outputs;
		};
		const rest = { exit_code: 0, stderr: "", stdout_file: null, stderr_file: null };

		expect(await outputOf(await runToEnd(upgraded))).toEqual({ ...rest, stdout: "/bin/bash\n" });
		expect(await installed()).toEqual([{ name: "sfly-std", version: next.version }]);

		expect(await outputOf(await runToEnd(locked))).toEqual({ ...rest, stdout: "/bin/sh\n" });
		expect(await installed()).toEqual([{ name: "sfly-std", version: std.version }]);
	}, 300_000);
});
