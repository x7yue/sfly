import { and, asc, count, eq, inArray, type SQLWrapper } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { type FeishuMessageStatus, feishuBots, feishuMessages } from "../db/schema.js";
import type { TaskLogs } from "../logs/task-logs.js";
import {
	BACKLOG_LIMIT,
	isRetryDue,
	RETRY_DEADLINE_MS,
	retryDelayMs,
	SendRateLimiter,
} from "./delivery-policy.js";
import { type DiscardReason, discardNote, logDiscards } from "./discards.js";
import type { FeishuBots } from "./feishu-bots.js";
import type { FeishuClient } from "./feishu-client.js";
import type { FeishuFailure } from "./feishu-failure.js";

type MessageRow = typeof feishuMessages.$inferSelect;

/** 失败的中文说明：原因、飞书的错误码（原因里没有时补上）和下一步。 */
function describeFailure({ reason, nextStep, code }: FeishuFailure): string {
	const codeNote = code === null || reason.includes(String(code)) ? "" : `（错误码 ${code}）`;
	return `${reason}${codeNote}。下一步：${nextStep}`;
}

/**
 * 投递（GLOSSARY「投递」，ADR 0020）：把发送队列里的消息发给飞书机器人的 Webhook 地址。
 *
 * - 每个机器人一个投递循环：按入队顺序（`seq`）一条一条发，上一条有了结果才发下一条；不同机器人互不影响，
 *   一个机器人不响应（单次请求最多 10 秒）不会挡住别的机器人。
 * - 可重试的失败（网络错误、超时、HTTP 429、5xx、飞书的限流错误码 11232）退避重试：间隔从 1 秒起逐次翻倍，最长 60 秒，
 *   从入队算起 10 分钟还没送达就记为失败。等着重试的消息仍然是队首，后面的消息不会越过它。其他失败只发一次就记为失败。
 * - 每个机器人每秒最多发 5 个请求、每分钟最多 100 个（重试也算）。
 * - 单个机器人排队的消息超过 1000 条时，丢弃最旧的。
 * - 退避、期限和限速都按控制面时间（注入的时钟，ADR 0018）算，没有定时器：到点与否在每次唤醒时判断。
 *   排好的下一次尝试记在队列里（`next_attempt_at`），控制面重启之后继续按它算。
 * - 最终的结果（送达、失败、丢弃）写成发起这条消息的任务的一条日志：送达是 info，失败或丢弃是 warning；
 *   从不修改节点、任务、链或运行的状态。运行通知的消息没有任务，不写日志。
 * - 每发一次请求，结果记在机器人上（管理页的「最近一次投递」）。
 * - 状态都在 PostgreSQL 里：{@link wake} 在消息入队、周期扫描和控制面启动时调用，已经入队的消息总会被看到，
 *   等着退避或限速的消息也靠周期扫描接着投递。控制面关闭时（{@link close}）被中断的请求不记结果，
 *   消息留在队列里，重启后接着投递。
 */
export class FeishuDelivery {
	#closed = false;
	/** 正在投递的机器人。 */
	readonly #draining = new Set<string>();
	/** 投递循环运行期间又有新消息入队的机器人：循环结束前要再看一遍。 */
	readonly #again = new Set<string>();
	readonly #running = new Set<Promise<void>>();
	readonly #limiter = new SendRateLimiter();

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

	/** 一个机器人的投递循环：队首发不出去（在等退避或限速）时结束，下一次唤醒再看。 */
	async #drain(botName: string): Promise<void> {
		while (!this.#closed) {
			await this.#discardOverflow(botName);
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
			if (!(await this.#deliver(message))) return;
		}
	}

	/** 排队的消息超过上限时，丢弃最旧的。 */
	async #discardOverflow(botName: string): Promise<void> {
		const [row] = await this.deps.db
			.select({ queued: count() })
			.from(feishuMessages)
			.where(and(eq(feishuMessages.botName, botName), eq(feishuMessages.status, "queued")));
		const excess = (row?.queued ?? 0) - BACKLOG_LIMIT;
		if (excess <= 0) return;
		const oldest = this.deps.db
			.select({ seq: feishuMessages.seq })
			.from(feishuMessages)
			.where(and(eq(feishuMessages.botName, botName), eq(feishuMessages.status, "queued")))
			.orderBy(asc(feishuMessages.seq))
			.limit(excess);
		await this.#discard(botName, "backlog", inArray(feishuMessages.seq, oldest));
	}

