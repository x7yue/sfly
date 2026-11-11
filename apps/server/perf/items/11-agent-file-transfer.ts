// 负载：两台 Agent 之间传输一个大文件（ARCHITECTURE §7.6「两台 Agent 之间传输大文件」，ADR 0019）。
// 同一台机器上的两台 release Agent：perf-agent（节点所在，下载方）和 perf-source（文件所在）。
// perf-agent 上的节点用 ctx.agent("perf-source").files.download 把 perf-source 上的文件下载到本地：
// 数据由两台 Agent 之间的 gRPC 直接传输、由下载方的 Agent 写盘，不经过控制面和节点进程。
// 节点是 testdata/agent-files-package 的 timed_download，只对 files.download 本身计时。
// 同一个文件下载 RUNS 次，每次核对本地文件的 SHA-256。
// 硬性断言：下载下来的内容与源文件一致。只记录（作为以后的对照基线，不设目标）：吞吐、两台 Agent 的内存与 CPU。
// 两台 Agent 在同一台机器上，走的是回环网卡，测的是 Agent 的传输与写盘开销，不含真实网络的带宽与延迟。
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { createStubVenv, startRealAgent } from "../../test/support/real-agent.js";
import { definePerfItem, hard, type ItemRun, type PerfContext } from "../item.js";
import { MB } from "../measure.js";
import type { Measurement } from "../report.js";
import { type ProcessUsage, sampleProcess, startStack } from "../stack.js";

/** 文件大小：1 GiB，比常见的日志文件小，足够让吞吐稳定下来；源文件和下载下来的文件各占这么多磁盘。 */
const FILE_MIB = 1024;
/** 下载次数（同一个文件）。 */
const RUNS = 3;
const SOURCE = "perf-source";
const PACKAGE = "sfly-agent-files";
const VERSION = "0.1.0";
const NODE_ID = "download";

export default definePerfItem({
	id: "agent-file-transfer",
	title: "两台 Agent 之间传输 1 GiB 文件",
	scope: "两台 Agent 之间传输大文件",
	needsArtifacts: true,
	run,
});

