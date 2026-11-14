// 性能测试的被测对象：release 构建的 Agent、打包后的控制面（pnpm bundle:server 的同一套脚本）、
// 本机 PostgreSQL 上的独立数据库，以及不依赖 vitest 的 HTTP API 客户端和进程资源采样。
// 启动真实 Agent、打包控制面、测试数据库复用 test/support 里的实现。
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { promisify } from "node:util";
import { type AttemptView, logsApi, metricsApi, NICKNAME_HEADER, runsApi } from "@sfly/schema";
import { type BundledServer, startBundledServer } from "../test/support/bundled-server.js";
import { createStubVenv, type RealAgent, startRealAgent } from "../test/support/real-agent.js";
import { createTestDatabase, type TestDatabase } from "../test/support/test-database.js";
import { runChecked } from "./command.js";
import type { Artifacts, PerfContext } from "./item.js";

/** 构建产物的位置：release Agent 在 cargo 的 target 目录，打包的控制面在 out/perf/server（不覆盖 out/server）。 */
export function artifactsAt(repoRoot: string): Artifacts {
	const targetDir = process.env.CARGO_TARGET_DIR ?? join(repoRoot, "target");
	return {
		agentBin: join(targetDir, "release", "sfly-agent"),
		bundleDir: join(repoRoot, "out", "perf", "server"),
	};
}

/** 构建 release Agent 与打包后的控制面（不带 Agent 下载，见 scripts/bundle.ts 的 --without-agents）。 */
export async function buildArtifacts(
	repoRoot: string,
	log: (m: string) => void,
): Promise<Artifacts> {
	const artifacts = artifactsAt(repoRoot);
	log("构建 release Agent：cargo build --release -p sfly-agent");
	await runChecked("cargo", ["build", "--release", "--locked", "-p", "sfly-agent"], {
		cwd: repoRoot,
	});
	log("打包控制面：前端、SDK wheel 与单文件包");
	await runChecked("pnpm", ["--filter", "@sfly/web", "--filter", "@sfly/server", "build"], {
		cwd: repoRoot,
	});
	await runChecked(
		"pnpm",
		[
			"--filter",
			"@sfly/server",
			"exec",
			"tsx",
			"scripts/bundle.ts",
			"--without-agents",
			"--out-dir",
			artifacts.bundleDir,
		],
		{ cwd: repoRoot },
	);
	return artifacts;
}

/** 检查 `--no-build` 时产物是否存在。 */
export function existingArtifacts(repoRoot: string): Artifacts {
	const artifacts = artifactsAt(repoRoot);
	for (const file of [artifacts.agentBin, join(artifacts.bundleDir, "main.mjs")]) {
		if (!existsSync(file)) throw new Error(`${file} 不存在：去掉 --no-build 先构建一次`);
	}
	return artifacts;
}

/** 不依赖 vitest 的 HTTP API 客户端（test/support/api-client.ts 用 expect 断言，只能在测试里用）。 */
export class PerfApi {
	constructor(readonly httpUrl: string) {}

	async request(path: string, init: RequestInit = {}): Promise<Response> {
		const res = await fetch(`${this.httpUrl}${path}`, init);
		if (!res.ok) {
			throw new Error(`${init.method ?? "GET"} ${path} 返回 ${res.status}：${await res.text()}`);
		}
		return res;
	}

	async getJson(path: string): Promise<unknown> {
		return (await this.request(path)).json();
	}

	async postJson(path: string, body: unknown): Promise<unknown> {
		const res = await this.request(path, {
			method: "POST",
			headers: { "content-type": "application/json", [NICKNAME_HEADER]: "perf" },
			body: JSON.stringify(body),
		});
		return res.json();
	}

	/** 用 sfly CLI 构建桩节点包（testdata/stub-package）并发布。 */
	async publishStubPackage(repoRoot: string, tmpDir: string): Promise<void> {
		await this.publishPackage(repoRoot, tmpDir, "testdata/stub-package");
	}

	/** 用 sfly CLI 构建一个节点包项目（`project` 相对仓库根目录，例如 `std`）并发布。 */
	async publishPackage(repoRoot: string, tmpDir: string, project: string): Promise<void> {
		const out = await mkdtemp(join(tmpDir, "pkg-"));
		await promisify(execFile)(
			"uv",
			["run", "--locked", "--quiet", "sfly", "build", project, "--out", out],
			{ cwd: repoRoot },
		);
		const [file] = (await readdir(out)).filter((f) => f.endsWith(".sflypkg"));
		if (!file) throw new Error(`sfly build ${project} 没有生成 .sflypkg`);
		await this.publishArchive(await readFile(join(out, file)));
	}

	/** 发布一个已经构建好的节点包（`.sflypkg` 的内容）。 */
	async publishArchive(body: Uint8Array): Promise<void> {
		await this.request("/packages", {
			method: "POST",
			headers: { "content-type": "application/octet-stream" },
			body,
		});
	}

