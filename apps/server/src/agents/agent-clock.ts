import type { ClockOffsetView } from "@sfly/schema";
import type { Clock } from "../clock.js";

/**
 * Agent 的时钟（ADR 0018）：时钟偏差的计算与阈值，以及每个连接的「单调时钟读数 → 控制面时间」折算。
 * 控制面里凡是要把 Agent 上发生的时刻换成控制面时间、或判断时钟偏差大小的地方，都用这里的入口。
 */

/** 时钟偏差的绝对值达到这个值才提示；不到时视为一致。阈值只在这里定义。 */
export const CLOCK_OFFSET_THRESHOLD_MS = 2000;

/** Agent 在一条消息里上报的时钟读数（Hello、Heartbeat、TaskStarted、TaskResult）。 */
export interface AgentClockReading {
	/** Agent 时间（Unix 毫秒）：原样记录，不做范围检查。 */
	agentTimeMs: number;
	/** 单调时钟读数（毫秒）。 */
	monotonicMs: number;
}

/**
 * 取出消息里的时钟读数。旧版本 Agent 不带这两个字段（monotonic_ms 为 0）时返回 undefined：
 * 不建立对应关系、不更新时钟偏差。
 */
export function agentClockReading(message: {
	agentTimeUnixMs: bigint;
	monotonicMs: bigint;
}): AgentClockReading | undefined {
	if (message.monotonicMs === 0n) return undefined;
	return {
		agentTimeMs: Number(message.agentTimeUnixMs),
		monotonicMs: Number(message.monotonicMs),
	};
}

/** 时钟偏差（毫秒）= Agent 时间 − 收到消息时的控制面时间；正数表示 Agent 比控制面快。 */
export function clockOffsetMs(agentTimeMs: number, receivedAt: Date): number {
	return agentTimeMs - receivedAt.getTime();
}

/** 时钟偏差是否达到阈值（快和慢都算）。 */
export function clockOffsetExceedsThreshold(offsetMs: number): boolean {
	return Math.abs(offsetMs) >= CLOCK_OFFSET_THRESHOLD_MS;
}

/** 一次测得的时钟偏差：偏差值和测量时刻（控制面时间）。 */
export interface ClockOffset {
	offsetMs: number;
	measuredAt: Date;
}

/** 用一条消息里的时钟读数和收到它的控制面时间测一次时钟偏差。 */
export function measureClockOffset(reading: AgentClockReading, receivedAt: Date): ClockOffset {
	return { offsetMs: clockOffsetMs(reading.agentTimeMs, receivedAt), measuredAt: receivedAt };
}

/** 接口里的时钟偏差（@sfly/schema 的 ClockOffsetView）；没有测到（任一项为空）时为 null。 */
export function clockOffsetView(
	offsetMs: number | null | undefined,
	measuredAt: Date | null | undefined,
): ClockOffsetView | null {
	if (offsetMs == null || measuredAt == null) return null;
	return {
		offset_ms: offsetMs,
		measured_at: measuredAt.toISOString(),
		exceeds_threshold: clockOffsetExceedsThreshold(offsetMs),
	};
}

/**
 * Agent 时间能记录的范围（Unix 毫秒，公元 100 年到 9999 年）。范围只在这里定义。
 * - 上限：接口里的时间是四位年份的 ISO 8601 字符串，9999 年之后写不出来。
 * - 下限：数据库里的时间读回来时，年份不到 100 的会被当成两位数年份读错（0001 年读成 2001 年）。
 */
const MIN_AGENT_TIME_MS = -59_011_459_200_000;
const MAX_AGENT_TIME_MS = 253_402_300_799_999;

/**
 * Agent 上报的 Agent 时间（Unix 毫秒，任意值）→ 能记录的 Unix 毫秒。Agent 时间不做范围检查（ADR 0018）：
 * 超出能记录的范围时按边界值记录，带着它的日志行、进度、指标点和产物都照常接收，不因此丢弃，也不记成「未记录」。
 * 日志、进度、指标、产物的 Agent 时间都经这里。
 */
export function recordableAgentTimeMs(unixMs: bigint | number): number {
	return Math.min(MAX_AGENT_TIME_MS, Math.max(MIN_AGENT_TIME_MS, Number(unixMs)));
}

/** 一次连接里折算的一段：从单调时钟读数 `fromMs` 起用的常量。 */
interface ClockSegment {
	fromMs: number;
	constantMs: number;
}

/** 一次连接最多记住几段折算；更早的读数（极少见：连接里很久以前排队的数据）按最早记住的那一段折算。 */
const MAX_SEGMENTS = 16;

/** 换算偏差（毫秒）：重新估算时写的一行说明，正数表示按原来的换算折算出的时间比控制面时间晚。 */
/** 重新估算时这次心跳的观测偏差（折算出的时间减去收到心跳的控制面时间，负数是早）：按原来的和按新的换算。 */
export type RecalibrationNote = { beforeMs: number; afterMs: number };

