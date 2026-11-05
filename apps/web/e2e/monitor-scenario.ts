// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import type { Page } from "@playwright/test";
import {
	type AssignedTask,
	type FakeAgent,
	LogLevel,
	LogSource,
} from "../../server/test/support/fake-agent.js";
import type { ManualClock } from "../../server/test/support/manual-clock.js";
import { packageMetadata } from "../../server/test/support/package-archive.js";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import { type E2eFixtures, expect } from "./fixtures";
import { createScenario, publishPackage, triggerRun } from "./support";

// 运行监控页端到端测试与视觉回归共用的场景。

/**
 * 场景：entry → fetch → spawn（派发子流程 sub → probe）→ verify（重试 1 次）→ cleanup（always）。
 * token 是敏感参数，fetch 的输入引用了它。
 */
export const MONITOR_SCENARIO = {
	default_agent: "agent-a",
	nodes: [
		{
			id: "entry",
			kind: "entry",
			params: [
				{ name: "region", type: "string", default: "cn-east" },
				{ name: "token", type: "string", default: "s3cr3t-token", secret: true },
			],
		},
		{
			id: "fetch",
			kind: "package",
			package: "demo-checks",
			node: "http_check",
			inputs: { url: "https://example.test/${{ params.region }}", token: "${{ params.token }}" },
		},
		{ id: "spawn", kind: "async", params: {} },
		{
			id: "verify",
			kind: "package",
			package: "demo-checks",
			node: "ping",
			inputs: { host: "${{ params.region }}" },
			retries: 1,
		},
		{
			id: "cleanup",
			kind: "package",
			package: "demo-checks",
			node: "ping",
			inputs: { host: "localhost" },
			always: true,
		},
		{ id: "sub", kind: "subflow_entry", params: [] },
		{ id: "probe", kind: "package", package: "demo-checks", node: "ping", inputs: { host: "p" } },
	],
	edges: [
		{ from: "entry", to: "fetch", kind: "chain" },
		{ from: "fetch", to: "spawn", kind: "chain" },
		{ from: "spawn", to: "verify", kind: "chain" },
		{ from: "verify", to: "cleanup", kind: "chain" },
		{ from: "sub", to: "probe", kind: "chain" },
		{ from: "spawn", to: "sub", kind: "dispatch" },
	],
	packages: { "demo-checks": "1.2.0" },
};

/**
 * demo-checks 的节点类型带上指标声明（#27）：http_check 声明了折线（两条序列）、面积、柱状三张图表，
 * errors 没被图表引用，控制面补一张默认的数值卡；ping 与桩节点包的 metrics 节点相同（level 瞬时值、
 * total 累计值，都是默认图表）。
 */
export const METRIC_NODES = {
	http_check: {
		metrics: [
			{ name: "latency_ms", unit: "ms", kind: "gauge" },
			{ name: "p99_ms", unit: "ms", kind: "gauge" },
			{ name: "rps", unit: "req/s", kind: "gauge" },
			{ name: "requests", unit: "次", kind: "counter" },
			{ name: "errors", unit: "次", kind: "counter" },
		],
		charts: [
			{ title: "延迟", type: "line", metrics: ["latency_ms", "p99_ms"] },
			{ title: "吞吐", type: "area", metrics: ["rps"] },
			{ title: "请求数", type: "bar", metrics: ["requests"] },
		],
		primary_metric: "latency_ms",
	},
	ping: {
		metrics: [
			{ name: "level", unit: "", kind: "gauge", description: "瞬时值" },
			{ name: "total", unit: "", kind: "counter", description: "累计值" },
		],
		primary_metric: "level",
	},
} as const;

/** demo-checks@1.2.0，节点类型带指标声明。 */
export const metricPackage = () => {
	const base = packageMetadata();
	return {
		nodes: (base.nodes as { name: keyof typeof METRIC_NODES }[]).map((n) => ({
			...n,
			...METRIC_NODES[n.name],
		})),
	};
};

/** 运行开始（手动时钟起点）之后第 s 秒的 Unix 秒。 */
export const unixAt = (clock0: number, s: number) => Math.floor(clock0 / 1000) + s;