	/** 新建场景并保存第一个版本，返回场景 ID。 */
	async createOrchestration(document: unknown, name = "perf"): Promise<string> {
		const { id } = (await this.postJson("/orchestrations", { name })) as { id: string };
		await this.postJson(`/orchestrations/${id}/versions`, { base_version: 0, document });
		return id;
	}

	/** 触发场景的最新版本，返回运行 ID。 */
	async trigger(orchestrationId: string): Promise<string> {
		return (
			(await this.postJson(`/orchestrations/${orchestrationId}/runs`, { params: {} })) as {
				id: string;
			}
		).id;
	}

	async run(runId: string) {
		return runsApi.get.response.parse(await this.getJson(`/runs/${runId}`));
	}

	/** 等运行结束（不是 running），返回运行视图。 */
	async waitRun(runId: string, signal: AbortSignal, timeoutMs: number) {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			signal.throwIfAborted();
			const view = await this.run(runId);
			if (view.status !== "running") return view;
			if (Date.now() > deadline)
				throw new Error(`运行 ${runId} 在 ${timeoutMs / 1000} 秒内没有结束`);
			await sleep(500, signal);
		}
	}

	/** 主链上一个节点的最后一次尝试；还没有尝试时为 undefined。 */
	async attempt(runId: string, nodeId: string): Promise<AttemptView | undefined> {
		return lastAttempt(await this.run(runId), nodeId);
	}

	/**
	 * 等运行结束，返回主链上这个节点成功的最后一次尝试（有输出、开始与结束时间）与主链实例 ID；
	 * 运行没有成功时抛出错误（负载没法核对下去）。outputs 按节点的输出结构 T 交出。
	 */
	async succeeded<T>(runId: string, nodeId: string, signal: AbortSignal, timeoutMs: number) {
		const view = await this.waitRun(runId, signal, timeoutMs);
		const attempt = lastAttempt(view, nodeId);
		if (
			view.status !== "success" ||
			!attempt?.outputs ||
			!attempt.started_at ||
			!attempt.ended_at
		) {
			throw new Error(`运行没有成功（${view.status}）：${JSON.stringify(attempt?.error ?? null)}`);
		}
		return {
			attempt,
			outputs: attempt.outputs as unknown as T,
			startedMs: Date.parse(attempt.started_at),
			endedMs: Date.parse(attempt.ended_at),
			chainInstanceId: view.chains[0]?.id as string,
		};
	}

	/** 一个任务日志的最后一页（limit=1）：已写入的最大序号与截断标记。 */
	async logPage(taskId: string) {
		return logsApi.page.response.parse(await this.getJson(`/tasks/${taskId}/logs?limit=1`));
	}

	/** 等控制面写完这个任务的日志：已写入的最大序号 1 秒内不再变化（最多等 30 秒），返回最后一页。 */
	async waitLogsSettled(taskId: string, signal: AbortSignal) {
		const deadline = Date.now() + 30_000;
		let last = -1;
		for (;;) {
			const page = await this.logPage(taskId);
			if (page.last_seq === last || Date.now() > deadline) return page;
			last = page.last_seq;
			await sleep(1000, signal);
		}
	}

	/**
	 * 流式下载一个任务的全部日志，逐行交给 visit（上百 MiB 的日志不必整份留在内存里）。
	 * `timeMs` 是 Agent 读到这一行的时刻（控制面时间：由这一行的单调时钟读数折算，ADR 0018）。
	 */
	async readTaskLogs(taskId: string, visit: (line: TaskLogLine) => void): Promise<void> {
		const res = await this.request(`/tasks/${taskId}/logs/download`);
		const input = createInterface({
			input: Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		for await (const raw of input) {
			if (!raw) continue;
			const line = JSON.parse(raw) as { seq: number; time: string; source: string; text: string };
			visit({ seq: line.seq, timeMs: Date.parse(line.time), source: line.source, text: line.text });
		}
	}

	async metricCatalog(runId: string) {
		return metricsApi.catalog.response.parse(await this.getJson(`/runs/${runId}/metrics`));
	}

	/** 一个节点的指标序列；时间范围短于 5000 秒时每秒一个桶。 */
	async metricSeries(runId: string, chainInstanceId: string, nodeId: string) {
		const query = new URLSearchParams({
			chain_instance_id: chainInstanceId,
			node_id: nodeId,
			points: "5000",
		});
		return metricsApi.series.response.parse(
			await this.getJson(`/runs/${runId}/metrics/series?${query}`),
		);
	}

	/** 一个节点在 [fromSecond, toSecond]（Unix 秒，首尾都包含）的指标序列；不超过 5000 秒时每秒一个桶。 */
	async metricSeriesRange(
		runId: string,
		chainInstanceId: string,
		nodeId: string,
		fromSecond: number,
		toSecond: number,
	) {
		const query = new URLSearchParams({
			chain_instance_id: chainInstanceId,
			node_id: nodeId,
			from: new Date(fromSecond * 1000).toISOString(),
			to: new Date(toSecond * 1000).toISOString(),
			points: "5000",
		});
		return metricsApi.series.response.parse(
			await this.getJson(`/runs/${runId}/metrics/series?${query}`),
		);
	}
}

/** 任务日志的一行。 */
export interface TaskLogLine {
	seq: number;
	/** Agent 读到这一行的时间（毫秒）。 */
	timeMs: number;
	source: string;
	text: string;
}

/** 运行视图里主链上一个节点的最后一次尝试。 */
const lastAttempt = (
	view: { chains: Array<{ nodes: Array<{ node_id: string; attempts: AttemptView[] }> }> },
	nodeId: string,
) => view.chains[0]?.nodes.find((n) => n.node_id === nodeId)?.attempts.at(-1);

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

/** 一套运行中的被测对象。 */
export interface Stack {
	readonly database: TestDatabase;
	readonly server: BundledServer;
	/** 控制面的数据目录（重启控制面时沿用）。 */
	readonly dataDir: string;
	readonly agent: RealAgent;
	readonly agentName: string;
	readonly api: PerfApi;
}

/**
 * 启动一套被测对象：独立的数据库、打包后的控制面（已发布桩节点包 sfly-stub@0.1.0）、
 * 装好 SDK 与桩节点包的共享 venv、连上控制面的 release Agent。全部登记到 ctx.defer，项结束时清理。
 */
export async function startStack(
	ctx: PerfContext,
	options: { agentName?: string; agentArgs?: string[]; agentEnv?: Record<string, string> } = {},
): Promise<Stack> {
	const agentName = options.agentName ?? "perf-agent";
	ctx.log("启动被测对象：数据库、打包后的控制面、共享 venv、release Agent");
	const database = await createTestDatabase("sfly_perf");
	ctx.defer(() => database.drop());
	const dataDir = await mkdtemp(join(ctx.tmpDir, "data-"));
	const [server, venv] = await Promise.all([
		startBundledServer({ dir: ctx.artifacts.bundleDir, databaseUrl: database.url, dataDir }),
		createStubVenv(),
	]);
	ctx.defer(() => server.stop());
	const api = new PerfApi(server.httpUrl);
	await api.publishStubPackage(ctx.repoRoot, ctx.tmpDir);
	const agent = await startRealAgent({
		grpcUrl: server.grpcUrl,
		name: agentName,
		venv: venv.path,
		bin: ctx.artifacts.agentBin,
		args: options.agentArgs,
		env: options.agentEnv,
	});
	ctx.defer(() => agent.close());
	return { database, server, dataDir, agent, agentName, api };
}

/** 进程资源采样的结果。 */
export interface ProcessUsage {
	startRssBytes: number;
	peakRssBytes: number;
	endRssBytes: number;
	/** 采样期间的平均 CPU（单核满载 = 100）。 */
	cpuPercent: number;
	/** RSS 序列（毫秒偏移，字节）。 */
	samples: Array<{ ms: number; rssBytes: number }>;
}

let clockTicks: number | undefined;
const ticksPerSecond = () => {
	clockTicks ??= Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()) || 100;
	return clockTicks;
};

