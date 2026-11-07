// 控制面指标接收负载：多个讲真实 gRPC 的假 Agent（test/support/fake-agent.ts）直接上报 MetricBatch，
// 每个任务每秒一批（与真实 Agent 按「任务 × 指标 × 秒」合并后的上报节奏相同）。真实 Agent 受单任务指标数上限约束，
// 难以单独造出每秒 1 万点，所以这里绕过 Agent，只压控制面。纯逻辑的单测见 test/perf-control-plane.test.ts。

import { type AssignedTask, FakeAgent, TaskStatus } from "../test/support/fake-agent.js";
import { publishPackage } from "../test/support/package-archive.js";
import type { PerfApi } from "./stack.js";
import { sleep } from "./stack.js";

export interface LoadPlan {
	/** 任务总数。 */
	tasks: number;
	/** 实际的速率（任务数 × 每个任务的指标数，可能比目标略多）。 */
	pointsPerSecond: number;
	/** 每个假 Agent 分到的任务数。 */
	tasksPerAgent: number[];
}

/** 按目标速率分配任务：每个任务每秒上报 metricsPerTask 个点，任务数向上取整，平均分给各个假 Agent。 */
export function planLoad(options: {
	pointsPerSecond: number;
	metricsPerTask: number;
	agents: number;
}): LoadPlan {
	const tasks = Math.ceil(options.pointsPerSecond / options.metricsPerTask);
	const base = Math.floor(tasks / options.agents);
	const extra = tasks % options.agents;
	return {
		tasks,
		pointsPerSecond: tasks * options.metricsPerTask,
		tasksPerAgent: Array.from({ length: options.agents }, (_, i) => base + (i < extra ? 1 : 0)),
	};
}

export interface PointReconciliation {
	sent: number;
	stored: number;
	/** 上报了但没写进去的点数。 */
	missing: number;
	/** 写进去的比上报的多出来的点数（重复写入）。 */
	extra: number;
}

/** 按「任务 × 指标」（同一个键）核对写入的点数与上报的点数；少写与多写分别累计，不互相抵消。 */
export function reconcilePoints(
	sent: ReadonlyMap<string, number>,
	stored: ReadonlyMap<string, number>,
): PointReconciliation {
	let missing = 0;
	let extra = 0;
	for (const key of new Set([...sent.keys(), ...stored.keys()])) {
		const diff = (stored.get(key) ?? 0) - (sent.get(key) ?? 0);
		if (diff < 0) missing -= diff;
		else extra += diff;
	}
	const total = (m: ReadonlyMap<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
	return { sent: total(sent), stored: total(stored), missing, extra };
}

/**
 * 负载的持续时间（秒）：环境变量 `name` 没设或为空时用 fallback。`pnpm perf` 用缩短的默认值，
 * 长时负载测试（perf:soak）设成更长的时间再跑同一项。不是正数时抛出错误。
 */
export function durationSeconds(
	env: Record<string, string | undefined>,
	name: string,
	fallback: number,
): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const seconds = Number(raw);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new Error(`${name} 应为正的秒数，实际为 ${JSON.stringify(raw)}`);
	}
	return seconds;
}

/** 负载用的节点包：一个不执行任何代码的节点类型，声明 metricsPerTask 个 gauge（假 Agent 不运行它）。 */
const PACKAGE = "perf-metrics";
const PACKAGE_VERSION = "1.0.0";
const NODE = "load";
/** 同步探测用的任务 ID：不存在的任务，控制面忽略这条结果但仍按顺序回 Ack。 */
const PROBE_TASK = "00000000-0000-4000-8000-00000000beef";

export const metricName = (i: number) => `m${String(i).padStart(2, "0")}`;

/** 负载里的一个任务（节点的一次尝试，派发给某个假 Agent）。 */
export interface LoadTask {
	agent: FakeAgent;
	task: AssignedTask;
	runId: string;
}

/** 一套连上控制面、每个槽位都拿到一个执行中任务的假 Agent。 */
export interface LoadFleet {
	plan: LoadPlan;
	metrics: string[];
	agents: FakeAgent[];
	tasks: LoadTask[];
	/** Welcome 给出的心跳间隔（毫秒）。 */
	heartbeatMs: number;
}

/** 按 concurrency 并发执行 jobs。 */
async function pool<T>(jobs: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
	const results: T[] = new Array(jobs.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
			while (next < jobs.length) {
				const i = next++;
				results[i] = await (jobs[i] as () => Promise<T>)();
			}
		}),
	);
	return results;
}