/** http_check 的指标：每秒一组点，第 from 到 to 秒（相对运行开始）。 */
export function httpCheckPoints(clock0: number, from: number, to: number) {
	const out: [string, number, number][] = [];
	for (let s = from; s <= to; s++) {
		const i = s - from;
		const t = unixAt(clock0, s);
		out.push(["latency_ms", t, 40 + ((i * 7) % 11)]);
		out.push(["p99_ms", t, 90 + ((i * 13) % 17)]);
		out.push(["rps", t, 120 + i * 15]);
		out.push(["requests", t, (i + 1) * 130]);
		out.push(["errors", t, Math.floor(i / 2)]);
	}
	return out;
}

/** ping 的指标（level 瞬时值、total 累计值）：第 from 到 to 秒。 */
export function pingPoints(clock0: number, from: number, to: number, base = 3) {
	const out: [string, number, number][] = [];
	for (let s = from; s <= to; s++) {
		const i = s - from;
		out.push(["level", unixAt(clock0, s), base + ((i * 5) % 7)]);
		out.push(["total", unixAt(clock0, s), (i + 1) * 2]);
	}
	return out;
}

const STACK =
	'Traceback (most recent call last):\n  File "verify.py", line 42, in run\nAssertionError';

/** 一行日志：time 为手动时钟的当前时刻加 offsetMs。 */
export const logLine = (
	clock: ManualClock,
	seq: number,
	text: string,
	level = LogLevel.INFO,
	offsetMs = 0,
) => ({
	seq: BigInt(seq),
	timeUnixMs: BigInt(clock.now().getTime() + offsetMs),
	source: LogSource.STDOUT,
	level,
	text,
});

/** 收下 n 个派发，按节点 ID 索引。 */
async function assigns(agent: FakeAgent, n: number, start = true) {
	const out: Record<string, AssignedTask> = {};
	for (let i = 0; i < n; i++) {
		const task = await agent.nextAssign({ start });
		out[task.nodeId] = task;
	}
	return out;
}

export interface Running {
	runId: string;
	scenarioId: string;
	agent: FakeAgent;
	tasks: Record<string, AssignedTask>;
}

/**
 * 运行到这个状态（手动时钟，从触发开始计时）：fetch 排队 2 秒、执行 4 秒后成功；子流程 probe 与
 * verify 同时执行；verify 第 1 次在 3 秒后失败（带堆栈），第 2 次执行中；cleanup（always）待执行。
 * 指标：fetch 在第 2–5 秒、probe 在第 6–13 秒、verify 第 2 次在第 9–13 秒每秒上报一组点。
 */
export async function runningScenario(
	controlPlane: TestControlPlane,
	connectAgent: E2eFixtures["connectAgent"],
	clock: ManualClock,
): Promise<Running> {
	const agent = await connectAgent({
		name: "agent-a",
		slots: 4,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	await publishPackage(controlPlane, metricPackage());
	const scenarioId = await createScenario(controlPlane, "日终数据处理", MONITOR_SCENARIO);
	const clock0 = clock.now().getTime();
	const runId = await triggerRun(controlPlane, scenarioId);

	const fetch = await agent.nextAssign({ start: false });
	clock.advance(2000);
	await agent.started(fetch);
	agent.logs(fetch, [
		logLine(clock, 1, "开始执行", LogLevel.INFO),
		logLine(clock, 2, "load config ok", LogLevel.DEBUG, 1000),
		logLine(clock, 3, "retrying request (1/3): connection reset", LogLevel.WARN, 2000),
		logLine(clock, 4, "batch committed", LogLevel.INFO, 3000),
	]);
	agent.metrics(fetch, httpCheckPoints(clock0, 2, 5));
	clock.advance(4000);
	await agent.succeed(fetch, { status: 200 });

	const first = await assigns(agent, 2);
	clock.advance(3000);
	await agent.fail(first.verify as AssignedTask, `AssertionError: 漏拦 3 笔\n\n${STACK}`);
	const retry = await agent.nextAssign();
	agent.metrics(first.probe as AssignedTask, pingPoints(clock0, 6, 13));
	agent.metrics(retry, pingPoints(clock0, 9, 13, 5));
	await agent.sync();
	clock.advance(5000);
	return { runId, scenarioId, agent, tasks: { fetch, ...first, verify: retry } };
}

/** 打开监控页：浏览器时间固定在手动时钟的当前时刻。 */
export async function openMonitor(page: Page, clock: ManualClock, runId: string, node?: string) {
	await page.clock.setFixedTime(clock.now());
	await page.goto(`/runs/${runId}${node ? `?node=${node}` : ""}`);
	await expect(page.getByRole("region", { name: "链路时间线" })).toBeVisible();
}
