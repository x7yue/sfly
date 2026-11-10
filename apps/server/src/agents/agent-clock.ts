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

/**
 * 一次连接的「单调时钟读数 → 控制面时间」对应关系：收到 Hello 时用当时的控制面时间和 Hello 里的单调时钟读数
 * 定下常量（控制面时间 = 单调时钟读数 + 常量），这次连接内不再重新估算，折算出的时间不倒退、间隔不变。
 * 旧版本 Agent 的 Hello 不带单调时钟读数时没有对应关系。
 */
export class ConnectionClock {
	/** 控制面时间（Unix 毫秒）− 单调时钟读数；没有对应关系时为 undefined。 */
	readonly #constantMs: number | undefined;

	constructor(
		private readonly clock: Clock,
		hello: AgentClockReading | undefined,
		helloReceivedAt: Date,
	) {
		this.#constantMs = hello && helloReceivedAt.getTime() - hello.monotonicMs;
	}

	/**
	 * 把 Agent 打的单调时钟读数折算成控制面时间：这件事在 Agent 上发生时的控制面时间，可以早于这次连接
	 * （断线期间排队的数据）。没法折算时返回 undefined：连接没有对应关系（旧版本 Agent），或读数为 0（消息没带读数）。
	 */
	occurredAt(monotonicMs: bigint | number): Date | undefined {
		const reading = Number(monotonicMs);
		if (this.#constantMs === undefined || reading === 0) return undefined;
		return new Date(reading + this.#constantMs);
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
