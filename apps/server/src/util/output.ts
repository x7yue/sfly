// 控制面的代码往终端写东西的唯一出口（#578；Fastify 的日志是另一条出口，由 `sanitizeLogArgs` 处理）：
// `apps/server/src` 里除了这个文件，要打印就走这里，不直接用 `console`、`process.stdout`、`process.stderr`：
// lint 规则 no-direct-output 拦着一批写法（换打印的函数、起别名、`globalThis.process`、`fs.writeSync(2, …)`、`process.emitWarning` 等），
// **它是方便，不是保证**：认的是 biome-plugins/no-direct-output.grit 开头清单里的写法（docs/ARCHITECTURE.md 里是同一份），
// 清单之外的（存进变量的 `process`、拼出来的名字……）不保证拦住，靠审查。
// 错误一律过 {@link safeError}：错误本身是数据库的查询错误、或者在 `cause` 链和 `AggregateError` 里的，参数（密码的哈希、令牌的哈希、
// 保密参数的值、飞书 Webhook 的地址）不会进日志，也不会打在操作者的终端上；错误放在别的错误的属性里的（`printError("…", 外层)`，
// 查询错误在外层的 `original` 之类的属性里）不处理，不要这样包。**只有 {@link printError} 收错误**：{@link printWarning}、{@link printInfo}、{@link writeStdout} 收的是
// 字符串，把错误拼进去（`` printWarning(`失败：${error}`) ``）时已经是字符串，认不出来、去不了参数——要打印错误就用 printError。
import { safeError } from "./safe-error.js";

/** 错误日志（标准错误）：`what` 是说明，`error` 先去掉数据库参数再打印。 */
export function printError(what: string, error?: unknown): void {
	if (error === undefined) console.error(what);
	else console.error(what, safeError(error));
}

/** 提醒（标准错误）：不带错误对象的一行话；不要把错误拼进去（那时它已经是字符串，认不出来），要打印错误用 {@link printError}。 */
export function printWarning(message: string): void {
	console.warn(message);
}

/** 一般信息（标准输出）：启动时的一行话；同样不要把错误拼进去。 */
export function printInfo(message: string): void {
	console.log(message);
}

/** 命令行交互往标准输出写的字（输入密码时的提示）：不是日志，不带错误。 */
export function writeStdout(text: string): void {
	process.stdout.write(text);
}

/**
 * 命令行子命令（`reset-password`）的标准输出和标准错误，交给子命令的函数当输入输出用：函数自己负责不把数据库错误原样写进去
 * （用 {@link describeError}）。控制面的其余代码不要用它，要打印走上面的函数。
 */
export function terminalStreams(): {
	stdout: NodeJS.WritableStream;
	stderr: NodeJS.WritableStream;
} {
	return { stdout: process.stdout, stderr: process.stderr };
}

/**
 * 一个错误给操作者看的一行说明：去掉数据库参数之后的 message，后面接最里层的原因（`（原因：…）`）；不是错误的值转成字符串。
 * 写库失败时错误的 message 只是 `Failed query: update … returning …`，连不上数据库时也一样，真正的原因（触发器的报错、约束名、
 * `ECONNREFUSED`）在 `cause` 里：沿着 `cause` 走到最里面，聚合的错误（连不上时 pg 抛的 `AggregateError`，自己的 message 是空的）
 * 把每个成员的原因都接上。数据库给的错误码也带上。参数已经去掉了，不会因此带出值。
 */
export function describeError(error: unknown): string {
	const safe = safeError(error);
	if (!(safe instanceof Error)) return String(safe);
	const head = safe.message;
	const reasons = [...new Set(innerReasons(safe).filter((reason) => reason !== head))];
	if (reasons.length === 0) return head || String(safe.name);
	return head ? `${head}（原因：${reasons.join("；")}）` : reasons.join("；");
}

/** 一个错误最里层的原因：聚合的错误是每个成员的原因，有 cause 的是 cause 的原因，最里面的是它自己的 message（带上数据库的错误码）。 */
function innerReasons(error: Error, depth = 0): string[] {
	if (depth > 8) return [];
	if (error instanceof AggregateError) {
		const members = (error.errors as unknown[]).flatMap((member) =>
			member instanceof Error ? innerReasons(member, depth + 1) : [String(member)],
		);
		if (members.length > 0) return members;
	}
	const cause = (error as { cause?: unknown }).cause;
	if (cause instanceof Error) return innerReasons(cause, depth + 1);
	if (cause !== undefined) return [String(cause)];
	// 最里面的一个：自己的 message；数据库的错误码（`23505`）不在 message 里时带上。
	if (depth === 0) return [];
	const { code, routine } = error as { code?: unknown; routine?: unknown };
	const message = error.message;
	// 数据库的错误码和报错的函数不在 message 里时带上（类别 22 的 message 已经是「错误码加函数」）。
	const tags = [code, routine].filter(
		(tag): tag is string => typeof tag === "string" && !message.includes(tag),
	);
	return [tags.length > 0 ? `${message} [${tags.join(", ")}]` : message];
}
