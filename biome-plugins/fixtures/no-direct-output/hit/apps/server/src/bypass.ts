// 审查 #590 里列的那些「普通的写法」：换个办法拿到标准输出、标准错误、控制台，都要拦。
// 每一种写法对应规则里的一个名字（console、process-stream、process-destructure、stream-module-import、write-sync），
// biome-plugins.test.ts 要求规则里的每个名字都在这里被命中过。

// 导入：具名、重命名、默认、`* as`、`node:` 前缀的和不带的、控制台的模块。
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
// 动态导入和 require。
// @hit
const dynamic = await import("node:process");
// @hit
const required = require("console");

// 从 process 解构。
// @hit
const { stderr: viaStderr } = process;
// @hit
const { stdout, stderr: other } = globalThis.process;
// @hit
const { stdout: viaGlobal } = global.process;

// 从 console 解构、globalThis 上的 console。
// @hit
const { error } = console;
// @hit
const viaGlobalThis = globalThis.console;
// @hit
const viaGlobalName = global.console;

// 写文件描述符 1、2。
import * as fs from "node:fs";
import { writeSync } from "node:fs";
export function raw(text: string) {
	// @hit
	fs.writeSync(2, text);
	// @hit
	writeSync(1, text);
}

export const used = [stderr, out, proc, procDefault, Console, dynamic, required];
export const alsoUsed = [viaStderr, stdout, other, viaGlobal, error, viaGlobalThis, viaGlobalName];
