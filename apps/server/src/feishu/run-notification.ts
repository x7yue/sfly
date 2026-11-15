/**
 * 运行通知（GLOSSARY「运行通知」，ADR 0020、docs/SEMANTICS.md §6）：运行结束时，在写入运行最终状态的同一个事务里，
 * 读取场景当前的设置，满足触发条件就把卡片写进发送队列。卡片的结构由平台固定。
 */
import {
	chainLabel,
	FEISHU_BODY_LIMIT_LABEL,
	MAIN_CHAIN_LABEL,
	nameWithId,
	nodeNameBeforeId,
} from "@sfly/orchestration";
import {
	focusChartMissing,
	focusLatestSeriesName,
	focusValueText,
	type OrchestrationDocument,
	type RunFocusItem,
	type RunNotificationTrigger,
} from "@sfly/schema";
import { asc, eq } from "drizzle-orm";
import { chainInstances, orchestrations, type RunStatus, runs, tasks } from "../db/schema.js";
import { finalFailures } from "../engine/failures.js";
import type { RunRow, Step } from "../engine/step.js";
import { type RunFocusDeps, resolveRunFocus } from "../focus/run-focus.js";
import { runListPreset } from "../presets/run-preset.js";
import { registeredBots } from "./bot-checks.js";
import { enqueueFeishuMessage } from "./feishu-queue.js";
import { type CardColor, type CardElement, fitCard, interactiveCard } from "./messages.js";

/** 运行结束时的状态。 */
type FinishedStatus = Exclude<RunStatus, "running">;

/** 触发条件 → 哪些运行结果要发。 */
const SENDS_ON: Record<RunNotificationTrigger, readonly FinishedStatus[]> = {
	failed: ["failed"],
	failed_or_cancelled: ["failed", "cancelled"],
	always: ["success", "failed", "cancelled"],
};

/** 运行结果 → 卡片标题的颜色和副标题。 */
const RESULT: Record<FinishedStatus, { color: CardColor; subtitle: string }> = {
	success: { color: "green", subtitle: "运行成功" },
	failed: { color: "red", subtitle: "运行失败" },
	cancelled: { color: "grey", subtitle: "运行已取消" },
};

/** 卡片里最多列出的失败节点数，其余只写总数。 */
const MAX_LISTED_FAILURES = 10;

/** 关注项那一行里，来源节点失败的标注：值是失败前的最后一个值，不能当成结果。 */
const NODE_FAILED_NOTE = "（节点失败）";

/**
 * 失败的节点和它所在的链（链的名称与监控页一致：「主链」或「子流程 <名称> · <实例短 ID>」）。
 * `node` 已经按「显示名称（节点 ID）」写好（没有显示名称时只有节点 ID）。
 */
interface FailedNode {
	chain: string;
	node: string;
}

interface RunNotificationFacts {
	/** 卡片标题：设置里的标题，空时已换成场景名。 */
	title: string;
	status: FinishedStatus;
	/** 附加说明（Markdown），可以为空。 */
	note: string;
	scenarioName: string;
	/** 触发时选用的运行预设的名称（预设之后改名也不变）；没有用预设时为 undefined。 */
	presetName: string | undefined;
	runId: string;
	triggeredBy: string;
	startedAt: Date;
	endedAt: Date;
	/** 按失败的先后。 */
	failures: readonly FailedNode[];
	/** 运行结束那一刻场景的关注项在这次运行里的值，按作者的顺序；没有时不写这一段。 */
	focus: readonly RunFocusItem[];
	/** 「查看运行」的链接；没有配置 SFLY_PUBLIC_URL 时没有按钮。 */
	runUrl: string | undefined;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 控制面所在时区的时间，带上时区：`2026-01-01 08:00:00 (UTC+8)`。 */
function formatTime(time: Date): string {
	const date = `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
	const clock = `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
	const offset = -time.getTimezoneOffset();
	const minutes = Math.abs(offset) % 60;
	const zone =
		offset === 0
			? "UTC"
			: `UTC${offset < 0 ? "-" : "+"}${Math.floor(Math.abs(offset) / 60)}${minutes === 0 ? "" : `:${pad(minutes)}`}`;
	return `${date} ${clock} (${zone})`;
}

/** 耗时：`不到 1 秒`、`12 秒`、`2 分 05 秒`、`1 小时 02 分`、`2 天 03 小时`。 */
function formatElapsed(ms: number): string {
	const seconds = Math.floor(Math.max(0, ms) / 1000);
	if (seconds < 1) return "不到 1 秒";
	if (seconds < 60) return `${seconds} 秒`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} 分 ${pad(seconds % 60)} 秒`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 小时 ${pad(minutes % 60)} 分`;
	return `${Math.floor(hours / 24)} 天 ${pad(hours % 24)} 小时`;
}

