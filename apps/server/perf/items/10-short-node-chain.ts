// 负载：30 个节点的单链，每个节点只做一点点事，看「一个任务一个进程」的固定开销（ARCHITECTURE §7.6「短节点链路」，#76）。
// 三类节点各一条链（同样的编排，只换节点）：
// - 空节点：sfly-short 的 empty（testdata/short-package），除了 SDK 什么都不导入，测出的是执行器进程本身的开销；
// - sfly-std 的 http_request：请求本机的 HTTP 桩（不访问外网），sfly-std 的依赖从 PyPI 镜像桩安装；
// - 重依赖节点：sfly-short 的 heavy，模块顶层把整个标准库导入一遍，模拟顶层导入 pandas 这类大库的节点
//   （不从 PyPI 下载 pandas，理由见 testdata/short-package/src/sfly_short/heavy.py）。
// 每类先跑一次预热（Agent 安装节点包、写 .pyc），不计入；之后三类轮流各跑 RUNS 次，机器上别的负载均摊到三类上。
// 不加任何打点，只用控制面已有的运行与任务时间戳（算法见 perf/chain.ts）。
// 只记录：每类的每节点端到端耗时（相邻节点开始时间之差的中位数）、整条链用时等；sfly-std 的与目标比较，与上一次对比。
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { startPypiStub } from "../../test/support/pypi-stub.js";
import { buildStdPackage, wheelhouse } from "../../test/support/std-package.js";
import { type ChainRun, chainTimings, median } from "../chain.js";
import { definePerfItem, type ItemRun, type PerfContext, target } from "../item.js";
import type { Measurement } from "../report.js";
import { type PerfApi, startStack } from "../stack.js";
import { CHAIN_NODES, SHORT_NODE_MS } from "../targets.js";

/** 每类计入结果的运行次数（预热之外）。 */
const RUNS = 5;
/** 一次运行最多等多久：预热要安装 sfly-std 和它的依赖。 */
const RUN_TIMEOUT_MS = 300_000;
const SHORT_PACKAGE = "sfly-short";
const SHORT_VERSION = "0.1.0";

/** 一类节点。 */
interface NodeClass {
	/** 数值标识的前缀（ASCII）。 */
	id: string;
	label: string;
	package: string;
	version: string;
	node: string;
	inputs: Record<string, unknown>;
	/** 与 §7.6 的目标比较（只有 sfly-std 的短节点有目标）。 */
	target?: number;
}

export default definePerfItem({
	id: "short-node-chain",
	title: "短节点链路：30 个节点的单链",
	scope: "短节点链路",
	needsArtifacts: true,
	run,
});

