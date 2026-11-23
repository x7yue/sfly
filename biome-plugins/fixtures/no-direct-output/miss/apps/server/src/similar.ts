// 看起来像、但碰不到终端：不命中。
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createWriteStream, readFileSync, write, writeFileSync, writeSync } from "node:fs";

// 从 process 解构别的东西。
const { env, argv, pid } = process;
// 子进程的结果里也有 stdout、stderr，不是 process 的；初始值里用到 process 也不算。
const { stdout, stderr } = spawnSync("echo", ["x"]);
const { stdout: out2 } = spawnSync(process.execPath, ["-v"]);
const { stderr: err2 } = spawnSync("ls", [], { env: process.env });
// 从 globalThis 解构出 process 本身（不取标准输出、标准错误）。
const { process: viaGlobal } = globalThis;
// 写别的文件描述符（变量、别的数字）、写文件：规则只看写出来的 1、2。
export function write2(fd: number, path: string, text: string) {
	writeSync(fd, text);
	writeSync(3, text);
	writeFileSync(path, text);
	fs.writeFileSync(path, text);
	fs.write(fd, text, () => {});
	write(10, text, () => {});
	return [
		fs.createWriteStream(path, { flags: "a" }),
		fs.createWriteStream(path, { fd: 5 }),
		createWriteStream(path),
	];
}
// `process` 上别的属性、别的对象上叫 process 的属性。
export const where = [process.cwd(), process.env.HOME, process.exitCode, globalThis.process.pid];
const ctx = { process: { stderr: "x", emitWarning: () => {} } };
export const used = [
	env,
	argv,
	pid,
	stdout,
	stderr,
	out2,
	err2,
	viaGlobal,
	readFileSync,
	ctx.process.stderr,
	ctx.process.emitWarning(),
];
