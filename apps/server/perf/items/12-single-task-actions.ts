// 负载：单个任务以每秒 1 万次事件记录动作（ARCHITECTURE §7.6「单个任务 SDK → Agent」，#357）。
// 桩节点 action_rate 每秒记录 5000 个动作（每个写开始、结束两行事件），轮流用 4 种名称，共 30 秒、15 万个：
// 前 10 万个有明细，经 Agent 的 ActionBatch 写进控制面的 task_actions，之后合计已满、只计数。
// 硬性断言：存下的明细正好是摘要里 SDK 上报了明细的那些（不丢不重），计数等于记录的个数。
// 只记录：实际速率与节点比计划落后的时间（节点是否被阻塞）、单次 ctx.action() 最长耗时、Agent 与控制面的内存和 CPU。
import { actionsApi, MAX_ACTION_PAGE } from "@sfly/schema";
import { definePerfItem, hard, type ItemRun, target } from "../item.js";
import { AGENT, CONTROL_PLANE, usageMeasurements } from "../measure.js";
import type { Measurement } from "../report.js";
import { sampleProcess, startStack } from "../stack.js";
import { type RateOutputs, stubScenario } from "../stub.js";
import { EVENTS_PER_SECOND } from "../targets.js";

const SECONDS = 30;
const NODE_ID = "actions";
/** 每个动作写两行事件。 */
const ACTIONS_PER_SECOND = EVENTS_PER_SECOND / 2;

export default definePerfItem({
	id: "single-task-actions",
	title: "单任务每秒 1 万次动作事件",
	scope: "单个任务 SDK → Agent",
	needsArtifacts: true,
	async run(ctx): Promise<ItemRun> {
		const { agent, agentName, api, server } = await startStack(ctx);
		const scenario = await stubScenario(api, agentName, NODE_ID, "action_rate", {
			rate: ACTIONS_PER_SECOND,
			seconds: SECONDS,
		});

		const agentSampler = sampleProcess(agent.child.pid as number);
		const serverSampler = sampleProcess(server.child.pid as number);
		ctx.log(`节点按每秒 ${ACTIONS_PER_SECOND} 个动作记录 ${SECONDS} 秒`);
		const runId = await api.trigger(scenario);
		const task = await api.succeeded<RateOutputs>(
			runId,
			NODE_ID,
			ctx.signal,
			(SECONDS + 120) * 1000,
		);
		const agentUsage = usageMeasurements(await agentSampler.stop(), AGENT, {
			rssMb: 2,
			cpuPercent: 2,
		});
		const serverUsage = usageMeasurements(await serverSampler.stop(), CONTROL_PLANE, {
			rssMb: 20,
			cpuPercent: 5,
		});
		const { outputs, attempt } = task;
		const summary = actionsApi.summary.response.parse(
			await api.getJson(`/tasks/${attempt.task_id}/actions/summary`),
		);

		// 往前翻完全部明细，按 ID 核对：SDK 只上报前 10 万个（ID 1..reported），控制面存下的应该正好是这些。
		const seen = new Set<number>();
		let duplicated = 0;
		let before: string | null = null;
		const readStarted = performance.now();
		do {
			const query = new URLSearchParams({ limit: String(MAX_ACTION_PAGE) });
			if (before) query.set("before", before);
			const page = actionsApi.page.response.parse(
				await api.getJson(`/tasks/${attempt.task_id}/actions?${query}`),
			);
			for (const action of page.actions) {
				if (seen.has(action.id)) duplicated++;
				seen.add(action.id);
			}
			before = page.before;
		} while (before);
		const readMs = performance.now() - readStarted;
		let missing = 0;
		for (let id = 1; id <= summary.reported; id++) if (!seen.has(id)) missing++;

		const measurements: Measurement[] = [
			{
				id: "missing_details",
				label: "丢失的明细（SDK 上报了、控制面没有存下）",
				value: missing,
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "extra_details",
				label: "多出的明细（存下的比 SDK 上报的多）",
				value: seen.size - (summary.reported - missing),
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "duplicated_details",
				label: "重复的明细",
				value: duplicated,
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "uncounted_actions",
				label: "摘要的计数与记录的个数之差",
				value: Math.abs(summary.total - outputs.count),
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "action_rate",
				label: "实际记录速率",
				value: outputs.count / outputs.elapsed,
				unit: "个/秒",
				check: target(">=", ACTIONS_PER_SECOND),
			},
			{
				id: "max_behind_ms",
				label: "节点比计划落后的最长时间",
				value: outputs.max_behind_ms,
				unit: "ms",
				noise: 5,
				check: target("<=", 1000),
			},
			{
				id: "max_call_ms",
				label: "单次 ctx.action() 最长耗时",
				value: outputs.max_call_ms,
				unit: "ms",
				noise: 5,
			},
			{
				id: "read_all_ms",
				label: `按页读完全部明细的时间（每页 ${MAX_ACTION_PAGE} 个）`,
				value: readMs,
				unit: "ms",
				noise: 200,
			},
			agentUsage.peak,
			agentUsage.growth,
			agentUsage.cpu,
			serverUsage.peak,
			serverUsage.growth,
			serverUsage.cpu,
		];
		return {
			measurements,
			series: [agentUsage.series, serverUsage.series],
			notes: [
				`节点计划每秒记录 ${ACTIONS_PER_SECOND} 个动作（${EVENTS_PER_SECOND} 次事件）、共 ${SECONDS} 秒，实际记录 ${outputs.count} 个，用时 ${outputs.elapsed.toFixed(2)} 秒。`,
				`SDK 上报了 ${summary.reported} 个明细（合计上限 10 万个），控制面存下 ${seen.size} 个；摘要计数 ${summary.total} 个。`,
			],
		};
	},
});