async function run(ctx: PerfContext): Promise<ItemRun> {
	const { agent, agentName, api, server } = await startStack(ctx);
	const sourceVenv = await createStubVenv({ sdkOnly: true });
	ctx.defer(() => sourceVenv.remove());
	const source = await startRealAgent({
		grpcUrl: server.grpcUrl,
		name: SOURCE,
		venv: sourceVenv.path,
		bin: ctx.artifacts.agentBin,
	});
	ctx.defer(() => source.close());
	await api.publishPackage(ctx.repoRoot, ctx.tmpDir, "testdata/agent-files-package");

	const sourceDir = join(ctx.tmpDir, "source");
	const localDir = join(ctx.tmpDir, "local");
	await mkdir(sourceDir, { recursive: true });
	// 两台 Agent 在同一台机器上：「perf-source 上的文件」就是这里建的文件，绝对路径相同。
	const sourcePath = join(sourceDir, "big.bin");
	ctx.log(`在 ${SOURCE} 上生成 ${FILE_MIB} MiB 的随机内容`);
	const expected = await writeRandomFile(sourcePath, FILE_MIB);

	const localPath = join(localDir, "big.bin");
	const orchestration = await api.createOrchestration(
		scenario(agentName, sourcePath, localPath),
		"agent-file-transfer",
	);
	const runner = sampleProcess(agent.child.pid as number);
	const sourceUsage = sampleProcess(source.child.pid as number);
	const runs: Array<{ seconds: number; ok: boolean }> = [];
	for (let i = 1; i <= RUNS; i++) {
		ctx.log(`第 ${i}/${RUNS} 次：${agentName} 从 ${SOURCE} 下载 ${FILE_MIB} MiB`);
		const runId = await api.trigger(orchestration);
		const { outputs } = await api.succeeded<{ size: number; seconds: number }>(
			runId,
			NODE_ID,
			ctx.signal,
			600_000,
		);
		const ok = outputs.size === FILE_MIB * MB && (await sha256File(localPath)) === expected;
		runs.push({ seconds: outputs.seconds, ok });
		await rm(localPath, { force: true });
	}
	const [runnerUsage, sourceAgentUsage] = await Promise.all([runner.stop(), sourceUsage.stop()]);

	const rates = runs.map((r) => FILE_MIB / r.seconds).sort((a, b) => a - b);
	const median = rates[Math.floor(rates.length / 2)] as number;
	const measurements: Measurement[] = [
		{
			id: "corrupted_files",
			label: "下载下来与源文件不一致的次数（大小或 SHA-256）",
			value: runs.filter((r) => !r.ok).length,
			unit: "次",
			check: hard("<=", 0),
		},
		{
			id: "throughput_mib_s",
			label: `吞吐（${RUNS} 次的中位数）`,
			value: median,
			unit: "MiB/秒",
			noise: median * 0.15,
		},
		{
			id: "throughput_best_mib_s",
			label: `吞吐（${RUNS} 次中最快的一次）`,
			value: rates.at(-1) as number,
			unit: "MiB/秒",
			noise: median * 0.15,
		},
		...usage("runner", `下载方 Agent（${agentName}）`, runnerUsage),
		...usage("source", `来源 Agent（${SOURCE}）`, sourceAgentUsage),
	];
	return {
		measurements,
		notes: [
			`每次下载 ${FILE_MIB} MiB 的随机内容，用时 ${runs.map((r) => r.seconds.toFixed(2)).join("、")} 秒（节点里只对 files.download 计时）。`,
			"两台 Agent 在同一台机器上，经回环网卡传输，源文件多半在页缓存里：测的是 Agent 之间的传输与下载方写盘（含完成时的 fsync）的开销，不含真实网络的带宽与延迟。只记录，作为以后的对照基线。",
			"内存与 CPU 是整个下载期间（含核对 SHA-256 的间隙）按 200 ms 采样的结果。",
		],
	};
}

/** 入口之后一个计时下载节点：在 agentName 上把 perf-source 上的 path 下载到 localPath。 */
function scenario(agentName: string, path: string, localPath: string) {
	return {
		default_agent: agentName,
		nodes: [
			{ id: "entry", kind: "entry" },
			{
				id: NODE_ID,
				kind: "package",
				package: PACKAGE,
				node: "timed_download",
				inputs: { source: SOURCE, path, local_path: localPath },
			},
		],
		edges: [{ from: "entry", to: NODE_ID, kind: "chain" }],
		packages: { [PACKAGE]: VERSION },
	};
}

/** 两台 Agent 各自的峰值内存、内存增量和平均 CPU（只记录）。 */
function usage(id: string, label: string, u: ProcessUsage): Measurement[] {
	return [
		{
			id: `${id}_rss_growth_mb`,
			label: `${label}内存增量（峰值 - 开始）`,
			value: (u.peakRssBytes - u.startRssBytes) / MB,
			unit: "MB",
			noise: 5,
		},
		{
			id: `${id}_peak_rss_mb`,
			label: `${label}峰值内存（RSS）`,
			value: u.peakRssBytes / MB,
			unit: "MB",
			noise: 5,
		},
		{
			id: `${id}_cpu_percent`,
			label: `${label}平均 CPU（单核 = 100%）`,
			value: u.cpuPercent,
			unit: "%",
			noise: 10,
		},
	];
}

/** 写 `mib` MiB 的随机内容（每 MiB 不同），返回 SHA-256。 */
async function writeRandomFile(path: string, mib: number): Promise<string> {
	const hash = createHash("sha256");
	const file = await open(path, "w");
	try {
		for (let i = 0; i < mib; i++) {
			const block = randomBytes(MB);
			hash.update(block);
			await file.write(block);
		}
	} finally {
		await file.close();
	}
	return hash.digest("hex");
}

async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}
