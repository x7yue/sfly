// 全栈：标准节点包 sfly-std（ADR 0017）像用户的节点包一样单独上传到真实的控制面，场景锁定它的版本，
// 真实的 Agent 从控制面安装它（依赖从 PyPI 镜像桩安装，不访问外网）并执行标准节点。
// 新增标准节点的全栈场景加在这个文件里（各自一个 it）。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logsApi, metricsApi } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemClock } from "../src/clock.js";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type PypiStub, startPypiStub } from "./support/pypi-stub.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import {
	buildStdPackage,
	buildStdPackageVariant,
	type StdPackage,
	wheelhouse,
} from "./support/std-package.js";
import { publishArchive, publishTestPackage } from "./support/stub-package.js";
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
		// 指标点的时间戳来自真实 Agent 的系统时钟，控制面也用系统时钟：否则超出保留期的可接收范围而被丢弃（#32）。
		[cp, venv, std, wheels] = await Promise.all([
			startTestControlPlane({ clock: systemClock }),
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

	it("http_request 用 until_ok 等服务就绪并断言响应 JSON，assert 引用它的输出", async () => {
		const { createServer } = await import("node:http");
		let requests = 0;
		const server = createServer((_req, res) => {
			requests += 1;
			if (requests < 3) {
				res.writeHead(503).end("starting");
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ status: "ok", version: "1.2.3" }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as { port: number };
		try {
			const { api, runId } = await runChain([
				{
					id: "ready",
					node: "http_request",
					inputs: {
						url: `http://127.0.0.1:${port}/health`,
						expect_json: [{ path: "$.status", op: "eq", value: "ok" }],
						until_ok: true,
						wait: 60,
						poll: 0.2,
					},
				},
				{
					id: "check",
					node: "assert",
					inputs: {
						actual: "${{ nodes.ready.outputs.json }}",
						assertions: [{ path: "$.version", op: "eq", value: "1.2.3" }],
					},
				},
			]);

			expect((await api.run(runId)).status).toBe("success");
			const ready = await api.node(runId, "ready");
			expect(ready.outputs).toMatchObject({
				status: 200,
				json: { status: "ok", version: "1.2.3" },
			});
			expect(requests).toBe(3);
		} finally {
			server.close();
		}
	}, 180_000);

	/** 运行里唯一一个节点的指标目录：声明的图表标题、第一次尝试的各序列（不带标签的序列只有名字）。 */
	async function monitorCatalog(api: ApiClient, runId: string) {
		const catalog = metricsApi.catalog.response.parse(await api.getJson(`/runs/${runId}/metrics`));
		const node = catalog.nodes.find((n) => n.node_id === "monitor");
		const metrics = node?.attempts[0]?.metrics ?? [];
		return {
			node,
			charts: node?.charts.map((c) => c.title),
			totals: metrics.filter((m) => Object.keys(m.labels).length === 0),
			labelled: (name: string) => metrics.filter((m) => m.name === name).map((m) => m.labels),
			metrics,
		};
	}

	it("system_monitor 在 Agent 上按间隔上报声明的系统指标，另按每块网卡、每块磁盘各一个序列，duration 到期后成功", async () => {
		const { api, runId } = await runChain([
			{ id: "monitor", node: "system_monitor", inputs: { interval: 0.5, duration: 3 } },
		]);

		expect((await api.run(runId)).status).toBe("success");
		const { node, charts, totals, labelled, metrics } = await monitorCatalog(api, runId);
		expect(node).toMatchObject({
			node_id: "monitor",
			package: "sfly-std",
			node: "system_monitor",
			primary_metric: "cpu_percent",
		});
		expect(charts).toEqual([
			"CPU 使用率",
			"内存使用率",
			"已用内存",
			"负载",
			"磁盘空间使用率",
			"磁盘读写",
			"网络收发",
			"磁盘读写（按磁盘）",
			"网络收发（按网卡）",
		]);
		expect(totals.map((m) => m.name).sort()).toEqual([
			"cpu_percent",
			"disk_read_bytes_per_s",
			"disk_used_percent",
			"disk_write_bytes_per_s",
			"load1",
			"mem_used_bytes",
			"mem_used_percent",
			"net_rx_bytes_per_s",
			"net_tx_bytes_per_s",
		]);
		// 全部网卡（含回环网卡 lo），每块各一个序列，标签 nic。
		for (const name of ["net_rx_bytes_per_s_by_nic", "net_tx_bytes_per_s_by_nic"]) {
			const nics = labelled(name);
			expect(nics.every((l) => Object.keys(l).join() === "nic")).toBe(true);
			expect(nics.map((l) => l.nic)).toContain("lo");
		}
		// 整块磁盘，标签 disk；按磁盘的读、写覆盖同一组磁盘。
		const disks = labelled("disk_read_bytes_per_s_by_disk");
		expect(disks.every((l) => Object.keys(l).join() === "disk")).toBe(true);
		expect(labelled("disk_write_bytes_per_s_by_disk")).toEqual(disks);
		// Agent 按秒合并：3 秒的监控至少落在 2 个秒桶里。
		for (const metric of metrics) expect(metric.points, metric.name).toBeGreaterThanOrEqual(2);
	}, 180_000);

	it("process_monitor 上报目标进程的合计，另按每个进程各一个序列（标签 pid、name），合计与 processes.csv 不变", async () => {
		const { api, runId } = await runChain([
			{
				id: "server",
				node: "start_process",
				inputs: { command: "sleep 300 & exec sleep 300" },
			},
			{
				id: "monitor",
				node: "process_monitor",
				inputs: { pid: "${{ nodes.server.outputs.pid }}", interval: 0.5, duration: 3 },
			},
			{
				id: "stop",
				node: "stop_process",
				always: true,
				inputs: { pid: "${{ nodes.server.outputs.pid }}", grace: 5 },
			},
		]);

		expect((await api.run(runId)).status).toBe("success");
		const { pid } = (await api.node(runId, "server")).outputs as { pid: number };
		const monitor = await api.node(runId, "monitor");
		expect(Object.keys(monitor.outputs ?? {}).sort()).toEqual(["processes_csv", "samples"]);
		const { node, charts, totals, labelled, metrics } = await monitorCatalog(api, runId);
		expect(node?.primary_metric).toBe("cpu_percent");
		expect(charts).toEqual([
			"CPU",
			"内存",
			"线程与文件描述符",
			"磁盘读写",
			"CPU（按进程）",
			"内存（按进程）",
			"线程数（按进程）",
			"文件描述符（按进程）",
			"磁盘读写（按进程）",
		]);
		expect(totals.map((m) => m.name).sort()).toEqual([
			"cpu_percent",
			"io_read_bytes_per_s",
			"io_write_bytes_per_s",
			"open_fds",
			"rss_bytes",
			"threads",
		]);
		// start_process 启动的 sleep 和它的子进程 sleep：每个进程一个序列。
		for (const name of [
			"cpu_percent_by_process",
			"rss_bytes_by_process",
			"threads_by_process",
			"open_fds_by_process",
			"io_read_bytes_per_s_by_process",
			"io_write_bytes_per_s_by_process",
		]) {
			const processes = labelled(name);
			expect(processes, name).toHaveLength(2);
			expect(
				processes.map((l) => l.name),
				name,
			).toEqual(["sleep", "sleep"]);
			expect(
				processes.map((l) => l.pid),
				name,
			).toContain(String(pid));
		}
		for (const metric of metrics) expect(metric.points, metric.name).toBeGreaterThanOrEqual(2);
	}, 180_000);

	it("shell 写出结果文件，file_assert 检查后 collect_artifacts 收集为产物；refs 交给后面的节点，可以下载", async () => {
		const out = join(dir, "collect-out");
		const { api, runId } = await runChain([
			{
				id: "bench",
				node: "shell",
				inputs: {
					command: `mkdir -p '${out}/logs' && printf 'p99=12ms\\n' > '${out}/report.txt' && echo 启动完成 > '${out}/logs/app.log'`,
				},
			},
			{
				id: "report_ok",
				node: "file_assert",
				inputs: { path: `${out}/report.txt`, min_lines: 1, matches: "^p99=\\d+ms$" },
			},
			{
				id: "collect",
				node: "collect_artifacts",
				inputs: { paths: ["*.txt", "logs"], base_dir: out },
			},
			{
				id: "check",
				node: "assert",
				inputs: {
					actual: "${{ nodes.collect.outputs.refs }}",
					assertions: [
						{ path: '$["report.txt"]', op: "matches", value: "^https?://" },
						{ path: '$["logs/app.log"]', op: "exists" },
						{ path: "$", op: "len_eq", value: 2 },
					],
				},
			},
		]);

		expect((await api.run(runId)).status).toBe("success");
		const collect = await api.node(runId, "collect");
		const refs = collect.outputs?.refs as Record<string, string>;
		const taskId = collect.attempts[0]?.task_id as string;
		const listed = (await (
			await cp.fetch(`/tasks/${encodeURIComponent(taskId)}/artifacts`)
		).json()) as {
			artifacts: Array<{ name: string; url: string }>;
		};
		expect(refs).toEqual(Object.fromEntries(listed.artifacts.map((a) => [a.name, a.url])));
		expect(Object.keys(refs).sort()).toEqual(["logs/app.log", "report.txt"]);
		expect(await (await fetch(refs["report.txt"] as string)).text()).toBe("p99=12ms\n");
		expect(await (await fetch(refs["logs/app.log"] as string)).text()).toBe("启动完成\n");
		expect((await api.node(runId, "check")).outputs).toEqual({ passed: true });
	}, 180_000);

	it("shell 打开 save_output 保存的完整输出，另一台 Agent 上的节点用 ctx.artifacts.download 下载，内容一致", async () => {
		// 下游节点在测试用的节点包 sfly-download 里（testdata/download-package），由另一台 Agent 执行：
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
			const outputs = produce.outputs as { stdout: string; stdout_file: string };
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

	it("单独上传新版本后，锁定旧版本的场景行为不变：shell → assert → collect_artifacts 在 Agent 上按锁定的版本执行，产物可以下载", async () => {
		// 新版本把 shell 的默认解释器改成 /bin/bash：同一条命令在两个版本上的结果不同，能看出 Agent 执行的是哪个版本。
		const next = await buildStdPackageVariant(join(dir, "dist-next"), {
			version: "99.0.0",
			edits: [["src/sfly_std/shell.py", 'shell: str = "/bin/sh"', 'shell: str = "/bin/bash"']],
		});
		// $0 是实际执行命令的解释器：不用 $BASH_VERSION 区分，有的系统上 /bin/sh 就是 bash。
		const chain = (interpreter: string) => {
			const out = join(dir, `locked${interpreter.replaceAll("/", "-")}`);
			return [
				{
					id: "probe",
					node: "shell",
					inputs: {
						command: `mkdir -p '${out}' && echo "interpreter=$0" > '${out}/report.txt' && echo "$0"`,
					},
				},
				{
					id: "check",
					node: "assert",
					inputs: {
						actual: "${{ nodes.probe.outputs.stdout }}",
						assertions: [{ op: "eq", value: `${interpreter}\n` }],
					},
				},
				{
					id: "collect",
					node: "collect_artifacts",
					inputs: { paths: ["report.txt"], base_dir: out },
				},
			];
		};
		// 场景先锁定已上传的版本，之后才上传新版本。
		const locked = await saveChain(chain("/bin/sh"));
		await publishArchive(cp, await readFile(next.path));
		const upgraded = await saveChain(chain("/bin/bash"), next.version);

		const installed = async () =>
			(
				await new ApiClient(cp).getJson<{
					agents: Array<{ installed_packages: Array<{ name: string; version: string }> }>;
				}>("/agents")
			).agents[0]?.installed_packages;
		const download = async (api: ApiClient, runId: string) => {
			const collect = await api.node(runId, "collect");
			const refs = collect.outputs?.refs as Record<string, string>;
			expect(Object.keys(refs)).toEqual(["report.txt"]);
			return (await fetch(refs["report.txt"] as string)).text();
		};

		const onNext = await runToEnd(upgraded);
		expect((await onNext.api.run(onNext.runId)).status).toBe("success");
		expect(await installed()).toEqual([{ name: "sfly-std", version: next.version }]);
		expect(await download(onNext.api, onNext.runId)).toBe("interpreter=/bin/bash\n");

		const onLocked = await runToEnd(locked);
		expect((await onLocked.api.run(onLocked.runId)).status).toBe("success");
		expect(await installed()).toEqual([{ name: "sfly-std", version: std.version }]);
		expect((await onLocked.api.node(onLocked.runId, "probe")).outputs).toEqual({
			exit_code: 0,
			stdout: "/bin/sh\n",
			stderr: "",
			stdout_file: null,
			stderr_file: null,
		});
		expect((await onLocked.api.node(onLocked.runId, "check")).outputs).toEqual({ passed: true });
		expect(await download(onLocked.api, onLocked.runId)).toBe("interpreter=/bin/sh\n");
	}, 300_000);
});
