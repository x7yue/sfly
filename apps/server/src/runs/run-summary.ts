import {
	type EndedActionView,
	errorHeadline,
	projectRunState,
	RUN_REPORT_LIMITS,
	type RunReport,
	type RunReportAttentionItem,
	type RunReportFailedAction,
	type RunReportFailedTask,
} from "@sfly/schema";
import { eq, sql } from "drizzle-orm";
import { maskedAction } from "../actions/action-text.js";
import type { Db, Tx } from "../db/database.js";
import { taskActionSummaries, tasks } from "../db/schema.js";
import { type RunFocusDeps, resolveRunFocus } from "../focus/run-focus.js";
import { readLogPage } from "../logs/log-pages.js";
import type { TaskLogs } from "../logs/task-logs.js";
import { withSession } from "../sessions/session-ref.js";
import { type RunReadFull, readRuns } from "./run-read.js";
import { runStateSource } from "./run-state-source.js";

/*
 * 运行摘要（`GET /runs/:id/summary`，契约见 @sfly/schema 的 `RunReport`）：运行状态（`RunState`）加上只有接口给得起的内容。
 *
 * - 运行状态从运行的统一读取（`readRuns`）投影出来（`projectRunState`），不另写一套加载；错误信息、参数里 secret 参数的值
 *   在读取时已经打码。
 * - 失败的任务的日志尾部读日志文件（每个任务一次文件读取，不查库）；失败的动作取任务动作摘要里最近失败的那几个，
 *   一次查询读出全运行的；有异常的关注项只在场景设了关注项时取（最多 8 项）。
 * - 查询次数与运行里的节点数无关：运行的读取、日志文件概况、动作摘要各一次（关注项的读数也不随节点数增长）。
 */

export interface RunReportDeps extends RunFocusDeps {
	/** 一次运行全部任务的日志文件概况（一次查询）。 */
	logs: Pick<TaskLogs, "describeRun" | "logMask">;
}

type ReadChain = RunReadFull["chains"][number];
type ReadNode = ReadChain["nodes"][number];

/** 一次运行的摘要；运行不存在时为 undefined。 */
export async function buildRunReport(
	deps: RunReportDeps,
	runId: string,
): Promise<RunReport | undefined> {
	const read = (await readRuns(deps.db, [runId], "full")).get(runId);
	if (!read) return undefined;
	const failed = failedTasksOf(read);
	const listed = failed.slice(0, RUN_REPORT_LIMITS.failedTasks);
	const logs = await taskLogTails(deps, read, listed);
	const { run } = read;
	return {
		...projectRunState(runStateSource(read)),
		...withSession(read.session),
		duration_ms: run.endedAt ? Math.max(0, run.endedAt.getTime() - run.startedAt.getTime()) : null,
		failed_tasks: listed.map((task) => failedTaskView(read, task, logs)),
		failed_tasks_total: failed.length,
		failed_actions: await failedActionsOf(deps.db, read),
		attention_items: await attentionItemsOf(deps, read),
		secrets_oversize: read.secretsOversize,
		late_reports_dropped: read.run.lateReportsDropped,
	};
}

/** 失败的任务：节点的一次失败的尝试。 */
interface FailedTask {
	chain: ReadChain;
	node: ReadNode;
	attempt: ReadNode["attempts"][number] | undefined;
}

/**
 * 全部失败的任务，按链实例的顺序、节点在链上的顺序，同一个节点按尝试的序号：每个节点上失败的尝试都算
 * （重试之后成功的节点，失败的那几次也算）。节点失败了、却没有失败的尝试（还没开始执行就失败）时，是它最后一次尝试，
 * 没有尝试时 `attempt` 为 undefined。
 */
function failedTasksOf(read: RunReadFull): FailedTask[] {
	return read.chains.flatMap((chain) =>
		chain.nodes.flatMap((node): FailedTask[] => {
			const failed = node.attempts.filter((attempt) => attempt.status === "failed");
			if (failed.length > 0) return failed.map((attempt) => ({ chain, node, attempt }));
			return node.status === "failed" ? [{ chain, node, attempt: node.attempts.at(-1) }] : [];
		}),
	);
}