/**
 * 发布负载用的节点包，连上 plan.tasksPerAgent.length 个假 Agent（槽位数 = 分到的任务数），
 * 每个假 Agent 一个场景、触发分到的次数，收下全部派发并上报 TaskStarted（任务进入 running）。
 */
export async function startFleet(options: {
	api: PerfApi;
	grpcUrl: string;
	plan: LoadPlan;
	metricsPerTask: number;
	log: (m: string) => void;
	defer: (cleanup: () => unknown) => void;
}): Promise<LoadFleet> {
	const { api, plan } = options;
	const metrics = Array.from({ length: options.metricsPerTask }, (_, i) => metricName(i));
	await publishPackage(
		{ fetch: (path, init) => fetch(`${api.httpUrl}${path}`, init) },
		PACKAGE,
		PACKAGE_VERSION,
		{
			[NODE]: { outputs: [], metrics: metrics.map((name) => ({ name, unit: "", kind: "gauge" })) },
		},
	);
	options.log(
		`连上 ${plan.tasksPerAgent.length} 个假 Agent，触发 ${plan.tasks} 个任务（每个任务 ${metrics.length} 个指标）`,
	);
	const agents = await Promise.all(
		plan.tasksPerAgent.map(async (slots, i) => {
			const agent = await FakeAgent.connect(options.grpcUrl, { name: `load-${i}`, slots });
			options.defer(() => agent.disconnect());
			return agent;
		}),
	);
	const tasks = (
		await Promise.all(
			agents.map(async (agent, i) => {
				const orchestration = await api.createOrchestration(
					{
						default_agent: agent.name,
						nodes: [
							{ id: "entry", kind: "entry" },
							{ id: NODE, kind: "package", package: PACKAGE, node: NODE },
						],
						edges: [{ from: "entry", to: NODE, kind: "chain" }],
						packages: { [PACKAGE]: PACKAGE_VERSION },
					},
					agent.name,
				);
				const count = plan.tasksPerAgent[i] as number;
				await pool(
					Array.from({ length: count }, () => () => api.trigger(orchestration)),
					4,
				);
				const assigned: LoadTask[] = [];
				for (let k = 0; k < count; k++) {
					const task = await agent.nextAssign({ timeoutMs: 120_000, start: false });
					// 不逐个同步（上千个任务太慢）：控制面按顺序处理同一连接上的消息，之后的同步探测返回时它们都已处理完。
					agent.send({ case: "started", value: { taskId: task.taskId, attempt: task.attempt } });
					assigned.push({ agent, task, runId: task.runId });
				}
				return assigned;
			}),
		)
	).flat();
	const heartbeatMs = agents[0]?.welcome.heartbeatIntervalMs || 10_000;
	return { plan, metrics, agents, tasks, heartbeatMs };
}

/** 同步探测：发一条不存在任务的结果，等它的 Ack；控制面按顺序处理同一连接上的消息，所以返回时此前的批次都已处理完。 */
async function probe(agent: FakeAgent, attempt: number, timeoutMs: number): Promise<void> {
	agent.send({
		case: "result",
		value: { taskId: PROBE_TASK, attempt, status: TaskStatus.SUCCESS },
	});
	await agent.next("ack", { timeoutMs });
}

/** 发送心跳：带上手上全部任务（执行器都已启动），控制面为它们续约。 */
function heartbeat(agent: FakeAgent): void {
	agent.send({
		case: "heartbeat",
		value: {
			runningTasks: agent.held.map((t) => ({
				taskId: t.taskId,
				attempt: t.attempt,
				started: true,
			})),
		},
	});
}

/** 补一段历史数据：一个任务在 [toSecond - seconds, toSecond) 每秒每个指标一个点，每批 60 秒。返回补的秒数。 */
export async function backfill(
	fleet: LoadFleet,
	target: LoadTask,
	toSecond: number,
	seconds: number,
): Promise<number> {
	for (let start = toSecond - seconds; start < toSecond; start += 60) {
		const points: Array<[string, number, number]> = [];
		for (let t = start; t < Math.min(start + 60, toSecond); t++) {
			for (const [j, name] of fleet.metrics.entries()) points.push([name, t, (t % 600) + j]);
		}
		target.agent.metrics(target.task, points);
	}
	await probe(target.agent, 1, 120_000);
	return seconds;
}

/** 一次负载运行采集的原始数据（时间都是相对 startedAtMs 的毫秒数）。 */
export interface LoadRun {
	startedAtMs: number;
	/** 实际持续的秒数（被中断时比计划短）。 */
	seconds: number;
	/** 每个任务实时上报的秒数（同一任务每个指标相同）。 */
	sentSeconds: Map<LoadTask, number>;
	/** 每秒开始发送时比计划落后的最长时间。 */
	maxSendBehindMs: number;
	/** 同步探测的往返时间：控制面处理完此前全部批次所需的时间，持续增长即积压。 */
	probes: Array<{ ms: number; agent: number; rttMs: number }>;
	/** 最后一批发出后，到所有假 Agent 的同步探测都返回的时间；被中断时不排空，为 NaN。 */
	drainMs: number;
	/** 负载期间周期执行的查询及其耗时。 */
	queries: Array<{ ms: number; durationMs: number }>;
}

