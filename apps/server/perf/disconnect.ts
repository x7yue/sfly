// Agent 断线负载（items/06-agent-disconnect.ts）里的核对与测量（纯逻辑，单测见 test/perf-disconnect.test.ts）。

/**
 * 每秒一个点的序列（按时间升序，毫秒时间戳）里整秒缺失的点数：相邻两点之间空出的秒数之和。
 * 节点每秒都在上报时，每一秒都应当有一个合并后的点；Agent 断线排队超过上限丢弃最早的点，
 * 丢掉的正是这些整秒，与控制面记录的丢弃数（`dropped_points`）应当一致。
 */
export function missingSeconds(times: ReadonlyArray<number>): number {
	let missing = 0;
	for (let i = 1; i < times.length; i++) {
		const gap = Math.round(((times[i] as number) - (times[i - 1] as number)) / 1000) - 1;
		if (gap > 0) missing += gap;
	}
	return missing;
}

/**
 * 重连后补发完排队日志的耗时（毫秒）：从 `reconnectAt` 到控制面已写入的最大序号（`progress`，定时轮询的 last_seq）
 * 追上「重连之前产生、最终收到的最后一行」为止。Agent 按先后顺序发送排队的日志，重连后产生的行排在它们后面，
 * 所以追上这一行就是补发完了。重连前产生的行一行都没收到时为 0；采样里一直没追上时为 null。
 *
 * `lines` 是控制面最终收到的行（`timeMs` 是 Agent 读到这一行的时间，与 `reconnectAt` 同一时钟）。
 */
export function replayDuration(
	progress: ReadonlyArray<{ ms: number; lastSeq: number }>,
	lines: ReadonlyArray<{ seq: number; timeMs: number }>,
	reconnectAt: number,
): number | null {
	let backlogEnd = 0;
	for (const line of lines) {
		if (line.timeMs < reconnectAt && line.seq > backlogEnd) backlogEnd = line.seq;
	}
	if (backlogEnd === 0) return 0;
	const done = progress.find((p) => p.ms >= reconnectAt && p.lastSeq >= backlogEnd);
	return done ? done.ms - reconnectAt : null;
}

/** pnpm perf 里默认的断线时长（秒）；ARCHITECTURE §7.6 的目标是 5 分钟（DISCONNECT_SECONDS），用环境变量跑满。 */
export const DEFAULT_DISCONNECT_SECONDS = 45;
/** 断线时长下限：节点每秒 3 MiB stdout，约 21 秒排满 64 MiB 的日志队列，之后还要再断一会儿才能验证丢弃与计数。 */
export const MIN_DISCONNECT_SECONDS = {
	seconds: 30,
	reason: "日志队列排满之后还要再断一会儿",
};
