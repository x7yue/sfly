/**
 * 按来源限频：同一个来源在一个窗口里只写一行日志，下一次写的时候带上这段时间里省掉的次数。
 *
 * 握手之前超过消息上限的那一行日志用它（#674）：没有认证的连接每开一条流、发一个超限的长度前缀，控制面就写一行，
 * 一个连接几百条流就能在几十毫秒里写几百行。握手之后超限的（认证过、有名字的 Agent）不限频：一台 Agent 每次重连才一行。
 *
 * 记着的来源最多 `maxSources` 个，超过时丢掉最久没写过的（它省掉的次数也就丢了）。
 */
export class SourceLogLimit {
	/** 来源 → 这个窗口从什么时候开始、窗口里已经省掉几行；按最后一次写的先后排（最早的在前）。 */
	readonly #seen = new Map<string, { since: number; suppressed: number }>();

	constructor(
		private readonly windowMs: number,
		private readonly maxSources: number,
	) {}

	/**
	 * `now`（毫秒）时这个来源要不要写一行：不写返回 undefined（并记一次）；写的话返回上一个窗口里省掉的行数
	 * （没有省掉就是 0），这一次开始新的窗口。
	 */
	admit(source: string, now: number): { suppressed: number } | undefined {
		const entry = this.#seen.get(source);
		if (entry !== undefined && now - entry.since < this.windowMs) {
			entry.suppressed++;
			return undefined;
		}
		const suppressed = entry?.suppressed ?? 0;
		this.#seen.delete(source);
		this.#seen.set(source, { since: now, suppressed: 0 });
		if (this.#seen.size > this.maxSources) {
			for (const oldest of this.#seen.keys()) {
				this.#seen.delete(oldest);
				break;
			}
		}
		return { suppressed };
	}
}
