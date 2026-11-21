/**
 * 运行通知（GLOSSARY「运行通知」，ADR 0020、docs/SEMANTICS.md §6）：兜底——运行失败或被取消时，在写入运行最终状态的同一个事务里，
 * 读取场景当前的设置，满足触发条件就把卡片写进发送队列。卡片只回答「这次运行出事了，是哪个节点、为什么」：
 * 场景、运行、状态、第一个失败的节点和失败原因、出错位置、触发人、打开运行的链接。日常的结果（关注项的值、耗时、各节点的输出）
 * 由场景自己的节点用 `ctx.notify` 发，平台不替用户决定「运行结束该看什么」。
 */
import { chainLabel, FEISHU_BODY_LIMIT_LABEL, nameWithId } from "@sfly/orchestration";
import { ERROR_LOCATION_LABEL, errorHeadline, type RunNotificationTrigger } from "@sfly/schema";
import { eq } from "drizzle-orm";
import { orchestrations, type RunStatus, runs } from "../db/schema.js";
import type { RunRow, Step } from "../engine/step.js";
import { readNodeError, readRuns } from "../runs/run-read.js";
import { registeredBots } from "./bot-checks.js";
import { enqueueFeishuMessage } from "./feishu-queue.js";
import { type CardColor, type CardElement, fitCard, interactiveCard } from "./messages.js";

/** 运行结束时的状态。 */
type FinishedStatus = Exclude<RunStatus, "running">;

/** 触发条件 → 哪些运行结果要发。成功的运行从不发运行通知。 */
const SENDS_ON: Record<RunNotificationTrigger, readonly FinishedStatus[]> = {
	failed: ["failed"],
	failed_or_cancelled: ["failed", "cancelled"],
};

/** 运行结果 → 卡片标题的颜色和副标题（副标题写明状态）。成功的运行不发，所以没有成功。 */
const RESULT: Record<"failed" | "cancelled", { color: CardColor; subtitle: string }> = {
	failed: { color: "red", subtitle: "运行失败" },
	cancelled: { color: "grey", subtitle: "运行已取消" },
};

/** 失败原因那一行最长多少个字符（Unicode 字符数），超出的截断并加「…」：一行摘要也可能很长，不能让卡片超过飞书的上限。 */
const REASON_MAX = 300;

/**
 * 第一个失败的节点和它所在的链（链的名称与监控页一致：「主链」或「子流程 <名称> · <实例短 ID>」）。
 * `node` 已经按「显示名称（节点 ID）」写好（没有显示名称时只有节点 ID）。
 * `reason` 是失败原因的一行，用和运行监控页头同一个函数取（`errorHeadline`）；没有错误信息时是空串。
 * `location` 是出错位置（`error.location`），没有时为 null。
 */
interface FirstFailure {
	chain: string;
	node: string;
	reason: string;
	location: string | null;
}

interface RunNotificationFacts {
	/** 卡片标题：设置里的标题，空时已换成场景名。 */
	title: string;
	status: "failed" | "cancelled";
	/** 附加说明（Markdown），可以为空。 */
	note: string;
	scenarioName: string;
	runId: string;
	triggeredBy: string;
	/** 第一个失败的节点；没有失败的节点时（例如被取消的运行）为 undefined。 */
	failure: FirstFailure | undefined;
	/** 「查看运行」的链接；没有配置 SFLY_PUBLIC_URL 时没有按钮。 */
	runUrl: string | undefined;
}

/** 截到 {@link REASON_MAX} 个字符（按 Unicode 字符数，不把一个字符截成两半）。 */
function clipReason(text: string): string {
	const chars = [...text];
	return chars.length <= REASON_MAX ? text : `${chars.slice(0, REASON_MAX).join("")}…`;
}

/**
 * 运行通知的卡片：header 是标题，颜色和副标题表示结果；body 依次是附加说明（有的话）、场景名、运行编号、触发人，
 * 第一个失败的节点（所在的链和节点）、失败原因、出错位置（有失败的节点时；出错位置没有时不写）；最后是「查看运行」按钮（有链接时）。
 * 请求体超过 20 KB 时截断附加说明（{@link fitCard}），其余都不动；截了还放不下返回 `too_large`。
 */
function runNotificationCard(facts: RunNotificationFacts) {
	const result = RESULT[facts.status];
	const lines = [
		`**场景**：${facts.scenarioName}`,
		`**运行编号**：${facts.runId.slice(0, 8)}`,
		`**触发人**：${facts.triggeredBy}`,
	];
	const failure: CardElement[] = facts.failure
		? [
				{
					tag: "markdown",
					content: [
						`**失败的节点**：${facts.failure.chain}：${facts.failure.node}`,
						...(facts.failure.reason === ""
							? []
							: [`**失败原因**：${clipReason(facts.failure.reason)}`]),
						...(facts.failure.location === null
							? []
							: [`**${ERROR_LOCATION_LABEL}**：${facts.failure.location}`]),
					].join("\n"),
				},
			]
		: [];
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
			...failure,
			...button,
		]),
	);
}

/**
 * 运行里第一个失败的节点（和控制台、运行监控、运行记录的「第一个失败的节点」相同：运行读取的 `failures` 的第一项），
 * 连同它的失败原因和出错位置。在写入运行最终状态的事务里读（`step.tx`）：运行读取用轻量的那一种，
 * 失败原因只读这个节点的任务行（{@link readNodeError}），不读整个运行的输入和输出。
 */
async function firstFailure(step: Step, run: RunRow): Promise<FirstFailure | undefined> {
	const read = (await readRuns(step.tx, [run.id])).get(run.id);
	const first = read?.failures[0];
	if (!read || !first) return undefined;
	const { chain, node } = first;
	const error = await readNodeError(step.tx, {
		runId: run.id,
		chainInstanceId: chain.id,
		nodeId: node.node_id,
		document: read.version.document,
	});
	return {
		chain: chainLabel(
			{ chain_id: chain.chain_id, subflow: chain.depth > 0, name: chain.subflow_name },
			chain.id,
		),
		node: nameWithId(node.node_id, node.display_name),
		reason: errorHeadline(error?.message),
		location: error?.location ?? null,
	};
}

/**
 * 运行刚结束（在写入最终状态的事务里调用）：读场景当前的运行通知设置，选了机器人而且满足触发条件的（失败，或者
 * 失败和取消），把卡片写进发送队列并在运行上记下发给哪个机器人（提交后由调用方唤醒投递）。成功的运行不发。
 * 机器人已经不存在（或卡片超过 20 KB）时不入队，在运行上记下「未发送」的原因：通知不会拦住运行。
 */
export async function enqueueRunNotification(
	step: Step,
	input: {
		run: RunRow;
		status: FinishedStatus;
		runUrl: string | undefined;
	},
): Promise<void> {
	const { run, status } = input;
	const [scenario] = await step.tx
		.select()
		.from(orchestrations)
		.where(eq(orchestrations.id, run.orchestrationId));
	const bot = scenario?.runNotifyBot;
	if (!scenario || bot == null || !SENDS_ON[scenario.runNotifyTrigger].includes(status)) return;
	// SENDS_ON 里没有成功：走到这里的只有失败和取消。
	if (status === "success") return;

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
		runId: run.id,
		triggeredBy: run.triggeredBy,
		failure: await firstFailure(step, run),
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
