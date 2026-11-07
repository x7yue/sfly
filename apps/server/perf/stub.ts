// 桩节点包（testdata/stub-package，已发布为 sfly-stub@0.1.0）的场景与结果核对：各项用它的定速节点造负载
// （metric_rate、metric_clock、stdout_rate），这里放它们共用的场景文档、输出结构与核对。
import { checkNumbered, checkSequence, type NumberedCheck, secondWindows } from "./checks.js";
import { type PerfApi, sleep } from "./stack.js";

/** metric_rate 的输出：按定速上报 gauge `seq = 1..count`。 */
export interface RateOutputs {
	count: number;
	elapsed: number;
	max_behind_ms: number;
	max_call_ms: number;
}

/** stdout_rate 的输出：定速写出 lines 行带序号的定长行。 */
export interface StdoutOutputs {
	lines: number;
	bytes: number;
	elapsed: number;
	max_behind_ms: number;
}

/** 新建一个场景：入口 → 一个桩节点（场景里的 ID 为 nodeId），默认 Agent 为 agentName。返回场景 ID。 */
export function stubScenario(
	api: PerfApi,
	agentName: string,
	nodeId: string,
	node: string,
	inputs: unknown,
	name = "perf",
): Promise<string> {
	return api.createOrchestration(
		{
			default_agent: agentName,
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: nodeId, kind: "package", package: "sfly-stub", node, inputs },
			],
			edges: [{ from: "entry", to: nodeId, kind: "chain" }],
			packages: { "sfly-stub": "0.1.0" },
		},
		name,
	);
}

/** 一次结束了的桩节点任务（PerfApi.succeeded 的结果加上运行与节点 ID）。 */
export interface FinishedTask {
	runId: string;
	nodeId: string;
	chainInstanceId: string;
	startedMs: number;
	endedMs: number;
}

/**
 * 核对 metric_rate 上报的 seq（第 i 次上报 seq = i，共 count 次）：先等最后一个点写进控制面（最多 30 秒；
 * 丢了就等到超时，再如实核对），再按任务的执行时段分段查询每秒一个桶的序列，按序号核对不丢不重。
 */
export async function checkSeqMetric(
	api: PerfApi,
	task: FinishedTask,
	count: number,
	signal: AbortSignal,
) {
	const written = async () =>
		(await api.metricCatalog(task.runId)).nodes
			.find((n) => n.node_id === task.nodeId)
			?.attempts.at(-1);
	const deadline = Date.now() + 30_000;
	let attempt = await written();
	while (attempt?.metrics.find((m) => m.name === "seq")?.last !== count && Date.now() < deadline) {
		await sleep(500, signal);
		attempt = await written();
	}
	const first = Math.floor(task.startedMs / 1000) - 1;
	const last = Math.ceil(task.endedMs / 1000) + 1;
	const buckets: Awaited<ReturnType<PerfApi["metricSeriesRange"]>>["series"][number]["buckets"] =
		[];
	// 每段不超过 1 小时：保持每秒一个桶。
	for (const [from, to] of secondWindows(first, last, 3600)) {
		const series = await api.metricSeriesRange(
			task.runId,
			task.chainInstanceId,
			task.nodeId,
			from,
			to,
		);
		const part = series.series.find((s) => s.name === "seq")?.buckets ?? [];
		if (part.length > 0 && series.bucket_seconds !== 1) {
			throw new Error(`序列不是每秒一个桶（${series.bucket_seconds} 秒）`);
		}
		buckets.push(...part);
	}
	const writtenPoints = attempt?.metrics.find((m) => m.name === "seq")?.points ?? 0;
	const sequence = checkSequence(buckets, count);
	return {
		buckets,
		/** 能确定丢失的事件数与重复的事件数。 */
		sequence,
		/** 同一秒多出的点：同一秒写了两个点时，序列的桶点数与目录的写入点数都会多出来，取其一。 */
		duplicatePoints: Math.max(sequence.duplicatePoints, writtenPoints - buckets.length),
		writtenPoints,
		droppedPoints: attempt?.dropped_points ?? 0,
		truncated: attempt?.truncated ?? false,
	};
}

/** stdout_rate 写出的一行（「序号 + 空格 + 填充」）：行首序号与长度（不含换行）。 */
export interface StdoutLine {
	number: number;
	length: number;
}

export const stdoutLine = (text: string): StdoutLine => ({
	number: Number(text.slice(0, text.indexOf(" "))),
	length: text.length,
});

/** 核对 stdout_rate 写出的行：1..count 各出现一次（与顺序无关），以及长度不是 lineBytes - 1 的行数。 */
export function checkStdoutLines(
	lines: ReadonlyArray<StdoutLine>,
	count: number,
	lineBytes: number,
): NumberedCheck & { malformed: number } {
	return {
		...checkNumbered(
			lines.map((l) => l.number),
			count,
		),
		malformed: lines.filter((l) => l.length !== lineBytes - 1).length,
	};
}
