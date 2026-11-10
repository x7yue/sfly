import { z } from "zod";
import { Timestamp } from "./contract.js";

/**
 * 一次测得的时钟偏差（ADR 0018）：Agent 时间减去控制面时间，误差是一次单程网络延迟。
 * Agent 视图、任务和尝试视图（开始、结束时的偏差）共用这个形状。
 */
export const ClockOffsetView = z.object({
	/** Agent 时间 − 控制面时间（毫秒）：正数表示 Agent 比控制面快，负数表示慢。 */
	offset_ms: z.number().int(),
	/** 测量时刻（控制面时间）。 */
	measured_at: Timestamp,
	/** 偏差的绝对值达到 2 秒：页面只在这时提示，不到 2 秒视为一致。由控制面统一判断。 */
	exceeds_threshold: z.boolean(),
});

export type ClockOffsetView = z.infer<typeof ClockOffsetView>;
