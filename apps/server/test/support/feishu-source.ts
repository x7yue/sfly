// 往真实发送队列里放消息的来源，给飞书投递的测试用（ADR 0020）：不需要 Agent，一次调用一条消息。
// 入队走生产代码里 `ctx.notify` 用的那条路：`textMessage` / `rawMessage` 组装请求体，`enqueueFeishuMessage` 在事务里写进发送队列，
// 来源是 "notify"。控制面测试实例的发送队列周期扫描已调快（support/test-control-plane.ts 的 feishuSweepIntervalMs），
// 入队之后不用唤醒投递循环。
//
// 消息的投递结果（已送达、投递失败、已丢弃）按任务写进任务日志，所以每条消息都挂在一个运行的任务上：
// {@link FeishuSource.run} 触发一次只含入口节点的运行，把入口节点的任务作为消息的任务。
// 同一次运行里的消息共用一份任务日志；要各自的日志就各开一次运行。
import { type Database, openDatabase } from "../../src/db/database.js";
import { enqueueFeishuMessage } from "../../src/feishu/feishu-queue.js";
import { rawMessage, textMessage } from "../../src/feishu/messages.js";
import type { ApiClient } from "./api-client.js";
import type { TestControlPlane } from "./test-control-plane.js";

export interface MessageOptions {
	/** 发给哪个飞书机器人（名称），默认 ops。 */
	bot?: string;
}

export interface TextOptions extends MessageOptions {
	/** 在正文末尾追加「@所有人」。 */
	atAll?: boolean;
}

/** 一次运行：消息挂在它的入口节点的任务上。 */
export interface FeishuSourceRun {
	readonly runId: string;
	/** 入口节点的任务：投递结果写进这个任务的日志（`GET /tasks/:id/logs`）。 */
	readonly taskId: string;
	/** 一条文本消息。 */
	text(text: string, options?: TextOptions): Promise<void>;
	/** 几条文本消息，在同一个事务里按顺序入队（突发）。 */
	texts(texts: readonly string[], options?: TextOptions): Promise<void>;
	/** 一条原始消息：完整的飞书请求体，不合格时抛错（不合格的规则由 `rawMessage` 的测试和 `ctx.notify` 的测试覆盖）。 */
	raw(message: unknown, options?: MessageOptions): Promise<void>;
}

export interface FeishuSource {
	/** 触发一次只含入口节点的运行，返回它。 */
	run(): Promise<FeishuSourceRun>;
	/** 关闭自己的数据库连接；要在 `cp.close()`（删库）之前调用。 */
	close(): Promise<void>;
}

const ENTRY_ONLY = {
	nodes: [{ id: "entry", kind: "entry", params: [] }],
	edges: [],
	packages: {},
};

/** 开一个往这个控制面的发送队列放消息的来源（自己开一个数据库连接，和控制面互不影响）。 */
export async function startFeishuSource(
	cp: TestControlPlane,
	api: ApiClient,
): Promise<FeishuSource> {
	const database: Database = openDatabase(cp.database.url, () => {});
	let orchestrationId: string | undefined;

	const enqueue = (
		bot: string,
		run: { runId: string; taskId: string },
		bodies: readonly Record<string, unknown>[],
	) =>
		database.db.transaction(async (tx) => {
			for (const body of bodies) {
				await enqueueFeishuMessage(tx, {
					botName: bot,
					source: "notify",
					runId: run.runId,
					taskId: run.taskId,
					body,
					now: cp.clock.now(),
				});
			}
		});

	return {
		async run() {
			orchestrationId ??= await api.orchestrationWith(ENTRY_ONLY, "飞书消息来源");
			const runId = await api.triggerOk(orchestrationId);
			const taskId = (await api.node(runId, "entry")).attempts[0]?.task_id;
			if (taskId === undefined) throw new Error(`运行 ${runId} 的入口节点没有任务`);
			const run = { runId, taskId };
			const texts = (list: readonly string[], { bot = "ops", atAll = false }: TextOptions = {}) =>
				enqueue(
					bot,
					run,
					list.map((text) => textMessage(text, atAll)),
				);
			return {
				...run,
				text: (text, options) => texts([text], options),
				texts,
				async raw(message, { bot = "ops" } = {}) {
					const checked = rawMessage(message);
					if ("problem" in checked) throw new Error(`原始消息不合格：${checked.problem}`);
					await enqueue(bot, run, [checked.body]);
				},
			};
		},
		close: () => database.close(),
	};
}
