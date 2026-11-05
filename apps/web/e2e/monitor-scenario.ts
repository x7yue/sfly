// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import type { Page } from "@playwright/test";
import {
	type AssignedTask,
	type FakeAgent,
	LogLevel,
	LogSource,
} from "../../server/test/support/fake-agent.js";
import type { ManualClock } from "../../server/test/support/manual-clock.js";
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
	await publishPackage(controlPlane);
	const scenarioId = await createScenario(controlPlane, "日终数据处理", MONITOR_SCENARIO);
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
	clock.advance(4000);
	await agent.succeed(fetch, { status: 200 });

	const first = await assigns(agent, 2);
	clock.advance(3000);
	await agent.fail(first.verify as AssignedTask, `AssertionError: 漏拦 3 笔\n\n${STACK}`);
	const retry = await agent.nextAssign();
	clock.advance(5000);
	return { runId, scenarioId, agent, tasks: { fetch, ...first, verify: retry } };
}

/** 打开监控页：浏览器时间固定在手动时钟的当前时刻。 */
export async function openMonitor(page: Page, clock: ManualClock, runId: string, node?: string) {
	await page.clock.setFixedTime(clock.now());
	await page.goto(`/runs/${runId}${node ? `?node=${node}` : ""}`);
	await expect(page.getByRole("region", { name: "链路时间线" })).toBeVisible();
}
