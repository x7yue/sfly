import type { SecretSet } from "./secrets.js";

/**
 * 读日志时的打码（#517）。日志写入时按「那一刻已知的」secret 值打码；secret 参数声明在子流程入口上时，要等那个子流程的实例创建
 * 才进入名单，在那之前写下的行里如果有后来才成为 secret 的值，文件里是原文。所以每个读日志的出口在读取时再按这次运行
 * 此刻的 secret 值（{@link TaskLogs.logMask}）打一遍，和运行视图、进度、动作是同一个口径。写入时的打码保留。
 *
 * 没有 secret 值时是 {@link NO_LOG_MASK}：`active` 为 false，读取方什么都不做，行原样通过（没有 secret 参数的运行没有任何额外代价）。
 */
export interface LogMask {
	/** 有没有 secret 值要打码；false 时读取方可以跳过一切处理。 */
	readonly active: boolean;
	/** 一行日志：正文里没有 secret 值时返回同一个对象；有时返回正文打了码的副本。 */
	line<T extends { text: string }>(line: T): T;
	/** 日志文件里的一行（不含换行符，JSON）：行里没有出现 secret 值时返回同一个 Buffer；有时返回正文打了码、重新序列化的行。 */
	row(row: Buffer): Buffer;
}

export const NO_LOG_MASK: LogMask = {
	active: false,
	line: (line) => line,
	row: (row) => row,
};

/**
 * 按这个值集合（{@link secretValues} 的结果）做一个 {@link LogMask}；没有要打码的文本时是 {@link NO_LOG_MASK}。
 *
 * 文件里的行是 JSON：先看这一行的字节里有没有 secret 值的文本（原文，或者引号、反斜杠、换行转义之后的写法），都没有就原样返回，
 * 不解析；有才解析、打码、重新序列化。绝大多数行没有 secret 值，所以读一页日志的代价是对每行的一次正则查找
 * （{@link SecretSet} 的匹配是按值集合缓存的一个正则）。
 */
export function logMask(secrets: SecretSet): LogMask {
	if (secrets.texts.length === 0) return NO_LOG_MASK;
	return {
		active: true,
		line: (line) => {
			const text = secrets.mask(line.text);
			return text === line.text ? line : { ...line, text };
		},
		row: (row) => {
			// 行是 JSON，值里的引号、反斜杠、换行在文件里是转义的：整行按文本查，原文的写法和转义的写法（SecretSet 里都有）都认得出。
			if (!secrets.appearsIn(row.toString("utf8"))) return row;
			const parsed = JSON.parse(row.toString("utf8")) as { text?: unknown };
			if (typeof parsed.text !== "string") return row;
			const text = secrets.mask(parsed.text);
			return text === parsed.text ? row : Buffer.from(JSON.stringify({ ...parsed, text }));
		},
	};
}