	/** 把这个机器人还在排队的消息（`only` 限定范围）记为已丢弃，并写进发起它们的任务的日志。 */
	async #discard(botName: string, reason: DiscardReason, only?: SQLWrapper): Promise<void> {
		const discarded = await this.deps.db
			.update(feishuMessages)
			.set({
				status: "discarded",
				lastError: discardNote(reason, botName),
				nextAttemptAt: null,
				finishedAt: this.deps.clock.now(),
			})
			.where(and(eq(feishuMessages.botName, botName), eq(feishuMessages.status, "queued"), only))
			.returning({ taskId: feishuMessages.taskId });
		await logDiscards(this.deps.logs, discarded, reason, botName);
	}

	/** 投递队首的消息；返回 false 表示现在还不能发（在等退避或限速），投递循环先结束。 */
	async #deliver(message: MessageRow): Promise<boolean> {
		const bot = await this.deps.bots.get(message.botName);
		if (!bot) {
			await this.#discard(message.botName, "bot_removed");
			return true;
		}
		const now = this.deps.clock.now().getTime();
		if (!isRetryDue(message.nextAttemptAt, now)) return false;
		if (this.#limiter.acquire(bot.name, now) > 0) return false;

		const result = await this.deps.client.send(bot.webhookUrl, message.body);
		if (this.#closed) return true;
		const attempts = message.attempts + 1;
		const at = this.deps.clock.now();
		const name = `飞书机器人「${bot.name}」`;
		if (result.ok) {
			const retried = attempts > 1 ? `（第 ${attempts} 次尝试送达）` : "";
			await this.#finish(message, "delivered", attempts, at, `已送达${name}${retried}`, null);
			return true;
		}
		const detail = describeFailure(result.failure);
		const age = at.getTime() - message.enqueuedAt.getTime();
		if (!result.failure.retryable) {
			await this.#finish(message, "failed", attempts, at, `${name}投递失败：${detail}`, detail);
		} else if (age >= RETRY_DEADLINE_MS) {
			const gaveUp = `共尝试 ${attempts} 次，从入队起超过 ${RETRY_DEADLINE_MS / 60_000} 分钟仍没有送达；最后一次的原因：${detail}`;
			await this.#finish(message, "failed", attempts, at, `${name}投递失败：${gaveUp}`, detail);
		} else {
			// 下一次最迟在期限那一刻：期限到了也要再试最后一次，再失败才记为失败。
			const retryAt = Math.min(
				at.getTime() + retryDelayMs(attempts),
				message.enqueuedAt.getTime() + RETRY_DEADLINE_MS,
			);
			await this.#record(
				message,
				{ status: "queued", attempts, nextAttemptAt: new Date(retryAt), lastError: detail },
				{ at, ok: false, error: detail },
			);
		}
		return true;
	}

	/** 记下最终的结果，再写进发起这条消息的任务的日志。 */
	async #finish(
		message: MessageRow,
		status: Exclude<FeishuMessageStatus, "queued" | "discarded">,
		attempts: number,
		at: Date,
		text: string,
		error: string | null,
	): Promise<void> {
		const recorded = await this.#record(
			message,
			{ status, attempts, nextAttemptAt: null, lastError: status === "delivered" ? null : text },
			{ at, ok: status === "delivered", error },
		);
		if (!recorded || message.taskId === null) return;
		await this.deps.logs.appendSystem(
			message.taskId,
			status === "delivered" ? "info" : "warn",
			text,
		);
	}

	/**
	 * 记下这一次请求的结果：消息的状态和尝试次数、排好的下一次尝试，以及机器人上的「最近一次投递」，在同一个事务里。
	 * 只改还在排队的消息（机器人被删除时它们已经被丢弃）；消息已经不在排队时返回 false，什么也不记。
	 */
	async #record(
		message: MessageRow,
		change: {
			status: Exclude<FeishuMessageStatus, "discarded">;
			attempts: number;
			nextAttemptAt: Date | null;
			lastError: string | null;
		},
		request: { at: Date; ok: boolean; error: string | null },
	): Promise<boolean> {
		return this.deps.db.transaction(async (tx) => {
			const [updated] = await tx
				.update(feishuMessages)
				.set({ ...change, finishedAt: change.status === "queued" ? null : request.at })
				.where(and(eq(feishuMessages.seq, message.seq), eq(feishuMessages.status, "queued")))
				.returning({ seq: feishuMessages.seq });
			if (!updated) return false;
			await tx
				.update(feishuBots)
				.set({
					lastDeliveryAt: request.at,
					lastDeliveryOk: request.ok,
					lastDeliveryError: request.error,
				})
				.where(eq(feishuBots.name, message.botName));
			return true;
		});
	}
}
