import type { Page } from "@playwright/test";
import { ERROR_LOCATION_LABEL } from "@sfly/schema";
import { actAs } from "../../server/test/support/credentials.js";
import {
	type AssignedTask,
	ErrorKind,
	type FakeAgent,
	LogLevel,
} from "../../server/test/support/fake-agent.js";
import type { ManualClock } from "../../server/test/support/manual-clock.js";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import { type E2eFixtures, expect } from "./fixtures";
import { logLine, metricPackage, pingPoints } from "./monitor-scenario";
import { createRunPreset } from "./run-presets-support";
import { createScenario, publishPackage } from "./support";

// 运行监控里「失败的运行」的端到端测试与视觉回归共用的场景：节点有显示名称，断言失败的错误信息是多行的
// （第一行以冒号结尾，原因在第二行；之后是堆栈），运行用了名字很长的运行预设。

/** 失败的节点：断言节点，显示名称和节点 ID 都不短。 */
export const FAILED_NODE = "assert_success_rate";
export const FAILED_NAME = "达标才算通过";

/**
 * 错误信息的原文：第一行有异常模块路径、以冒号结尾，原因在第二行，之后是堆栈。
 * 失败原因一行（`errorHeadline`）取 {@link FAILURE_HEADLINE}。
 */
export const FAILURE_MESSAGE =
	'sfly_std.assert_.AssertionFailed: 1 条断言中 1 条不通过：\n第 1 条：成功率 97.2% 低于阈值 99%（共 12840 次请求，失败 359 次）\n\nTraceback (most recent call last):\n  File "assert_.py", line 42, in run\n    raise AssertionFailed(report)\nsfly_std.assert_.AssertionFailed: 1 条断言中 1 条不通过：';
export const FAILURE_HEADLINE =
	"AssertionFailed: 1 条断言中 1 条不通过：第 1 条：成功率 97.2% 低于阈值 99%（共 12840 次请求，失败 359 次）";

/**
 * 病态的失败原因：几千字的单行（没有换行、没有堆栈、没有异常模块路径，所以失败原因一行就是它自己）。
 * 失败区域里原因最多显示 4 行，更长的收起，全文在「展开全文」里。
 */
export const LONG_FAILURE_MESSAGE = "成功率持续低于阈值，已重试三轮仍未恢复；".repeat(200);

/** 失败的节点出错的位置（节点代码里的那一行，`error.location`）：`failedRun` 默认带着它，给空串表示没有。 */
export const FAILURE_LOCATION = "sfly_std.assert_.check_rate 第 42 行";

export const PRESET_NAME = "压测 A 集群（北京机房，高并发）";

const ping = (id: string, display_name: string, extra: Record<string, unknown> = {}) => ({
	id,
	kind: "package",
	package: "demo-checks",
	node: "ping",
	inputs: { host: id },
	display_name,
	...extra,
});

/** 主链 entry → 准备环境 → 部署 → 断言 → 生成报告 → 发布结果 → 清理（always）。 */
export const FAILURE_SCENARIO = {
	default_agent: "agent-a",
	nodes: [
		{
			id: "entry",
			kind: "entry",
			params: [{ name: "cluster", type: "string", default: "a" }],
		},
		ping("prepare", "准备压测环境"),
		ping("deploy", "部署被测服务"),
		ping(FAILED_NODE, FAILED_NAME),
		ping("report", "生成压测报告"),
		ping("publish", "发布压测结果"),
		ping("cleanup", "清理压测环境", { always: true }),
	],
	edges: [
		{ from: "entry", to: "prepare", kind: "chain" },
		{ from: "prepare", to: "deploy", kind: "chain" },
		{ from: "deploy", to: "assert_success_rate", kind: "chain" },
		{ from: "assert_success_rate", to: "report", kind: "chain" },
		{ from: "report", to: "publish", kind: "chain" },
		{ from: "publish", to: "cleanup", kind: "chain" },
	],
	packages: { "demo-checks": "1.2.0" },
};