/**
 * 关注项一行：`- 名称：值 单位`。最新值来自哪个序列不言自明时不写序列名，否则写在名称后面（`- 名称（序列名）：值 单位`）；
 * 没有值写「—」；来源节点失败的末尾加 {@link NODE_FAILED_NOTE}；这次运行的节点包版本里没有这张图表的，写 {@link focusChartMissing}。
 * 值、序列名和「图表不存在」的句子与运行监控的读数共用同一份（@sfly/schema 的 `focus-reading.ts`）。
 */
function focusLine(item: RunFocusItem): string {
	if (item.unavailable) return `- ${item.title}：${focusChartMissing(item.chart)}`;
	const series = focusLatestSeriesName(item);
	const unit = item.latest === null || item.unit === "" ? "" : ` ${item.unit}`;
	const failed = item.source.status === "failed" ? NODE_FAILED_NOTE : "";
	return `- ${item.title}${series === "" ? "" : `（${series}）`}：${focusValueText(item)}${unit}${failed}`;
}

/**
 * 运行通知的卡片：header 是标题，颜色和副标题表示结果；body 依次是附加说明（有的话）、场景名、预设（用了运行预设时）、
 * 运行编号、触发人、开始时间和耗时、失败的链和节点（最多 {@link MAX_LISTED_FAILURES} 个）、
 * 关注项（有的话，每项一行，场景的关注项最多 8 项，所以最多 8 行）；最后是「查看运行」按钮（有链接时）。
 * 请求体超过 20 KB 时截断附加说明（{@link fitCard}），失败的节点和关注项都不动；截了还放不下返回 `too_large`。
 */
function runNotificationCard(facts: RunNotificationFacts) {
	const result = RESULT[facts.status];
	const lines = [
		`**场景**：${facts.scenarioName}`,
		...(facts.presetName === undefined ? [] : [`**预设**：${facts.presetName}`]),
		`**运行编号**：${facts.runId.slice(0, 8)}`,
		`**触发人**：${facts.triggeredBy}`,
		`**开始时间**：${formatTime(facts.startedAt)}`,
		`**耗时**：${formatElapsed(facts.endedAt.getTime() - facts.startedAt.getTime())}`,
	];
	const listed = facts.failures.slice(0, MAX_LISTED_FAILURES);
	const failures: CardElement[] =
		listed.length === 0
			? []
			: [
					{
						tag: "markdown",
						content: [
							facts.failures.length > listed.length
								? `**失败的节点**（共 ${facts.failures.length} 个，只列出前 ${listed.length} 个）`
								: "**失败的节点**",
							...listed.map((f) => `- ${f.chain}：${f.node}`),
						].join("\n"),
					},
				];
	const focus: CardElement[] =
		facts.focus.length === 0
			? []
			: [{ tag: "markdown", content: ["**关注项**", ...facts.focus.map(focusLine)].join("\n") }];
	const link = facts.runUrl;
	const button: CardElement[] =
		link === undefined
			? []
			: [
					{
						tag: "button",
						text: { tag: "plain_text", content: "查看运行" },
						type: "primary",
						behaviors: [{ type: "open_url", default_url: link }],
					},
				];
	return fitCard(facts.note, (note) =>
		interactiveCard({ title: facts.title, subtitle: result.subtitle, color: result.color }, [
			...(note === "" ? [] : [{ tag: "markdown" as const, content: note }]),
			{ tag: "markdown", content: lines.join("\n") },
			...failures,
			...focus,
			...button,
		]),
	);
}

/** 运行里最终失败的节点，按失败的先后（同一时刻的按链、再按节点在文档里的顺序）。 */
async function failedNodes(
	step: Step,
	run: RunRow,
	document: OrchestrationDocument,
): Promise<FailedNode[]> {
	const chains = await step.tx
		.select()
		.from(chainInstances)
		.where(eq(chainInstances.runId, run.id))
		.orderBy(asc(chainInstances.depth), asc(chainInstances.startedAt), asc(chainInstances.id));
	const rows = await step.tx
		.select({
			chainInstanceId: tasks.chainInstanceId,
			nodeId: tasks.nodeId,
			attempt: tasks.attempt,
			status: tasks.status,
			endedAt: tasks.endedAt,
		})
		.from(tasks)
		.where(eq(tasks.runId, run.id));
	const chainIndex = new Map(chains.map((c, i) => [c.id, i]));
	const nodeIndex = new Map(document.nodes.map((n, i) => [n.id, i]));
	const declared = new Map(document.nodes.map((n) => [n.id, n]));
	const labelOf = (chainInstanceId: string) => {
		const chain = chains.find((c) => c.id === chainInstanceId);
		if (!chain) return MAIN_CHAIN_LABEL;
		const start = document.nodes.find((n) => n.id === chain.chainId);
		const name = start?.kind === "subflow_entry" ? start.name : undefined;
		return chainLabel({ chain_id: chain.chainId, subflow: chain.depth > 0, name }, chain.id);
	};
	return finalFailures(rows)
		.sort(
			(a, b) =>
				(a.endedAt?.getTime() ?? 0) - (b.endedAt?.getTime() ?? 0) ||
				(chainIndex.get(a.chainInstanceId) ?? 0) - (chainIndex.get(b.chainInstanceId) ?? 0) ||
				(nodeIndex.get(a.nodeId) ?? 0) - (nodeIndex.get(b.nodeId) ?? 0),
		)
		.map((row) => {
			const node = declared.get(row.nodeId);
			return {
				chain: labelOf(row.chainInstanceId),
				node: node ? nameWithId(row.nodeId, nodeNameBeforeId(node)) : row.nodeId,
			};
		});
}

