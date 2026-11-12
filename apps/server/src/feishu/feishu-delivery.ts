import { and, asc, eq } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { type FeishuMessageStatus, feishuMessages } from "../db/schema.js";
import type { TaskLogs } from "../logs/task-logs.js";
import type { FeishuBots } from "./feishu-bots.js";
import type { FeishuClient } from "./feishu-client.js";

type MessageRow = typeof feishuMessages.$inferSelect;

/**
 * 投递（GLOSSARY「投递」，ADR 0020）：把发送队列里的消息发给飞书机器人的 Webhook 地址。
 *
 * - 每个机器人一个投递循环：按入队顺序（`seq`）一条一条发，上一条有了结果才发下一条；不同机器人互不影响，
 *   一个机器人不响应（单次请求最多 10 秒）不会挡住别的机器人。
 * - 这一步每条消息只发一次，送达与否都记在队列里；失败的消息不重试（重试、限速在 #230）。
 * - 投递的结果写成发起这条消息的任务的一条日志：送达是 info，失败或丢弃是 warning；
 *   从不修改节点、任务、链或运行的状态。运行通知的消息没有任务，不写日志。
 * - 状态都在 PostgreSQL 里：{@link wake} 在消息入队、周期扫描和控制面启动时调用，已经入队的消息总会被看到。
 *   控制面关闭时（{@link close}）被中断的请求不记结果，消息留在队列里，重启后接着投递。
 */
export class FeishuDelivery {
	#closed = false;
	/** 正在投递的机器人。 */
	readonly #draining = new Set<string>();
	/** 投递循环运行期间又有新消息入队的机器人：循环结束前要再看一遍。 */
	readonly #again = new Set<string>();
	readonly #running = new Set<Promise<void>>();

	constructor(
		private readonly deps: {
			db: Db;
			clock: Clock;
			bots: FeishuBots;
			client: FeishuClient;
			logs: Pick<TaskLogs, "appendSystem">;
			onError: (error: unknown) => void;
		},
	) {}

	/** 给每个有排队消息的机器人起一个投递循环（已经在投递的不重复起）；立即返回，不等投递。 */
	wake(): void {
		if (this.#closed) return;
		this.#track(this.#start());
	}

	/** 停止接受新的投递；正在进行的请求被中断后不记结果。先于 `FeishuClient.close()` 调用。 */
	close(): void {
		this.#closed = true;
	}

	/** 等正在进行的投递结束（关闭控制面时在中断请求之后调用）。 */
	async idle(): Promise<void> {
		while (this.#running.size > 0) await Promise.allSettled([...this.#running]);
	}

	#track(work: Promise<void>): void {
		const tracked: Promise<void> = work
			.catch(this.deps.onError)
			.finally(() => this.#running.delete(tracked));
		this.#running.add(tracked);
	}

	async #start(): Promise<void> {
		const queued = await this.deps.db
			.selectDistinct({ bot: feishuMessages.botName })
			.from(feishuMessages)
			.where(eq(feishuMessages.status, "queued"));
		for (const { bot } of queued) {
			if (this.#draining.has(bot)) this.#again.add(bot);
			else {
				this.#draining.add(bot);
				this.#track(this.#drain(bot).finally(() => this.#draining.delete(bot)));
			}
		}
	}

	async #drain(botName: string): Promise<void> {
		while (!this.#closed) {
			const [message] = await this.deps.db
				.select()
				.from(feishuMessages)
				.where(and(eq(feishuMessages.botName, botName), eq(feishuMessages.status, "queued")))
				.orderBy(asc(feishuMessages.seq))
				.limit(1);
			if (!message) {
				if (this.#again.delete(botName)) continue;
				return;
			}
			await this.#deliver(message);
		}
	}

	async #deliver(message: MessageRow): Promise<void> {
		const bot = await this.deps.bots.get(message.botName);
		if (!bot) {
			await this.#finish(
				message,
				"discarded",
				`飞书机器人「${message.botName}」已被删除，消息没有发送`,
			);
			return;
		}
		const result = await this.deps.client.send(bot.webhookUrl, message.body);
		if (this.#closed) return;
		if (result.ok) {
			await this.#finish(message, "delivered", `已送达飞书机器人「${message.botName}」`);
		} else {
			const { reason, nextStep, code } = result.failure;
			const codeNote = code === null || reason.includes(String(code)) ? "" : `（错误码 ${code}）`;
			await this.#finish(
				message,
				"failed",
				`飞书机器人「${message.botName}」投递失败：${reason}${codeNote}。下一步：${nextStep}`,
			);
		}
	}

	/** 记下结果（只改还在排队的消息），再写进发起它的任务的日志。 */
	async #finish(
		message: MessageRow,
		status: Exclude<FeishuMessageStatus, "queued">,
		text: string,
	): Promise<void> {
		const attempted = status === "discarded" ? 0 : 1;
		const [updated] = await this.deps.db
			.update(feishuMessages)
			.set({
				status,
				attempts: message.attempts + attempted,
				lastError: status === "delivered" ? null : text,
				finishedAt: this.deps.clock.now(),
			})
			.where(and(eq(feishuMessages.seq, message.seq), eq(feishuMessages.status, "queued")))
			.returning({ seq: feishuMessages.seq });
		if (!updated || message.taskId === null) return;
		await this.deps.logs.appendSystem(
			message.taskId,
			status === "delivered" ? "info" : "warn",
			text,
		);
	}
}
