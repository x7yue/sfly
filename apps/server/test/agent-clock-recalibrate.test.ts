// 连接期间重新校准时间换算（#389，ADR 0018「按连接和心跳时测得的时钟偏差折算」）：#389 里的两种漂移，
// 控制面墙上时钟在连接之后被拨快 30 分钟、Agent 的单调时钟走速是控制面的 0.9 倍。每 60 秒上报一个点，共 21 个点，
// 看点换算成控制面时间以后有几个落在运行监控图表的窗口里（这次尝试开始到现在，apps/web/src/monitor/charts.ts 的 chartWindow）。
import { bucketStartMs, metricsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { type AssignedTask, agentClock, FakeAgent } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const START = "2026-11-17T09:00:00.000Z";
const MINUTE = 60_000;
const HELLO_MONOTONIC_MS = 1_000_000;

const ORCHESTRATION = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "watch", kind: "package", package: "mon", node: "watch" },
	],
	edges: [{ from: "entry", to: "watch", kind: "chain" }],
	packages: { mon: "1.0.0" },
};

describe("连接期间重新校准时间换算（#389）", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;
	const clock = new ManualClock(START);
	/** Agent 的单调时钟读数（毫秒）：测试自己推进。 */
	let mono = HELLO_MONOTONIC_MS;

	beforeEach(async () => {
		clock.set(START);
		mono = HELLO_MONOTONIC_MS;
		// 租约放长：测试里一下推进几分钟、几小时的控制面时间，不让任务因为没续约被当成失联。
		cp = await startTestControlPlane({ clock, leaseMs: 24 * 60 * MINUTE });
		api = new ApiClient(cp);
		await publishPackage(cp, "mon", "1.0.0", {
			watch: {
				outputs: [],
				metrics: [
					{ name: "cpu", unit: "%", kind: "gauge" },
					{ name: "mem", unit: "MB", kind: "gauge" },
				],
			},
		});
		agent = await FakeAgent.connect(cp.grpcUrl, {
			name: "agent-a",
			...agentClock(clock.now(), HELLO_MONOTONIC_MS),
		});
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	/** 控制面时间和 Agent 的单调时钟分别走 `cpMs`、`monoMs`，然后发一次心跳（带上手上的任务）。 */
	const tick = async (cpMs: number, monoMs: number) => {
		clock.advance(cpMs);
		mono += monoMs;
		await agent.heartbeat(agent.held, agentClock(clock.now(), mono));
	};
	const point = (task: AssignedTask, value: number, name = "cpu") =>
		agent.metrics(task, [
			{
				name,
				timeUnixS: BigInt(Math.floor(clock.now().getTime() / 1000)),
				monotonicMs: BigInt(mono),
				value,
				min: value,
				max: value,
			},
		]);

	/** 序列查询返回的桶、其中落在图表窗口（这次尝试开始到现在）里的桶。 */
	const inChartWindow = async (runId: string) => {
		const run = await api.run(runId);
		const chain = run.chains[0];
		const started = chain?.nodes.find((n) => n.node_id === "watch")?.attempts.at(-1)?.started_at;
		if (!chain || !started) throw new Error("watch 还没有开始执行");
		const params = new URLSearchParams({
			chain_instance_id: chain.id,
			node_id: "watch",
			metrics: "cpu",
			points: "300",
		});
		const series = metricsApi.series.response.parse(
			await api.getJson(`/runs/${runId}/metrics/series?${params}`),
		);
		const buckets = series.series[0]?.buckets ?? [];
		const from = Date.parse(started);
		const to = clock.now().getTime();
		return {
			buckets: buckets.length,
			inWindow: buckets.filter((b) => {
				const t = bucketStartMs(b);
				return t + series.bucket_seconds * 1000 > from && t <= to;
			}).length,
		};
	};

	/** 这次尝试一个指标的序列里点的控制面时间（毫秒），按序列查询返回的顺序；每个点一个桶。 */
	const seriesTimes = async (runId: string, metric: string) => {
		const run = await api.run(runId);
		const params = new URLSearchParams({
			chain_instance_id: run.chains[0]?.id ?? "",
			node_id: "watch",
			metrics: metric,
			points: "300",
		});
		const series = metricsApi.series.response.parse(
			await api.getJson(`/runs/${runId}/metrics/series?${params}`),
		);
		return (series.series[0]?.buckets ?? []).map(bucketStartMs);
	};

	const startRun = async () => {
		const id = await api.orchestrationWith(ORCHESTRATION);
		const runId = await api.triggerOk(id);
		const task = await agent.nextAssign();
		return { runId, task };
	};

	it("收到 Hello 之后控制面墙上时钟被拨快 30 分钟：连续两次心跳都对不上以后重新估算，21 个点都落在图表窗口里", async () => {
		// 单调时钟不动，控制面的墙上时钟跳了 30 分钟（NTP 校时、虚拟机休眠恢复）。
		await tick(30 * MINUTE, 0);
		const { runId, task } = await startRun();
		for (let i = 0; i < 21; i++) {
			await tick(MINUTE, MINUTE);
			point(task, i);
		}
		await agent.sync();

		// 跳变之后的第一次心跳只记下（可能是这一次晚到），第二次心跳（第一个点之前）重新估算：21 个点都落在窗口里。
		expect(await inChartWindow(runId)).toEqual({ buckets: 21, inWindow: 21 });
	});

	it("控制面墙上时钟往回拨 30 分钟：一次心跳就重新估算，新的序列的点立即落在纠正后的时间；已有序列里的顺序不乱（往后排一秒兜底）", async () => {
		const { runId, task } = await startRun();
		for (let i = 0; i < 5; i++) {
			await tick(MINUTE, MINUTE);
			point(task, i);
		}
		// 墙上时钟往回拨 30 分钟，单调时钟照走；拨回之后的第一次心跳就重新估算。
		await tick(MINUTE - 30 * MINUTE, MINUTE);
		const corrected = Math.floor(clock.now().getTime() / 1000) * 1000;
		point(task, 100);
		point(task, 7, "mem");
		await agent.sync();

		// 还没出现过的序列：点就在纠正后的时间（控制面时间现在）。
		expect(await seriesTimes(runId, "mem")).toEqual([corrected]);
		// 已有的序列：纠正后的时间比前面的点早，排到最后一个点的后一秒，顺序不乱、不丢点。
		const cpu = await seriesTimes(runId, "cpu");
		expect(cpu).toHaveLength(6);
		expect(cpu).toEqual([...cpu].sort((x, y) => x - y));
		expect(cpu[5]).toBe((cpu[4] ?? 0) + 1000);
	});

	it("Agent 的单调时钟走速是控制面的 0.9 倍、连接 4 小时：心跳时不断重新估算，21 个点都落在图表窗口里", async () => {
		for (let m = 0; m < 219; m++) await tick(MINUTE, 0.9 * MINUTE);
		const { runId, task } = await startRun();
		await tick(MINUTE, 0.9 * MINUTE);
		for (let i = 0; i < 21; i++) {
			await tick(MINUTE, 0.9 * MINUTE);
			point(task, i);
		}
		await agent.sync();

		expect(await inChartWindow(runId)).toEqual({ buckets: 21, inWindow: 21 });
	});
});