/**
 * 读关注项的值要用的依赖：{@link resolveRunFocus} 的依赖（数据库用运行结束的事务），以及读不出来时怎么报告。
 */
export interface FinalFocusDeps extends Omit<RunFocusDeps, "db"> {
	/** 读关注项出错：只报告，卡片照常发，没有「关注项」一段。 */
	onError(error: unknown): void;
}

/**
 * 运行结束那一刻场景的关注项在这次运行里的值：和 `GET /runs/:id/focus?points=0` 同一份解析（{@link resolveRunFocus}），
 * 在写入运行最终状态的事务里读，看到的是这个事务里刚写下的节点状态。场景没有设关注项、或者这些项都不在这次运行的版本里时没有项。
 * 通知不能拦住运行结束（ADR 0020）：读取放在保存点里，出错时回到保存点、报告错误、按没有关注项处理，运行的最终状态照常提交。
 */
async function finalFocus(
	step: Step,
	run: RunRow,
	scenario: Pick<typeof orchestrations.$inferSelect, "focusItems">,
	deps: FinalFocusDeps,
): Promise<RunFocusItem[]> {
	// 没设关注项时解析出来的是执行中节点的主指标，运行已经结束，卡片上没有这一段。
	if (scenario.focusItems.length === 0) return [];
	try {
		return await step.tx.transaction(async (savepoint) => {
			const focus = await resolveRunFocus(
				{ db: savepoint, clock: deps.clock, queries: deps.queries },
				run.id,
				{ points: 0 },
			);
			return focus?.mode === "focus" ? focus.items : [];
		});
	} catch (error) {
		deps.onError(error);
		return [];
	}
}

/**
 * 运行刚结束（在写入最终状态的事务里调用）：读场景当前的运行通知设置，选了机器人而且满足触发条件的，
 * 把卡片写进发送队列并在运行上记下发给哪个机器人（提交后由调用方唤醒投递）。
 * 机器人已经不存在（或卡片超过 20 KB）时不入队，在运行上记下「未发送」的原因：通知不会拦住运行。
 */
export async function enqueueRunNotification(
	step: Step,
	input: {
		run: RunRow;
		status: FinishedStatus;
		document: OrchestrationDocument;
		runUrl: string | undefined;
		focus: FinalFocusDeps;
	},
): Promise<void> {
	const { run, status, document } = input;
	const [scenario] = await step.tx
		.select()
		.from(orchestrations)
		.where(eq(orchestrations.id, run.orchestrationId));
	const bot = scenario?.runNotifyBot;
	if (!scenario || bot == null || !SENDS_ON[scenario.runNotifyTrigger].includes(status)) return;

	const record = (notSent: string | null) =>
		step.tx
			.update(runs)
			.set({ notificationBot: bot, notificationNotSent: notSent })
			.where(eq(runs.id, run.id));
	if (!(await registeredBots(step.tx, [bot])).has(bot)) {
		// 「未发送：机器人已删除」是规格定下的说法（运行抽屉写成「「<机器人>」机器人已删除」），不用任务日志里的整句。
		await record("机器人已删除");
		return;
	}
	const card = runNotificationCard({
		title: scenario.runNotifyTitle || scenario.name,
		status,
		note: scenario.runNotifyNote,
		scenarioName: scenario.name,
		presetName: runListPreset(run)?.name,
		runId: run.id,
		triggeredBy: run.triggeredBy,
		startedAt: run.startedAt,
		endedAt: step.now,
		failures: await failedNodes(step, run, document),
		focus: await finalFocus(step, run, scenario, input.focus),
		runUrl: input.runUrl,
	});
	if ("error" in card) {
		await record(`卡片超过飞书 ${FEISHU_BODY_LIMIT_LABEL} 的上限`);
		return;
	}
	await enqueueFeishuMessage(step.tx, {
		botName: bot,
		source: "run_notification",
		runId: run.id,
		body: card.body,
		now: step.now,
	});
	await record(null);
	step.notifications.queued = true;
}