/** 失败的任务的日志尾部：任务 ID → 日志。日志文件概况一次查询，每个任务读一次文件的尾部。 */
async function taskLogTails(
	deps: RunReportDeps,
	read: RunReadFull,
	listed: readonly FailedTask[],
): Promise<Map<string, NonNullable<RunReportFailedTask["logs"]>>> {
	const tails = new Map<string, NonNullable<RunReportFailedTask["logs"]>>();
	const attempts = listed.flatMap(({ attempt }) => (attempt ? [attempt] : []));
	if (attempts.length === 0) return tails;
	// 清理之后文件已经不在；判断用读取时的运行行，不再另查。
	if (read.run.purgedAt !== null) {
		for (const { taskId } of attempts)
			tails.set(taskId, { lines: [], earlier: false, expired: true, missing: false });
		return tails;
	}
	const infos = await deps.logs.describeRun(read.run.id);
	// 读日志时的打码（log-mask.ts）：每个读日志的出口都按这次运行此刻的 secret 值打码，这里和其他读日志的地方是同一个口径。
	const mask = await deps.logs.logMask(read.run.id);
	for (const { taskId } of attempts) {
		const info = infos.get(taskId);
		const page = info
			? await readLogPage(info.file, {
					direction: "backward",
					limit: RUN_REPORT_LIMITS.logLines,
					filter: {},
					until: info.bytes,
					mask,
				})
			: undefined;
		// 读出来的行已经按此刻的 secret 值打过码，不再另打一遍。
		const lines = (page?.lines ?? []).map(({ seq, time, agent_time, source, level, text }) => ({
			seq,
			time,
			agent_time,
			source,
			level,
			text,
		}));
		tails.set(taskId, {
			lines,
			earlier: page !== undefined && page.start > 0,
			expired: false,
			// 库里记着写过行，文件里却读不出行：文件不在了、被移走了，不是这个任务没有日志。
			missing: info !== undefined && info.seq > 0 && lines.length === 0,
		});
	}
	return tails;
}

function failedTaskView(
	read: RunReadFull,
	{ chain, node, attempt }: FailedTask,
	tails: ReadonlyMap<string, NonNullable<RunReportFailedTask["logs"]>>,
): RunReportFailedTask {
	const document = read.version.document.nodes.find((n) => n.id === node.node_id);
	const error = attempt?.error ?? null;
	return {
		chain_instance_id: chain.id,
		chain: chain.subflow_name ?? null,
		node_id: node.node_id,
		display_name: node.display_name ?? null,
		kind: node.kind,
		node_type: document?.kind === "package" ? `${document.package}/${document.node}` : null,
		attempt: attempt?.attempt ?? null,
		attempts: node.attempts.length,
		task_id: attempt?.taskId ?? null,
		error: error
			? {
					kind: error.kind,
					headline: errorHeadline(error.message),
					detail: error.message,
					location: error.location,
				}
			: null,
		logs: (attempt && tails.get(attempt.taskId)) || null,
	};
}

/**
 * 失败的动作：取每个任务动作摘要里最近失败的那几个（任务的动作摘要最多留 5 个），全运行一次查询，
 * 最近结束的在前，最多 `RUN_REPORT_LIMITS.failedActions` 个。名称、字段、原因按这次运行此刻的 secret 参数的值再打一遍码
 * （和任务进度、正在做的动作同一个口径）。
 */
async function failedActionsOf(db: Db | Tx, read: RunReadFull): Promise<RunReportFailedAction[]> {
	const places = new Map<string, { chain: ReadChain; node: ReadNode; attempt: number }>();
	for (const chain of read.chains) {
		for (const node of chain.nodes) {
			for (const { taskId, attempt } of node.attempts) places.set(taskId, { chain, node, attempt });
		}
	}
	const rows = await db
		.select({
			taskId: taskActionSummaries.taskId,
			failed: sql<EndedActionView[] | null>`${taskActionSummaries.summary} -> 'recent_failed'`,
		})
		.from(taskActionSummaries)
		.innerJoin(tasks, eq(tasks.id, taskActionSummaries.taskId))
		.where(eq(tasks.runId, read.run.id));
	const found = rows.flatMap(({ taskId, failed }) => {
		const place = places.get(taskId);
		return place ? (failed ?? []).map((action) => ({ taskId, place, action })) : [];
	});
	const endedAt = ({ action }: { action: EndedActionView }) => Date.parse(action.ended_at);
	// 稳定排序：同一时刻结束的保持任务在运行里的先后。
	found.sort((a, b) => endedAt(b) - endedAt(a));
	return found.slice(0, RUN_REPORT_LIMITS.failedActions).map(({ taskId, place, action }) => ({
		// 名称、字段、失败原因和动作的读取接口是同一个口径（action-text.ts 的 `maskedAction`）。
		...maskedAction(action, read.secrets),
		chain_instance_id: place.chain.id,
		node_id: place.node.node_id,
		display_name: place.node.display_name ?? null,
		attempt: place.attempt,
		task_id: taskId,
	}));
}

/**
 * 有异常的关注项：只在场景设了关注项时取（没设时读数按执行中节点的主指标取，那不是作者关注的项），只要最新值。
 */
async function attentionItemsOf(
	deps: RunReportDeps,
	read: RunReadFull,
): Promise<RunReportAttentionItem[]> {
	if (read.scenario.focusItems.length === 0) return [];
	const focus = await resolveRunFocus(deps, read, { points: 0 });
	return focus.items.flatMap(
		({ anomaly, position, node_id, display_name, chart, title, unit, source, latest }) =>
			anomaly
				? [
						{
							position,
							node_id,
							display_name,
							chart,
							title,
							unit,
							source,
							latest,
							// 说明取自读取结果（日志类异常的 `logIssues`、失败和重试的错误信息），读取运行时已经按此刻的 secret 值
							// 打过码（`readRuns`），和关注项接口是同一份，这里不再另打一遍。
							anomaly,
						},
					]
				: [],
	);
}