/**
 * 从 firstSecond 开始持续 seconds 秒：每到一个整秒，每个任务为每个指标上报这一秒的一个点；
 * 同时每个假 Agent 每秒做一次同步探测（测积压），按心跳间隔的一半发心跳，并按 1 秒的间隔串行执行 query
 * （测负载下的查询耗时）。结束后等所有假 Agent 的同步探测返回（排空）。signal 中断时提前结束、不排空，
 * 如实返回已采集的数据。
 */
export async function runLoad(options: {
	fleet: LoadFleet;
	firstSecond: number;
	seconds: number;
	query: () => Promise<void>;
	signal: AbortSignal;
	log: (m: string) => void;
}): Promise<LoadRun> {
	const { fleet, signal } = options;
	const startedAtMs = options.firstSecond * 1000;
	const sentSeconds = new Map<LoadTask, number>(fleet.tasks.map((t) => [t, 0]));
	const probes: LoadRun["probes"] = [];
	const queries: LoadRun["queries"] = [];
	let maxSendBehindMs = 0;
	let running = true;
	let probeAttempt = 1;
	const waitUntil = async (ms: number) => {
		const left = ms - Date.now();
		if (left > 0) await sleep(left, signal);
	};

	const probeLoops = fleet.agents.map(async (agent, i) => {
		while (running) {
			const started = Date.now();
			await probe(agent, ++probeAttempt, 600_000);
			probes.push({ ms: started - startedAtMs, agent: i, rttMs: Date.now() - started });
			await waitUntil(started + 1000);
		}
	});
	const queryLoop = (async () => {
		while (running) {
			const started = Date.now();
			await options.query();
			queries.push({ ms: started - startedAtMs, durationMs: Date.now() - started });
			await waitUntil(started + 1000);
		}
	})();
	const heartbeats = setInterval(
		() => fleet.agents.forEach(heartbeat),
		Math.max(1000, fleet.heartbeatMs / 2),
	);

	let seconds = 0;
	let lastSentAt = Date.now();
	try {
		for (let k = 0; k < options.seconds; k++) {
			const second = options.firstSecond + k;
			await waitUntil(second * 1000);
			maxSendBehindMs = Math.max(maxSendBehindMs, Date.now() - second * 1000);
			for (const t of fleet.tasks) {
				t.agent.metrics(
					t.task,
					fleet.metrics.map((name, j) => [name, second, (second % 600) + j]),
				);
				sentSeconds.set(t, (sentSeconds.get(t) ?? 0) + 1);
			}
			lastSentAt = Date.now();
			seconds = k + 1;
			if (k % 10 === 9) {
				const last = probes.at(-1);
				options.log(`已上报 ${seconds} 秒；最近一次同步探测 ${last?.rttMs ?? "-"} ms`);
			}
		}
	} catch (error) {
		if (!signal.aborted) throw error;
	} finally {
		running = false;
		clearInterval(heartbeats);
	}
	// 排空：每个假 Agent 再做一次同步探测，全部返回时控制面处理完了全部批次。
	// 被中断时不排空：终端的 Ctrl-C 同时发给了控制面进程，它可能已经退出。
	let drainMs = Number.NaN;
	if (!signal.aborted) {
		await Promise.all(fleet.agents.map((agent) => probe(agent, ++probeAttempt, 600_000)));
		drainMs = Date.now() - lastSentAt;
	}
	// 循环里的探测与查询可能还在等待（它们都会在排空后很快返回）；没被中断却失败了（查询出错等）就没法测下去。
	for (const outcome of await Promise.allSettled([...probeLoops, queryLoop])) {
		if (outcome.status === "rejected" && !signal.aborted) throw outcome.reason;
	}
	return { startedAtMs, seconds, sentSeconds, maxSendBehindMs, probes, drainMs, queries };
}

/** 负载结束：每个任务上报成功（控制面立即写入尚未写入的点），每个假 Agent 并行、各自逐个上报。 */
export async function finishTasks(fleet: LoadFleet): Promise<void> {
	await Promise.all(
		fleet.agents.map(async (agent) => {
			for (const t of fleet.tasks) if (t.agent === agent) await agent.succeed(t.task);
		}),
	);
}
