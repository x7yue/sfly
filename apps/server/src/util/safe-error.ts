// 写进日志的错误里去掉数据库查询的参数。
//
// drizzle 的查询出错时，错误的 message 和属性里带着这次查询的参数（`Failed query: insert … \nparams: …`，`error.params`），
// PostgreSQL 驱动给的错误还有 `detail`（`Key (token_hash)=(…) already exists.`）：写 `users` 表出错时密码的 scrypt 哈希会进日志，
// 别的表的参数里有令牌的哈希、保密参数的默认值、飞书 Webhook 的地址。要保留的是 SQL（`$1` 这样的占位）和数据库给的原因
// （错误码、约束名、表名、列名），去掉的是参数和 `detail`、`where`（里面带着值）。
// 所有记日志的地方都过这一处：Fastify 的日志用 {@link serializeError}（`logger.serializers.err`），`console.error` 的地方用 {@link safeError}。

interface DrizzleLike extends Error {
	query?: unknown;
	params?: unknown;
}

/** PostgreSQL 驱动（pg）的错误里可以保留的字段：数据库给的原因，不含值。 */
const PG_SAFE_FIELDS = [
	"code",
	"severity",
	"schema",
	"table",
	"column",
	"dataType",
	"constraint",
	"routine",
] as const;

const MAX_DEPTH = 6;

/**
 * 数据库把值直接写进错误的 message（`detail` 之外的另一条路）：类别 22（数据异常）的错误，
 * 例如 `invalid input syntax for type uuid: "<值>"`、`date/time field value out of range: "<值>"`、
 * `invalid byte sequence for encoding "UTF8": 0x00`。引号里的和 `0x` 开头的十六进制都换成省略号，说明（类型、原因）留着；
 * 别的类别（约束、列不存在……）的 message 里只有名字，不动。
 */
const embedsValues = (error: Error): boolean =>
	String((error as { code?: unknown }).code).startsWith("22");
const scrubValues = (message: string): string =>
	message.replace(/"(?:[^"\\]|\\.)*"/g, '"…"').replace(/\b0x[0-9a-fA-F]+\b/g, "0x…");

const isQueryError = (error: Error): error is DrizzleLike =>
	"query" in error && "params" in error && typeof (error as DrizzleLike).query === "string";

/** pg 的 `DatabaseError`：有数据库给的严重程度和错误码。 */
const isPgError = (error: Error): boolean =>
	typeof (error as { severity?: unknown }).severity === "string" &&
	typeof (error as { code?: unknown }).code === "string";

/**
 * 去掉参数之后的错误：drizzle 的查询错误只留 SQL，pg 的数据库错误只留数据库给的原因（类别 22 的数据异常，message 里直接带着
 * 值的，把值去掉）；沿着 `cause` 链一路处理，聚合的错误（`AggregateError`，里面包着几个错误）把里面的每一个也处理。
 * 别的错误原样返回（不改它的内容）；不是 Error 的值原样返回。
 */
export function safeError(error: unknown, depth = 0): unknown {
	if (!(error instanceof Error) || depth > MAX_DEPTH) return error;
	const cause = (error as { cause?: unknown }).cause;
	const safeCause = cause === undefined ? undefined : safeError(cause, depth + 1);
	const members = error instanceof AggregateError ? (error.errors as unknown[]) : undefined;
	const safeMembers = members?.map((member) => safeError(member, depth + 1));
	const membersChanged = safeMembers?.some((member, index) => member !== members?.[index]) ?? false;
	const query = isQueryError(error);
	const pg = isPgError(error);
	if (!query && !pg && safeCause === cause && !membersChanged) return error;
	const message = query
		? `Failed query: ${(error as DrizzleLike).query as string}`
		: pg && embedsValues(error)
			? scrubValues(error.message)
			: error.message;
	const options = safeCause === undefined ? undefined : { cause: safeCause };
	const safe =
		safeMembers === undefined
			? new Error(message, options)
			: new AggregateError(safeMembers, message, options);
	safe.name = error.name;
	// 堆栈的第一行是错误的 message：换成去掉参数之后的。
	safe.stack = error.stack?.includes(error.message)
		? error.stack.replace(error.message, message)
		: `${error.name}: ${message}`;
	if (pg) {
		for (const field of PG_SAFE_FIELDS) {
			const value = (error as unknown as Record<string, unknown>)[field];
			if (value !== undefined) (safe as unknown as Record<string, unknown>)[field] = value;
		}
	}
	return safe;
}

/**
 * 记日志的调用 `log.error(error)`、`log.error({ err: error }, "…")` 的参数里的错误去掉参数。pino 在没有给说明文字时，用传进来的
 * 错误**自己的** message 当这一行日志的 `msg`，不是序列化之后的：只靠序列化器，`msg` 里仍有查询的参数，所以日志方法的入口也要过一遍
 * （pino 的 `hooks.logMethod`，每次记日志都经过它）。
 */
export function sanitizeLogArgs(args: unknown[]): unknown[] {
	const [first, ...rest] = args;
	if (first instanceof Error) return [safeError(first), ...rest];
	if (
		first !== null &&
		typeof first === "object" &&
		(first as { err?: unknown }).err instanceof Error
	) {
		return [{ ...first, err: safeError((first as { err: Error }).err) }, ...rest];
	}
	return args;
}

/** 日志里 `err` 的样子（和 pino 的标准序列化一样有类型、message、堆栈，再加上错误上的其他属性）。 */
export interface SerializedError {
	[key: string]: unknown;
	type: string;
	message: string;
	stack: string;
}

/** Fastify 日志里 `err` 的序列化（`logger.serializers.err`）：先去掉数据库查询的参数，再写成一个普通对象，`cause` 链也在。 */
export function serializeError(error: unknown, depth = 0): SerializedError {
	const safe = safeError(error, depth);
	if (!(safe instanceof Error)) return { type: typeof safe, message: String(safe), stack: "" };
	const out: SerializedError = {
		type: safe.name,
		message: safe.message,
		stack: safe.stack ?? "",
	};
	for (const [key, value] of Object.entries(safe)) {
		if (key !== "cause" && !(key in out)) out[key] = value;
	}
	const cause = (safe as { cause?: unknown }).cause;
	if (cause !== undefined && depth < MAX_DEPTH) out.cause = serializeError(cause, depth + 1);
	if (safe instanceof AggregateError && depth < MAX_DEPTH) {
		out.errors = (safe.errors as unknown[]).map((member) => serializeError(member, depth + 1));
	}
	return out;
}
