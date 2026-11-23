// 看起来像、但碰不到终端：不命中。
import { readFileSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";

// 从 process 解构别的东西。
const { env, argv, pid } = process;
// 子进程的结果里也有 stdout、stderr，不是 process 的。
const { stdout, stderr } = spawnSync("echo", ["x"]);
// 写别的文件描述符（变量）：规则只看写出来的 1、2。
export function write(fd: number, text: string) {
	writeSync(fd, text);
}
// `process` 上别的属性。
export const where = [process.cwd(), process.env.HOME, process.exitCode];
export const used = [env, argv, pid, stdout, stderr, readFileSync];
