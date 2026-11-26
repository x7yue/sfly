// 写进日志的错误里去掉数据库查询的参数。
//
// drizzle 的查询出错时，错误的 message 和属性里带着这次查询的参数（`Failed query: insert … \nparams: …`，`error.params`），
// PostgreSQL 驱动给的错误还有 `detail`（`Key (token_hash)=(…) already exists.`）：写 `users` 表出错时密码的 scrypt 哈希会进日志，
// 别的表的参数里有令牌的哈希、secret 参数的默认值、飞书 Webhook 的地址。要保留的是 SQL（`$1` 这样的占位）和数据库给的原因
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

/** 套得太深、不再展开的那一层的说明。 */
const TRUNCATED = "（错误套得太深，这一层以及更里面的原因没有展开）";

/**
 * 数据库把值直接写进错误的 message（`detail` 之外的另一条路）：类别 22（数据异常）的错误，
 * 例如 `invalid input syntax for type uuid: "<值>"`、`date/time field value out of range: "<值>"`。
 * **不解析 message**：值怎么括、括不括、用哪种引号都取决于数据库的消息语言（德语是 `»值«`，有的语言根本不括），按引号去值
 * 在换了语言的数据库上会一个字也去不掉。所以类别 22 的 message 整句换掉，只留数据库给的错误码和报错的函数（`routine`，如
 * `string_to_uuid`、`pg_strtoint32_safe`，排查时看得出是哪一步）：见 {@link dataExceptionMessage}。
 * 别的类别（约束、列不存在……）的 message 里只有名字，不动。
 */
const embedsValues = (error: Error): boolean =>
	String((error as { code?: unknown }).code).startsWith("22");

/** 类别 22 的错误去掉值之后的说明：错误码，加上报错的函数（有的话）。 */
const dataExceptionMessage = (error: Error): string => {
	const { code, routine } = error as { code?: unknown; routine?: unknown };
	return `Database data exception [${String(code)}]${typeof routine === "string" ? ` in ${routine}` : ""}`;
};

const isQueryError = (error: Error): error is DrizzleLike =>
	"query" in error && "params" in error && typeof (error as DrizzleLike).query === "string";

/** pg 的 `DatabaseError`：有数据库给的严重程度和错误码。 */
const isPgError = (error: Error): boolean =>
	typeof (error as { severity?: unknown }).severity === "string" &&
	typeof (error as { code?: unknown }).code === "string";

/**
 * 去掉参数之后的错误：drizzle 的查询错误只留 SQL，pg 的数据库错误只留数据库给的原因（类别 22 的数据异常，message 里直接带着
 * 值的，整句换成错误码和报错的函数）；沿着 `cause` 链一路处理，聚合的错误（`AggregateError`，里面包着几个错误）把里面的每一个也处理。
 * 别的错误原样返回（不改它的内容）；不是 Error 的值原样返回；套得比 {@link MAX_DEPTH} 还深的那一层换成占位的错误。
 */
export function safeError(error: unknown, depth = 0): unknown {
	if (!(error instanceof Error)) return error;
	// 套得比展开的层数还深：这一层以及更里面的不展开，换成一个占位的错误，不原样放行（里面可能就有带着查询参数的错误）。
	if (depth > MAX_DEPTH) return new Error(TRUNCATED);
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
			? dataExceptionMessage(error)
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

/** 记日志的参数里往下找错误找几层（对象套对象、数组）。 */
const MAX_LOG_DEPTH = 4;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
	if (value === null || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
};

/** 一个参数里的错误去掉参数：错误本身、普通对象的每个值、数组的每一项（往下 {@link MAX_LOG_DEPTH} 层）；没有要改的原样返回（同一个对象）。 */
function sanitizeLogValue(value: unknown, depth: number): unknown {
	if (value instanceof Error) return safeError(value);
	if (depth >= MAX_LOG_DEPTH) return value;
	if (Array.isArray(value)) {
		const items = value.map((item) => sanitizeLogValue(item, depth + 1));
		return items.some((item, index) => item !== value[index]) ? items : value;
	}
	if (isPlainObject(value)) {
		const entries = Object.entries(value);
		const cleaned = entries.map(([key, item]) => [key, sanitizeLogValue(item, depth + 1)] as const);
		return cleaned.some(([, item], index) => item !== entries[index]?.[1])
			? Object.fromEntries(cleaned)
			: value;
	}
	return value;
}

/**
 * 记日志的调用 `log.error(error)`、`log.error({ err: error }, "…")` 的参数里的错误去掉参数：**所有**参数都过一遍，
 * 错误放在对象的哪个键下（`{ error }`、`{ cause }`、嵌套的对象和数组里）、放在第几个参数（`log.warn("失败：%s", error)`）都一样处理。
 * pino 在没有给说明文字时，用传进来的错误**自己的** message 当这一行日志的 `msg`，不是序列化之后的：只靠序列化器，`msg` 里仍有
 * 查询的参数，所以日志方法的入口也要过一遍（pino 的 `hooks.logMethod`，每次记日志都经过它）。
 * 管不到的：把错误拼进字符串（`` `失败：${error}` ``）或先 `util.inspect` 再交给日志，那时候它已经是字符串，认不出来——
 * 日志里的错误一律用 `err` 这个键传，见 CODING_STANDARDS.md。
 */
export function sanitizeLogArgs(args: unknown[]): unknown[] {
	const cleaned = args.map((arg) => sanitizeLogValue(arg, 0));
	return cleaned.some((arg, index) => arg !== args[index]) ? cleaned : args;
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
		if (key === "cause" || key in out) continue;
		// 错误自己别的属性里放着错误（`Object.assign(new Error("外层"), { original: 查询错误 })`）：一样处理，不原样抄进日志。
		out[key] = value instanceof Error ? serializeError(value, depth + 1) : value;
	}
	const cause = (safe as { cause?: unknown }).cause;
	if (cause !== undefined && depth < MAX_DEPTH) out.cause = serializeError(cause, depth + 1);
	if (safe instanceof AggregateError && depth < MAX_DEPTH) {
		out.errors = (safe.errors as unknown[]).map((member) => serializeError(member, depth + 1));
	}
	return out;
}
