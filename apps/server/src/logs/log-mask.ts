import type { SecretSet, WorkBudget } from "./secrets.js";

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
	/** 日志文件里的一行（不含换行符，JSON）：正文里没有 secret 值时返回同一个 Buffer；有时返回正文打了码、重新序列化的行。 */
	row(row: Buffer): Buffer;
	/**
	 * 另一次读取用的打码：同样的值集合、新的工作量预算（{@link SecretSet.withBudget}）。一个 LogMask 的预算是创建它的那次读取
	 * （一页、一次读取运行的日志）的；一次下载、一条流要分块、分批读很久，每一块、每一批开始时取一个新的，
	 * 每一块的同步耗时才有上限，也不会因为前面用掉了预算让后面的行都被整行盖住。
	 */
	fresh(): LogMask;
}

export const NO_LOG_MASK: LogMask = {
	active: false,
	line: (line) => line,
	row: (row) => row,
	fresh: () => NO_LOG_MASK,
};

/**
 * 按这个值集合（{@link secretValues} 的结果）做一个 {@link LogMask}；没有要打码的文本时是 {@link NO_LOG_MASK}。
 * 它带着自己的工作量预算（`budget` 给了就共用它）：一次读取里所有行的打码共用一份，用完之后剩下的行整行盖住。
 *
 * 文件里的行是 JSON，值里的引号、反斜杠、换行、控制字符在文件里是转义过的。一行里没有反斜杠时，正文在文件里就是它本来的样子，
 * 整行按文本查等于在查正文（还带着别的字段，只会多查、不会少查），没有 secret 值就原样返回，不解析：绝大多数行是这样，
 * 读一页日志的代价是对每行的一次查找。有反斜杠的行，正文和文件里的写法不一样（secret 值的某些写法本身带引号、反斜杠或 `\uXXXX`，
 * 在文件里又转义了一层，整行查不出来），所以解析出正文，在正文上查和打码：规则和写入时、按页读取时是同一个，不另认一套写法。
 */
export function logMask(secrets: SecretSet, budget?: WorkBudget): LogMask {
	if (secrets.texts.length === 0) return NO_LOG_MASK;
	const view = secrets.withBudget(budget);
	return {
		active: true,
		line: (line) => {
			const text = view.mask(line.text);
			return text === line.text ? line : { ...line, text };
		},
		row: (row) => {
			const raw = row.toString("utf8");
			// 没有 secret 值时 `mask` 返回的是同一个字符串（没有分配）。
			if (!raw.includes("\\") && view.mask(raw) === raw) return row;
			let parsed: { text?: unknown };
			try {
				parsed = JSON.parse(raw) as { text?: unknown };
			} catch {
				// 不是 JSON（不应该有）：不放行，按文本打码。
				const masked = view.mask(raw);
				return masked === raw ? row : Buffer.from(masked);
			}
			if (typeof parsed.text !== "string") return row;
			const text = view.mask(parsed.text);
			return text === parsed.text ? row : Buffer.from(JSON.stringify({ ...parsed, text }));
		},
		fresh: () => logMask(secrets),
	};
}