async function readProc(pid: number): Promise<{ rssBytes: number; cpuTicks: number } | null> {
	try {
		const [status, stat] = await Promise.all([
			readFile(`/proc/${pid}/status`, "utf8"),
			readFile(`/proc/${pid}/stat`, "utf8"),
		]);
		const rssKb = Number(/^VmRSS:\s+(\d+) kB/m.exec(status)?.[1] ?? 0);
		// comm 可能含空格和括号：从最后一个 ')' 之后数字段（utime、stime 是第 14、15 个字段）。
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return { rssBytes: rssKb * 1024, cpuTicks: Number(fields[11]) + Number(fields[12]) };
	} catch {
		return null;
	}
}

/** 按固定间隔采样一个进程（只算它自己，不含子进程）的 RSS 与 CPU，stop() 返回汇总。Linux 专用。 */
export function sampleProcess(pid: number, intervalMs = 200) {
	const started = Date.now();
	const samples: ProcessUsage["samples"] = [];
	let firstTicks: number | undefined;
	let lastTicks = 0;
	let pending = Promise.resolve();
	const tick = () => {
		pending = readProc(pid).then((s) => {
			if (!s) return;
			firstTicks ??= s.cpuTicks;
			lastTicks = s.cpuTicks;
			samples.push({ ms: Date.now() - started, rssBytes: s.rssBytes });
		});
	};
	tick();
	const timer = setInterval(tick, intervalMs);
	return {
		async stop(): Promise<ProcessUsage> {
			clearInterval(timer);
			await pending;
			tick();
			await pending;
			const seconds = (Date.now() - started) / 1000;
			const rss = samples.map((s) => s.rssBytes);
			return {
				startRssBytes: rss[0] ?? 0,
				peakRssBytes: Math.max(0, ...rss),
				endRssBytes: rss.at(-1) ?? 0,
				cpuPercent:
					seconds > 0
						? ((lastTicks - (firstTicks ?? lastTicks)) / ticksPerSecond() / seconds) * 100
						: 0,
				samples,
			};
		},
	};
}
