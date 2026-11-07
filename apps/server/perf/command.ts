// 性能测试运行外部命令（构建被测对象、运行基准测试）。
import { spawn } from "node:child_process";

/**
 * 运行一个命令（构建、基准测试）：标准错误（以及 capture 为 false 时的标准输出）直接显示在终端上，作为进度；
 * 返回退出码与（capture 时）标准输出。给了 signal 时，中断即结束子进程。
 */
export function runCommand(
	command: string,
	args: string[],
	options: { cwd: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; capture?: boolean },
): Promise<{ code: number; stdout: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			signal: options.signal,
			stdio: ["ignore", options.capture ? "pipe" : "inherit", "inherit"],
		});
		let stdout = "";
		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (options.signal?.aborted) reject(options.signal.reason);
			else resolve({ code: code ?? (signal ? 128 : 1), stdout });
		});
	});
}

/** 同 {@link runCommand}，退出码不为 0 时抛出错误。 */
export async function runChecked(
	command: string,
	args: string[],
	options: Parameters<typeof runCommand>[2],
): Promise<string> {
	const { code, stdout } = await runCommand(command, args, options);
	if (code !== 0) throw new Error(`${command} ${args.join(" ")} 以退出码 ${code} 结束`);
	return stdout;
}
