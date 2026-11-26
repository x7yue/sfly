import { forLog } from "./redact.js";

// 助手服务往终端写东西只走这里（#693，和控制面的 apps/server/src/util/output.ts 同一个规矩）：日志只有一个出口，错误在这里
// 换成一行说明（只取 message、不带堆栈，按形状打码、截到上限），别处直接打印就可能把它拿到的凭据、会话里的内容、上游的错误原文
// 原样带进日志。lint 规则 no-direct-output（biome-plugins/no-direct-output.grit）拦 apps/assistant/src 里直接碰 `console`、
// `process.stdout`、`process.stderr` 的写法，这个文件除外；**它是方便，不是保证**（认的写法见规则文件开头的清单）。
// 这个文件自己由 test/output.test.ts 守：直接往终端写的声明只有登记的那几个。
//
// 会话里 secret 环境变量（`secret_env`）的值和模型的密钥要按值打码，只有 sessions.ts 知道它们：那里写日志之前先过 `#forLog`，再交给这里。

/** 写一行日志：标准错误，行首是时间。收字符串；要打印错误用 {@link printError}。 */
export function writeLog(message: string): void {
	process.stderr.write(`${new Date().toISOString()} ${message}\n`);
}

/**
 * 错误的一行说明：只取 message（不带堆栈：堆栈里有容器里的路径，对排查没用），按形状打码（`Authorization`、`Bearer` 后面的串、
 * 地址里的用户名和密码），截到 redact.ts 的 `LOG_TEXT_LIMIT`。
 */
export function describeError(error: unknown): string {
	return forLog(error instanceof Error ? error.message : String(error), []);
}

/**
 * 写一行嵌着原文（工作台连接上的报错）、手边没有会话可以按值打码的日志：按形状打码、截到上限再写。
 * 助手服务在会话以外用的工作台客户端（main.ts）用它；会话里的客户端用先过 `#forLog` 的那一个。
 */
export function writeRawLog(line: string): void {
	writeLog(forLog(line, []));
}

/** 打印一个错误：`<在做什么>：<错误的一行说明>`。 */
export function printError(what: string, error: unknown): void {
	writeLog(`${what}：${describeError(error)}`);
}
