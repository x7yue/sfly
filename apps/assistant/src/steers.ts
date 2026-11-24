import type { SteerEntry } from "@sfly/schema";

/**
 * 一轮里的插话（协议「插话」一节）：pi 的队列里只有文字、没有 `message_id`，所以助手服务自己按收到的顺序记着每句话的
 * `message_id`、原文和它到了哪一步：
 * - `held`：收下了，还没有交给 pi（pi 还没拿到这一轮的 `prompt`）；
 * - `sent`：交给了 pi（写了 `steer`），还没送到；
 * - `delivered`：送到了：交给 pi 之后 pi 出现了一条用户消息（`message_end`，role=user），**按交出的顺序对，不比较文字**
 *   （pi 会展开 skill 命令和提示模板）；这一轮自己的 `prompt` 那一条不算（由调用方跳过）；
 * - `cleared`：停止时 `clear_queue` 从 pi 的队列里取走了它（确定没送到；这一轮结束时发它的 `steer_dropped`）。`clear_queue` 回了 k 条，
 *   就是交出去、还没送到的**前 k 句**：pi 的队列先进先出，在队列里的一定比还没被 pi 收下的早（#677 审查，负责人定）；
 * - `dropped`：没有送到，已经发了它的 `steer_dropped`（`steer` 的回应说被扩展处理了、或者没说进了队列；这一轮结束时还没送到）。
 *
 * 一句话从 `steer_queue` 里消失，要么送到了，要么先有了它的 `steer_dropped`（协议的通用规则）：{@link pending} 只列
 * `held` 和 `sent`，`dropped` 由调用方先发 `steer_dropped` 再发新的 `steer_queue`。
 */
export type SteerState = "held" | "sent" | "cleared" | "delivered" | "dropped";

export interface Steer {
	messageId: string;
	text: string;
	state: SteerState;
}

export class SteerBook {
	readonly #steers: Steer[] = [];

	/** 收下一句；同一个 `message_id` 再来只算一次（返回 false）。 */
	accept(messageId: string, text: string): boolean {
		if (this.#steers.some((s) => s.messageId === messageId)) return false;
		this.#steers.push({ messageId, text, state: "held" });
		return true;
	}

	/** 还没交给 pi 的几句，按收到的顺序；调用方把它们写给 pi（标成 `sent`）。 */
	takeHeld(): Steer[] {
		const held = this.#steers.filter((s) => s.state === "held");
		for (const steer of held) steer.state = "sent";
		return held;
	}

	/**
	 * pi 出现了一条用户消息（不是这一轮自己的 `prompt`）：交出去还没送到的第一句算送到，返回它；没有这样的一句时
	 * undefined（不该发生，调用方记日志）。
	 */
	deliverNext(): Steer | undefined {
		const next = this.#steers.find((s) => s.state === "sent");
		if (next) next.state = "delivered";
		return next;
	}

	/**
	 * 停止时 `clear_queue` 取回了 `count` 句：交出去、还没送到的前 `count` 句标成 `cleared`（之后的用户消息从下一句开始对），
	 * 返回标了几句（比 `count` 少说明记录和 pi 的队列对不上，调用方记日志）。
	 */
	clearFirst(count: number): number {
		const sent = this.#steers.filter((s) => s.state === "sent").slice(0, count);
		for (const steer of sent) steer.state = "cleared";
		return sent.length;
	}

	/** 这一句没有送到（`handled`、回应失败）：标成 `dropped`；已经送到或者已经标过的不动，返回 false。 */
	drop(messageId: string): Steer | undefined {
		const steer = this.#steers.find((s) => s.messageId === messageId);
		if (!steer || (steer.state !== "held" && steer.state !== "sent")) return undefined;
		steer.state = "dropped";
		return steer;
	}

	/** 这一轮结束时还没送到的几句（含被 `clear_queue` 取走的），按收到的顺序，标成 `dropped`（调用方各发一条 `steer_dropped`）。 */
	dropRest(): Steer[] {
		const rest = this.#steers.filter(
			(s) => s.state === "held" || s.state === "sent" || s.state === "cleared",
		);
		const states = rest.map((s) => s.state);
		for (const steer of rest) steer.state = "dropped";
		return rest.map((s, i) => ({ ...s, state: states[i] as SteerState }));
	}

	/** 交给了 pi、还没送到的条数（和 `clear_queue` 取回的条数核对）。 */
	get inPi(): number {
		return this.#steers.filter((s) => s.state === "sent").length;
	}

	/** `steer_queue` 的内容：还没送到、也没有 `steer_dropped` 的，按收到的顺序。 */
	pending(): SteerEntry[] {
		return this.#steers
			.filter((s) => s.state === "held" || s.state === "sent")
			.map((s) => ({ message_id: s.messageId, text: s.text }));
	}
}

/** `steer_dropped` 的 `message` 里引用原文：太长的截断。 */
export const QUOTE_LIMIT = 80;

export function quote(text: string): string {
	const chars = [...text.replace(/\s+/g, " ").trim()];
	return chars.length <= QUOTE_LIMIT ? chars.join("") : `${chars.slice(0, QUOTE_LIMIT).join("")}…`;
}
