// 审查 #590 里列的那些「普通的写法」：换个办法拿到标准输出、标准错误、控制台，都要拦。
// 规则里每一种写法有一个名字（见规则文件开头的清单），biome-plugins.test.ts 要求每个名字至少有一个样例在这里（或 direct.ts）被命中：
// 样例按名字分组，删掉哪一组，那个名字就没人命中、测试红。

import * as fs from "node:fs";
import {
	appendFile,
	appendFileSync,
	createWriteStream,
	write,
	writeFile,
	writeFileSync,
	writeSync,
	writev,
	writevSync,
} from "node:fs";

// module-import-static：具名、重命名、默认、`* as`、`node:` 前缀的和不带的、控制台的模块。
// @hit
import { stderr } from "node:process";
// @hit
import { stdout as out } from "process";
// @hit
import * as proc from "node:process";
// @hit
import procDefault from "node:process";
// @hit
import { Console } from "node:console";
// module-import-dynamic 和 module-require。
// @hit
const dynamic = await import("node:process");
// @hit
const required = require("console");

// process-destructure：从 process 解构（初始值本身是 process，外面可以有括号、`as …`、`!`）。
// @hit
const { stderr: viaStderr } = process;
// @hit
const { stdout: typed }: { stdout: unknown } = process;
// @hit
const { stderr: asProcess } = process as NodeJS.Process;
// @hit
const { stdout: parenthesized } = (process);
// @hit
const { stdout: nonNull } = process!;
// @hit
const { emitWarning } = process;
// @hit
const { _rawDebug } = process;
// process-destructure-global：初始值是 globalThis.process、global.process。
// @hit
const { stdout, stderr: other } = globalThis.process;
// @hit
const { stdout: viaGlobal } = global.process;
// @hit
const { stderr: asGlobal } = globalThis.process as NodeJS.Process;
// process-destructure-from-global：从 globalThis、global 解构出 process 再取标准输出、标准错误。
// @hit
const { process: { stderr: nested } } = globalThis;
// @hit
const { process: { stdout: nestedGlobal } } = global;

// console：从 console 解构、globalThis 上的 console。
// @hit
const { error } = console;
// @hit
const viaGlobalThis = globalThis.console;
// @hit
const viaGlobalName = global.console;

export function viaGlobals(text: string) {
	// process-stream-global：经 globalThis、global 取 process 再取标准输出、标准错误。
	// @hit
	globalThis.process.stderr.write(text);
	// @hit
	global.process.stdout.write(text);
	// process-stream-global-optional：可选链。
	// @hit
	globalThis.process?.stdout.write(text);
	// @hit
	globalThis?.process.stderr.write(text);
	// @hit
	global?.process?.stdout.write(text);
	// process-stream-optional：`process?.stdout`、`process?.stderr`。
	// @hit
	process?.stderr.write(text);
	// @hit
	process?.stdout.write(text);
}

export function warn(error: Error) {
	// process-emit-warning：警告默认打到标准错误，传进去查询错误时 message 里的参数整段打出来。
	// @hit
	process.emitWarning(error);
	// @hit
	process?.emitWarning(error);
	// process-emit-warning-global。
	// @hit
	globalThis.process.emitWarning(error.message);
	// @hit
	global.process?.emitWarning(error.message);
	// process-raw-debug：直接写标准错误。
	// @hit
	process._rawDebug(error.message);
}

// 往文件描述符 1、2 写（整数字面量，十六进制也认）：每个函数两个名字，任意接收者的和直接调用的。
export function raw(text: string, buffer: Buffer) {
	// write-sync、write-sync-direct
	// @hit
	fs.writeSync(2, text);
	// @hit
	writeSync(1, text);
	// @hit
	writeSync(2, buffer, 0, buffer.length);
	// @hit
	fs.writeSync(0x2, text);
	// writev-sync、writev-sync-direct
	// @hit
	fs.writevSync(2, [buffer]);
	// @hit
	writevSync(1, [buffer]);
	// write-file-sync、write-file-sync-direct
	// @hit
	fs.writeFileSync(2, text);
	// @hit
	writeFileSync(1, text);
	// append-file-sync、append-file-sync-direct
	// @hit
	fs.appendFileSync(1, text);
	// @hit
	appendFileSync(2, text);
	// write、write-direct
	// @hit
	fs.write(2, text, () => {});
	// @hit
	write(1, text, () => {});
	// writev、writev-direct
	// @hit
	fs.writev(2, [buffer], () => {});
	// @hit
	writev(1, [buffer], () => {});
	// write-file、write-file-direct
	// @hit
	fs.writeFile(2, text, () => {});
	// @hit
	writeFile(1, text, () => {});
	// append-file、append-file-direct
	// @hit
	fs.appendFile(1, text, () => {});
	// @hit
	appendFile(2, text, () => {});
}

// create-write-stream、create-write-stream-direct：选项里有 `fd: 1|2`，别的选项不碍事。
export function stream() {
	// @hit
	const first = fs.createWriteStream("", { fd: 2 });
	// @hit
	const second = fs.createWriteStream("", { fd: 2, autoClose: false });
	// @hit
	const third = createWriteStream("", { autoClose: false, fd: 1 });
	return [first, second, third];
}

export const used = [stderr, out, proc, procDefault, Console, dynamic, required];
export const alsoUsed = [
	viaStderr,
	typed,
	asProcess,
	parenthesized,
	nonNull,
	emitWarning,
	_rawDebug,
	stdout,
	other,
	viaGlobal,
	asGlobal,
	nested,
	nestedGlobal,
	error,
	viaGlobalThis,
	viaGlobalName,
];
