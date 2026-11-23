// 审查 #590 里列的那些「普通的写法」：换个办法拿到标准输出、标准错误、控制台，都要拦。
// 规则里每一种写法有一个名字（见规则文件开头），biome-plugins.test.ts 要求每个名字至少有一个样例在这里（或 direct.ts）被命中：
// 样例按名字分组，删掉哪一组，那个名字就没人命中、测试红。

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

// process-destructure：从 process 解构（初始值本身是 process）。
// @hit
const { stderr: viaStderr } = process;
// @hit
const { stdout: typed }: { stdout: unknown } = process;
// process-destructure-global：初始值是 globalThis.process、global.process。
// @hit
const { stdout, stderr: other } = globalThis.process;
// @hit
const { stdout: viaGlobal } = global.process;

// console：从 console 解构、globalThis 上的 console。
// @hit
const { error } = console;
// @hit
const viaGlobalThis = globalThis.console;
// @hit
const viaGlobalName = global.console;

// process-stream-global：经 globalThis、global 取 process 再取标准输出、标准错误。
export function viaGlobals(text: string) {
	// @hit
	globalThis.process.stderr.write(text);
	// @hit
	global.process.stdout.write(text);
}

// process-emit-warning：警告默认打到标准错误，传进去查询错误时 message 里的参数整段打出来。
export function warn(error: Error) {
	// @hit
	process.emitWarning(error);
	// @hit
	globalThis.process.emitWarning(error.message);
}

// write-fd：往文件描述符 1、2 写（字面量）；参数多几个也认。
import * as fs from "node:fs";
import { writeSync } from "node:fs";
export function raw(text: string, buffer: Buffer) {
	// @hit
	fs.writeSync(2, text);
	// @hit
	writeSync(1, text);
	// @hit
	writeSync(2, buffer, 0, buffer.length);
	// @hit
	fs.writeFileSync(2, text);
	// @hit
	fs.appendFileSync(1, text);
	// @hit
	fs.writevSync(2, [buffer]);
	// @hit
	fs.write(2, text, () => {});
}

// create-write-stream-fd。
export function stream() {
	// @hit
	return fs.createWriteStream("", { fd: 2 });
}

export const used = [stderr, out, proc, procDefault, Console, dynamic, required];
export const alsoUsed = [viaStderr, typed, stdout, other, viaGlobal, error, viaGlobalThis, viaGlobalName];
