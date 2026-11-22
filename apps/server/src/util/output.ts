// 控制面往终端写东西的唯一出口（#578）：`apps/server/src` 里除了这个文件，不能直接用 `console`、`process.stdout`、
// `process.stderr`（lint 规则 no-direct-output 拦着，换函数、起别名、直接写标准错误都拦）。要打印就走这里：
// 错误一律过 {@link safeError}，数据库错误里的参数（密码的哈希、令牌的哈希、保密参数的值、飞书 Webhook 的地址）
// 不会进日志，也不会打在操作者的终端上。想绕开它的代码过不了 lint，所以「某一处忘了去掉参数」不会再悄悄发生。
import { safeError } from "./safe-error.js";

/** 错误日志（标准错误）：`what` 是说明，`error` 先去掉数据库参数再打印。 */
export function printError(what: string, error?: unknown): void {
	if (error === undefined) console.error(what);
	else console.error(what, safeError(error));
}

/** 提醒（标准错误）：不带错误对象的一行话。 */
export function printWarning(message: string): void {
	console.warn(message);
}

/** 一般信息（标准输出）：启动时的一行话。 */
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

/** 一个错误给操作者看的一行说明：去掉数据库参数之后的 message；不是错误的值转成字符串。 */
export function describeError(error: unknown): string {
	const safe = safeError(error);
	return safe instanceof Error ? safe.message : String(safe);
}