export interface FailureRun {
	runId: string;
	scenarioId: string;
	agent: FakeAgent;
	/** 断言节点的任务（失败之后还握着它的引用，方便补日志）。 */
	failed: AssignedTask;
	/** 清理节点（always）的任务。 */
	cleanup: AssignedTask;
}

/**
 * 运行到这个状态：准备、部署成功，断言（第 1 次尝试）失败，生成报告和发布结果被跳过，清理（always）
 * `cleanupDone` 为 true 时成功、运行以失败结束；为 false 时清理刚派发、执行中，运行还在进行（已有节点失败）。
 */
export async function failedRun(
	controlPlane: TestControlPlane,
	connectAgent: E2eFixtures["connectAgent"],
	clock: ManualClock,
	options: {
		cleanupDone: boolean;
		preset?: boolean;
		message?: string;
		location?: string;
		/** 准备、部署两个节点各上报一组指标（level、total），图表工作区里有图表卡片。 */
		metrics?: boolean;
		/** 失败的节点在出错之前还写了一行 WARN 日志（概览的「其他警告与错误」里除了它自己的 ERROR 日志，还有这一行）。 */
		warn?: string;
	} = {
		cleanupDone: true,
	},
): Promise<FailureRun> {
	const agent = await connectAgent({
		name: "agent-a",
		slots: 4,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	await publishPackage(controlPlane, metricPackage());
	const scenarioId = await createScenario(controlPlane, "压测成功率回归", FAILURE_SCENARIO);
	const body: Record<string, unknown> = { params: { cluster: "a" } };
	if (options.preset !== false) {
		body.params = {};
		body.preset = await createRunPreset(controlPlane, scenarioId, {
			name: PRESET_NAME,
			params: [{ name: "cluster", value: "a" }],
		});
	}
	const res = await controlPlane.fetch(`/orchestrations/${scenarioId}/runs`, {
		method: "POST",
		headers: { "content-type": "application/json", ...actAs("tester") },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`触发运行：HTTP ${res.status} ${await res.text()}`);
	const { id: runId } = (await res.json()) as { id: string };

	for (const step of ["prepare", "deploy"]) {
		const task = await agent.nextAssign();
		expect(task.nodeId).toBe(step);
		const started = clock.now().getTime();
		clock.advance(3000);
		if (options.metrics) {
			agent.metrics(task, pingPoints(started, 0, 3));
			await agent.sync();
		}
		await agent.succeed(task);
	}
	const failed = await agent.nextAssign();
	expect(failed.nodeId).toBe(FAILED_NODE);
	const location = options.location ?? FAILURE_LOCATION;
	// 和真的执行器一样：节点出错时先写一行 ERROR「出错位置：…」（有位置时），再写异常（堆栈）本身；它不是失败原因全文的一部分。
	const errorLines = [
		...(location === "" ? [] : [`${ERROR_LOCATION_LABEL}：${location}`]),
		"成功率 97.2% 低于阈值 99%",
	];
	agent.logs(failed, [
		...(options.warn ? [logLine(clock, 1, options.warn, LogLevel.WARN)] : []),
		...errorLines.map((text, i) =>
			logLine(clock, (options.warn ? 2 : 1) + i, text, LogLevel.ERROR),
		),
	]);
	clock.advance(5000);
	await agent.fail(
		failed,
		options.message ?? FAILURE_MESSAGE,
		ErrorKind.NODE_ERROR,
		undefined,
		location,
	);
	const cleanup = await agent.nextAssign();
	if (options.cleanupDone) {
		clock.advance(2000);
		await agent.succeed(cleanup);
	}
	clock.advance(1000);
	return { runId, scenarioId, agent, failed, cleanup };
}

/** 打开运行监控的概览；浏览器时间固定在手动时钟的当前时刻。 */
export async function openFailedOverview(page: Page, clock: ManualClock, runId: string) {
	await page.clock.setFixedTime(clock.now());
	await page.goto(`/runs/${runId}?view=overview`);
	await expect(page.getByRole("heading", { name: "链路", level: 2, exact: true })).toBeVisible();
}