async function run(ctx: PerfContext): Promise<ItemRun> {
	ctx.log("构建 sfly-std 与 PyPI 镜像桩里它的依赖");
	const [std, wheels] = await Promise.all([
		buildStdPackage(join(ctx.tmpDir, "std")),
		wheelhouse(join(ctx.tmpDir, "wheels"), [], { withStdDependencies: true }),
	]);
	const pypi = await startPypiStub(wheels);
	ctx.defer(() => pypi.close());
	const httpUrl = await startHttpTarget(ctx);
	const { agentName, api } = await startStack(ctx, {
		agentArgs: ["--index-url", pypi.indexUrl],
	});
	await api.publishArchive(await readFile(std.path));
	await api.publishPackage(ctx.repoRoot, ctx.tmpDir, "testdata/short-package");

	const classes: NodeClass[] = [
		{
			id: "empty",
			label: "空节点",
			package: SHORT_PACKAGE,
			version: SHORT_VERSION,
			node: "empty",
			inputs: {},
		},
		{
			id: "std_http",
			label: "sfly-std http_request",
			package: "sfly-std",
			version: std.version,
			node: "http_request",
			inputs: { url: httpUrl },
			target: SHORT_NODE_MS,
		},
		{
			id: "heavy",
			label: "重依赖节点",
			package: SHORT_PACKAGE,
			version: SHORT_VERSION,
			node: "heavy",
			inputs: {},
		},
	];
	const orchestrations = new Map<string, string>();
	for (const c of classes) {
		orchestrations.set(c.id, await api.createOrchestration(chainDocument(agentName, c), c.id));
	}

	ctx.log(`预热：每类先跑一次 ${CHAIN_NODES} 个节点的单链（安装节点包，不计入）`);
	for (const c of classes) await runChain(api, orchestrations.get(c.id) as string, ctx.signal);
	const runs = new Map<string, Finished[]>(classes.map((c) => [c.id, []]));
	for (let round = 1; round <= RUNS; round++) {
		ctx.log(`第 ${round}/${RUNS} 轮：三类各跑一次`);
		for (const c of classes) {
			runs.get(c.id)?.push(await runChain(api, orchestrations.get(c.id) as string, ctx.signal));
		}
	}

	const measurements: Measurement[] = [];
	const notes: string[] = [];
	for (const c of classes) {
		const finished = runs.get(c.id) ?? [];
		const timings = chainTimings(finished.map((f) => f.chain));
		if (!timings) throw new Error(`${c.label}：没有算出每节点耗时`);
		measurements.push(
			{
				id: `${c.id}_per_node_ms`,
				label: `${c.label}：每节点端到端（相邻节点开始时间之差的中位数）`,
				value: timings.perNodeMs,
				unit: "ms",
				noise: 10,
				...(c.target === undefined ? {} : { check: target("<=", c.target) }),
			},
			{
				id: `${c.id}_per_node_p95_ms`,
				label: `${c.label}：每节点端到端 p95`,
				value: timings.perNodeP95Ms,
				unit: "ms",
				noise: 20,
			},
			{
				id: `${c.id}_execution_ms`,
				label: `${c.label}：任务执行（执行器启动到控制面收到结果）中位数`,
				value: timings.executionMs,
				unit: "ms",
				noise: 10,
			},
			{
				id: `${c.id}_between_ms`,
				label: `${c.label}：节点之间（上一个结束到下一个开始）中位数`,
				value: timings.betweenMs,
				unit: "ms",
				noise: 5,
			},
			{
				id: `${c.id}_chain_s`,
				label: `${c.label}：整条链用时（运行开始到结束）中位数`,
				value: timings.chainMs / 1000,
				unit: "秒",
				noise: 0.3,
			},
		);
		notes.push(
			`${c.label}：${timings.runs} 次运行、每节点 ${timings.samples} 个样本；整条链用时 ${finished
				.map((f) => ((f.chain.endedMs - f.chain.startedMs) / 1000).toFixed(2))
				.join("、")} 秒。`,
		);
		if (c.node === "heavy") {
			const outputs = finished.flatMap((f) => f.outputs) as Array<{
				modules?: number;
				classes?: number;
				import_ms?: number;
			}>;
			notes.push(
				`重依赖节点导入了 ${outputs[0]?.modules ?? "?"} 个标准库模块、定义了 ${outputs[0]?.classes ?? "?"} 个类，节点模块自己计时的导入用时中位数 ${median(
					outputs.map((o) => o.import_ms ?? Number.NaN),
				).toFixed(1)} ms（#76 在同类机器上测得 pandas 节点导入约 218 ms）。`,
			);
		}
	}
	notes.push(
		"每节点端到端 = 相邻两个节点的开始时间（Agent 上报执行器已启动、控制面记为 running）之差：一个节点从执行器启动、" +
			"退出、回报结果，到控制面派发下一个节点、Agent 启动下一个执行器的完整周期；多次运行的差值合在一起取中位数。" +
			"任务执行 + 节点之间 ≈ 每节点端到端。",
		"预热的那次运行不计入：第一个节点包含 Agent 安装节点包、第一次写 .pyc 的时间（冷启动不在这一项里测）。",
	);
	return { measurements, notes };
}

/** 一次跑完的单链运行：时间戳与链上各节点的输出。 */
interface Finished {
	chain: ChainRun;
	outputs: unknown[];
}

const nodeIds = Array.from({ length: CHAIN_NODES }, (_, i) => `n${String(i + 1).padStart(2, "0")}`);

/** 入口之后串起 CHAIN_NODES 个同样的节点。 */
function chainDocument(agentName: string, c: NodeClass) {
	const ids = ["entry", ...nodeIds];
	return {
		default_agent: agentName,
		nodes: [
			{ id: "entry", kind: "entry" },
			...nodeIds.map((id) => ({
				id,
				kind: "package",
				package: c.package,
				node: c.node,
				inputs: c.inputs,
			})),
		],
		edges: nodeIds.map((to, i) => ({ from: ids[i], to, kind: "chain" })),
		packages: { [c.package]: c.version },
	};
}

/** 触发一次运行并等它结束；没有成功时抛出错误（时间戳没有意义）。 */
async function runChain(api: PerfApi, orchestrationId: string, signal: AbortSignal) {
	const runId = await api.trigger(orchestrationId);
	const view = await api.waitRun(runId, signal, RUN_TIMEOUT_MS);
	const nodes = view.chains[0]?.nodes ?? [];
	const attempts = nodeIds.map((id) => nodes.find((n) => n.node_id === id)?.attempts.at(-1));
	if (view.status !== "success" || !view.ended_at) {
		const failed = attempts.find((a) => a?.status !== "success");
		throw new Error(`运行没有成功（${view.status}）：${JSON.stringify(failed?.error ?? null)}`);
	}
	const tasks = attempts.map((a, i) => {
		if (!a?.started_at || !a.ended_at) throw new Error(`节点 ${nodeIds[i]} 没有开始或结束时间`);
		return { startedMs: Date.parse(a.started_at), endedMs: Date.parse(a.ended_at) };
	});
	return {
		chain: { startedMs: Date.parse(view.started_at), endedMs: Date.parse(view.ended_at), tasks },
		outputs: attempts.map((a) => a?.outputs),
	} satisfies Finished;
}

/** 本机的 HTTP 桩（http_request 节点请求它），返回请求地址。 */
async function startHttpTarget(ctx: PerfContext): Promise<string> {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end('{"ok":true}');
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	ctx.defer(() => new Promise((resolve) => server.close(resolve)));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
}
