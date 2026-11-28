// 全栈：用 sfly-std 的辅助函数写的节点在真实的控制面和 Agent 上跑（ADR 0030，#454）。节点包 std-helpers-user
// （testdata/std-helpers-package）依赖 sfly-std，节点是辅助函数上的外壳（和 std/tests/helper_nodes.py 同一份）：
// sfly-std 由平台管理员发布到公共项目，真实的 Agent 从控制面的包索引装上它，依赖（psutil）从 PyPI 镜像桩安装。
// 覆盖删掉的 14 个节点里「逻辑还在」的那些：资源采样、拉文件、持续拉文件（含来源 Agent 重启），和文档里的示例节点。
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { join } from "node:path";
import { logsApi, metricsApi } from "@sfly/schema";
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
	publishIntoPublicProject,
	type StdPackage,
	wheelhouse,
} from "./support/std-package.js";
import { publishTestPackage } from "./support/stub-package.js";
import { makeTempDir } from "./support/temp-dir.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const AGENT = "std-helpers-agent";

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

describeWithAgent("全栈：用 sfly-std 的辅助函数写的节点", () => {
	let dir: string;
	let cp: TestControlPlane;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let pypi: PypiStub;
	let agent: RealAgent;
	let std: StdPackage;

	beforeAll(async () => {
		const bin = agentBinary();
		dir = await makeTempDir("sfly-full-std-helpers-");
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
		await publishTestPackage(cp, "testdata/std-helpers-package", "std-helpers-user-0.1.0.sflypkg");
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

	/**
	 * entry 之后按顺序串起 nodes 的场景，返回场景 ID。节点默认是 std-helpers-user 里的；
	 * 标准节点（shell、start_process、stop_process）写 `package: "sfly-std"`。
	 */
	async function saveChain(nodes: Array<Record<string, unknown>>) {
		const ids = ["entry", ...nodes.map((n) => n.id as string)];
		return new ApiClient(cp).orchestrationWith({
			default_agent: AGENT,
			nodes: [
				{ id: "entry", kind: "entry" },
				...nodes.map((n) => ({ kind: "package", package: "std-helpers-user", ...n })),
			],
			edges: ids.slice(1).map((to, i) => ({ from: ids[i], to, kind: "chain" })),
			packages: { "sfly-std": std.version, "std-helpers-user": "0.1.0" },
		});
	}

	/** 触发场景并等运行结束。 */
	async function runToEnd(orchestrationId: string) {
		const api = new ApiClient(cp);
		const runId = await api.triggerOk(orchestrationId);
		await eventually(
			async () => expect(["success", "failed"]).toContain((await api.run(runId)).status),
			180_000,
		);
		return { api, runId };
	}

	/** saveChain 后立即运行到结束。 */
	async function runChain(nodes: Array<Record<string, unknown>>) {
		return runToEnd(await saveChain(nodes));
	}

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
			package: "std-helpers-user",
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
				package: "sfly-std",
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
				package: "sfly-std",
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

	it("pull_files 把另一台 Agent 上匹配的文件拉到本地目录，内容一致，拉完后删除源文件", async () => {
		// 来源是另一台真实 Agent（ADR 0019）：std-agent 上的 pull_files 用 Agent 能力直接连到它，数据不经过控制面。
		// 两台 Agent 在同一台机器上，所以「std-source 上的文件」就是这里建的临时文件，绝对路径相同。
		const SOURCE = "std-source";
		const sourceVenv = await createStubVenv({ sdkOnly: true });
		const source = await startRealAgent({
			grpcUrl: cp.grpcUrl,
			name: SOURCE,
			venv: sourceVenv.path,
		});
		try {
			const logs = join(dir, "pull-source");
			const local = join(dir, "pull-local");
			await mkdir(logs, { recursive: true });
			// 轮转下来的旧日志（几 MB，分多块传输）和正在写入的 app.log（不匹配通配符，不拉取也不删除）。
			const rotated = {
				"app.log.1": Buffer.alloc(3 * 1024 * 1024 + 7, "第一轮的日志\n"),
				"app.log.2": Buffer.from("第二轮的日志\n"),
			};
			for (const [name, data] of Object.entries(rotated)) await writeFile(join(logs, name), data);
			await writeFile(join(logs, "app.log"), "还在写\n");

			const { api, runId } = await runChain([
				{
					id: "pull",
					node: "pull_files",
					inputs: {
						source: SOURCE,
						directory: logs,
						pattern: "app.log.*",
						local_dir: local,
						delete_source: true,
					},
				},
			]);

			const pull = await api.node(runId, "pull");
			expect(pull.status, JSON.stringify(pull.error)).toBe("success");
			expect(pull.agent).toBe(AGENT);
			expect(pull.outputs).toEqual({
				files: [join(local, "app.log.1"), join(local, "app.log.2")],
				count: 2,
				total_bytes: 3 * 1024 * 1024 + 7 + Buffer.byteLength("第二轮的日志\n"),
			});
			// 目标目录里只有完整的文件（临时文件已改名），内容与源文件一致。
			expect((await readdir(local)).sort()).toEqual(["app.log.1", "app.log.2"]);
			for (const [name, data] of Object.entries(rotated)) {
				expect(sha256(await readFile(join(local, name))), name).toBe(sha256(data));
			}
			expect(await readdir(logs)).toEqual(["app.log"]);
		} finally {
			await source.close();
			await sourceVenv.remove();
		}
	}, 300_000);

	/** 一个空闲的 TCP 端口（让 Agent 重启后仍在同一个端口上等其它 Agent 连接）。 */
	async function freePort() {
		const server = createServer();
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		await new Promise((resolve) => server.close(resolve));
		return port;
	}

	/** 一个任务的全部日志行的文本。 */
	async function taskLogs(api: ApiClient, taskId: string) {
		const page = logsApi.page.response.parse(
			await api.getJson(`/tasks/${encodeURIComponent(taskId)}/logs`),
		);
		return page.lines.map((l) => l.text);
	}

	it("watch_files 放在子流程里：主链在 A 上产生并轮转日志，B 上的子流程持续拉取并删除源文件，被停止子流程节点停止时记为已停止", async () => {
		// 日志清洗的场景（ADR 0019，用户文档「跨 Agent 处理文件」）：A 是被测机器（std-watch-a），B 是 std-agent。
		// 两台 Agent 在同一台机器上，所以「A 上的日志目录」就是这里建的临时目录，绝对路径相同。
		const A = "std-watch-a";
		const aVenv = await createStubVenv({ sdkOnly: true });
		// A 上要运行主链的 shell：从 PyPI 镜像桩安装 sfly-std 的依赖。
		const a = await startRealAgent({
			grpcUrl: cp.grpcUrl,
			name: A,
			venv: aVenv.path,
			args: ["--index-url", pypi.indexUrl],
		});
		try {
			const logs = join(dir, "watch-source");
			const local = join(dir, "watch-local");
			await mkdir(logs, { recursive: true });
			const id = await new ApiClient(cp).orchestrationWith({
				default_agent: AGENT,
				nodes: [
					{ id: "entry", kind: "entry" },
					{ id: "spawn", kind: "async", params: {} },
					// 被测系统写日志并轮转两次：app.log 写满后改名为 app.log.<n>，再新建 app.log 接着写。
					{
						id: "produce",
						kind: "package",
						package: "sfly-std",
						node: "shell",
						agent: A,
						inputs: {
							command: [
								"set -e",
								`cd ${logs}`,
								"printf '第一轮的日志\\n' > app.log",
								"mv app.log app.log.1",
								"printf '第二轮的日志\\n' > app.log",
								"sleep 0.5",
								"mv app.log app.log.2",
								"printf '还在写\\n' > app.log",
							].join("\n"),
						},
					},
					// 等 B 把轮转出来的文件拉走（拉完才删除源文件），再停止子流程。
					{
						id: "drained",
						kind: "package",
						package: "sfly-std",
						node: "shell",
						agent: A,
						inputs: {
							command: `cd ${logs}; while [ -e app.log.1 ] || [ -e app.log.2 ]; do sleep 0.2; done`,
						},
					},
					{ id: "stop", kind: "stop_subflow", subflow: "pull", always: true },
					{ id: "pull", kind: "subflow_entry", name: "拉取日志", params: [] },
					{
						id: "watch",
						kind: "package",
						package: "std-helpers-user",
						node: "watch_files",
						inputs: {
							source: A,
							directory: logs,
							pattern: "app.log.*",
							stable: 1,
							local_dir: local,
							delete_source: true,
						},
					},
				],
				edges: [
					{ from: "entry", to: "spawn", kind: "chain" },
					{ from: "spawn", to: "produce", kind: "chain" },
					{ from: "produce", to: "drained", kind: "chain" },
					{ from: "drained", to: "stop", kind: "chain" },
					{ from: "pull", to: "watch", kind: "chain" },
					{ from: "spawn", to: "pull", kind: "dispatch" },
				],
				packages: { "sfly-std": std.version, "std-helpers-user": "0.1.0" },
			});
			const { api, runId } = await runToEnd(id);

			const run = await api.run(runId);
			const main = run.chains.find((c) => c.chain_id === "entry");
			const pull = run.chains.find((c) => c.chain_id === "pull");
			const watch = pull?.nodes.find((n) => n.node_id === "watch");
			expect(watch?.status, JSON.stringify(watch?.attempts.at(-1)?.error)).toBe("stopped");
			expect(watch?.agent).toBe(AGENT);
			expect(main?.nodes.find((n) => n.node_id === "produce")?.agent).toBe(A);
			expect(main?.nodes.find((n) => n.node_id === "stop")).toMatchObject({
				status: "success",
				outputs: { status: "success" },
			});
			expect(run.status).toBe("success");
			// 目标目录里只有完整的文件（临时文件已改名），A 上只剩还在写的 app.log。
			expect((await readdir(local)).sort()).toEqual(["app.log.1", "app.log.2"]);
			expect(await readFile(join(local, "app.log.1"), "utf8")).toBe("第一轮的日志\n");
			expect(await readFile(join(local, "app.log.2"), "utf8")).toBe("第二轮的日志\n");
			expect(await readdir(logs)).toEqual(["app.log"]);

			// 指标在运行页面上可见：已拉取的文件数、字节数和速率。
			const catalog = metricsApi.catalog.response.parse(
				await api.getJson(`/runs/${runId}/metrics`),
			);
			const node = catalog.nodes.find((n) => n.node_id === "watch");
			expect(node?.primary_metric).toBe("bytes_per_s");
			expect(node?.attempts[0]?.metrics.map((m) => m.name).sort()).toEqual([
				"bytes_per_s",
				"pulled_bytes",
				"pulled_files",
			]);
		} finally {
			await a.close();
			await aVenv.remove();
		}
	}, 300_000);

	it("watch_files 在来源 Agent 重启（连接中断）后继续拉取：断线期间轮转出来的文件也拉到，拉过的不再拉", async () => {
		const SOURCE = "std-watch-restart";
		const sourceVenv = await createStubVenv({ sdkOnly: true });
		// 固定端口：重启后还在同一个地址上，派发时下发的地址仍然有效。
		const port = String(await freePort());
		const start = () =>
			startRealAgent({
				grpcUrl: cp.grpcUrl,
				name: SOURCE,
				venv: sourceVenv.path,
				env: { SFLY_LISTEN_PORT: port },
			});
		let source = await start();
		try {
			const logs = join(dir, "restart-source");
			const local = join(dir, "restart-local");
			await mkdir(logs, { recursive: true });
			await writeFile(join(logs, "app.log.1"), "断线之前\n");
			const api = new ApiClient(cp);
			const runId = await api.triggerOk(
				await saveChain([
					{
						id: "watch",
						node: "watch_files",
						inputs: { source: SOURCE, directory: logs, pattern: "app.log.*", local_dir: local },
					},
				]),
			);
			await eventually(
				async () => expect(await readFile(join(local, "app.log.1"), "utf8")).toBe("断线之前\n"),
				120_000,
			);

			// A 突然退出（连接中断），断线期间又轮转出一个文件，之后 A 在同一个端口上重新启动。
			await source.close();
			await writeFile(join(logs, "app.log.2"), "断线期间\n");
			source = await start();
			await eventually(
				async () => expect(await readFile(join(local, "app.log.2"), "utf8")).toBe("断线期间\n"),
				120_000,
			);
			await writeFile(join(logs, "app.log.3"), "重连之后\n");
			await eventually(
				async () => expect(await readFile(join(local, "app.log.3"), "utf8")).toBe("重连之后\n"),
				60_000,
			);
			await api.cancelOk(runId);
			await eventually(async () => expect((await api.run(runId)).status).toBe("cancelled"), 60_000);

			// 每个文件只拉了一次：重连后的快照里仍有 app.log.1，没有再拉。
			const watch = await api.node(runId, "watch");
			const lines = await taskLogs(api, watch.attempts[0]?.task_id as string);
			for (const name of ["app.log.1", "app.log.2", "app.log.3"]) {
				const pulled = lines.filter((l) => l.startsWith(`拉取了 ${join(logs, name)}（`));
				expect(pulled, name).toHaveLength(1);
			}
			expect((await readdir(local)).sort()).toEqual(["app.log.1", "app.log.2", "app.log.3"]);
		} finally {
			await source.close();
			await sourceVenv.remove();
		}
	}, 300_000);

	it("文档里的示例节点：起服务、等就绪、采样资源、收集日志、停服务（辅助函数在业务节点里的完整用法）", async () => {
		const port = await freePort();
		const server =
			'exec python3 -u -c "import http.server as h; ' +
			`s = h.HTTPServer(('127.0.0.1', ${port}), h.SimpleHTTPRequestHandler); ` +
			"print('服务就绪', flush=True); s.serve_forever()\"";
		const { api, runId } = await runChain([
			{
				id: "check",
				node: "service_check",
				inputs: { command: server, port, ready_line: "服务就绪", observe: 2 },
			},
		]);

		expect((await api.run(runId)).status).toBe("success");
		const check = await api.node(runId, "check");
		expect(check.outputs).toMatchObject({ exit_code: 143 });
		expect((check.outputs as { samples: number }).samples).toBeGreaterThanOrEqual(1);
		// 服务日志被收集成产物，服务已经停掉：端口不再有人监听。
		const log = (check.outputs as { log: string }).log;
		expect((await (await fetch(log)).text()).trim()).toBe("服务就绪");
		await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
	}, 300_000);
});