/**
 * 一次连接的「单调时钟读数 → 控制面时间」对应关系（控制面时间 = 单调时钟读数 + 常量）：收到 Hello 时用当时的控制面时间和
 * Hello 里的单调时钟读数定下常量；之后每次心跳用心跳里的读数和收到它的控制面时间检查换算偏差（ADR 0018「按连接和心跳时测得的
 * 时钟偏差折算」，#389），超过 {@link CLOCK_OFFSET_THRESHOLD_MS} 时重新估算（{@link recalibrate}）。
 * - 心跳只会晚到：按它算出的常量比真实的大（一次网络延迟）。算出的常量比现在的小（折算出的时间比控制面时间晚）不可能是延迟，
 *   超过阈值就重新估算；比现在的大，可能只是这一次晚到，连续两次心跳都超过阈值才重新估算，取两次里小的那个。
 * - 新常量只用于这次心跳读数之后的点；之前的读数仍按原来的常量折算，已经写下的点不变。
 * - 新常量立即生效：折算结果因此变早时（控制面墙上时钟往回拨了），之后的点就落在纠正后的时间，不等控制面时间追上来；
 *   同一序列里的顺序由指标写入兜底（`task-metrics.ts`：不晚于最后一个点的往后排一秒），#389 评论里负责人的决定。
 * 旧版本 Agent 的 Hello 不带单调时钟读数时没有对应关系。
 */
export class ConnectionClock {
	/** 各段折算，按读数从早到晚；没有对应关系时为空。 */
	readonly #segments: ClockSegment[] = [];
	/** 上一次心跳算出的、比现在的常量大得多的常量（等第二次确认）；没有时为 undefined。 */
	#pendingMs: number | undefined;

	constructor(
		private readonly clock: Clock,
		hello: AgentClockReading | undefined,
		helloReceivedAt: Date,
	) {
		if (hello) {
			const constantMs = helloReceivedAt.getTime() - hello.monotonicMs;
			this.#segments.push({ fromMs: -Infinity, constantMs });
		}
	}

	/**
	 * 心跳带来的读数：检查换算偏差，需要时重新估算常量。重新估算了返回这次心跳在调整前后的偏差（调用方写一行日志），否则返回 undefined。
	 * 读数比当前这一段的起点早（乱序到达）时不处理。
	 */
	recalibrate(monotonicMs: number, receivedAt: Date): RecalibrationNote | undefined {
		const current = this.#segments.at(-1);
		if (current === undefined || monotonicMs <= current.fromMs) return undefined;
		const sampleMs = receivedAt.getTime() - monotonicMs;
		const driftMs = current.constantMs - sampleMs;
		if (Math.abs(driftMs) < CLOCK_OFFSET_THRESHOLD_MS) {
			this.#pendingMs = undefined;
			return undefined;
		}
		let constantMs = sampleMs;
		if (driftMs < 0) {
			// 折算出的时间比控制面时间早：可能只是这次心跳晚到，等下一次也这样再改。
			if (this.#pendingMs === undefined) {
				this.#pendingMs = sampleMs;
				return undefined;
			}
			constantMs = Math.min(this.#pendingMs, sampleMs);
		}
		this.#pendingMs = undefined;
		this.#segments.push({ fromMs: monotonicMs, constantMs });
		if (this.#segments.length > MAX_SEGMENTS) this.#segments.shift();
		return { beforeMs: driftMs, afterMs: constantMs - sampleMs };
	}

	/**
	 * 把 Agent 打的单调时钟读数折算成控制面时间：这件事在 Agent 上发生时的控制面时间，可以早于这次连接
	 * （断线期间排队的数据）。没法折算时返回 undefined：连接没有对应关系（旧版本 Agent），或读数为 0（消息没带读数）。
	 */
	occurredAt(monotonicMs: bigint | number): Date | undefined {
		const reading = Number(monotonicMs);
		if (this.#segments.length === 0 || reading === 0) return undefined;
		const segment =
			this.#segments.findLast((sg) => sg.fromMs <= reading) ?? (this.#segments[0] as ClockSegment);
		return new Date(reading + segment.constantMs);
	}

	/**
	 * 一条消息的控制面时间：能折算时是 {@link occurredAt}；没法折算时兜底为收到这条消息的时刻 `receivedAt`，
	 * 与没有这些字段之前的行为一致。「没有读数」的兜底只写在这里。
	 */
	controlPlaneTime(monotonicMs: bigint | number, receivedAt: Date): Date {
		return this.occurredAt(monotonicMs) ?? receivedAt;
	}

	/**
	 * 一件事（任务开始、结束）发生时的时钟偏差：消息里的 Agent 时间减去它的单调时钟读数折算出的控制面时间，
	 * 测量时刻就是折算出的那个时间。消息晚到（断线期间排队的结果）时仍是发生那一刻的偏差。
	 * 消息没带读数（旧版本 Agent）时返回 undefined。
	 */
	offsetAt(message: { agentTimeUnixMs: bigint; monotonicMs: bigint }): ClockOffset | undefined {
		const reading = agentClockReading(message);
		return (
			reading &&
			measureClockOffset(reading, this.controlPlaneTime(reading.monotonicMs, this.clock.now()))
		);
	}
}
