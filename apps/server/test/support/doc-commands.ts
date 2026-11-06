import { type ChildProcess, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 用户文档里的命令（#61）：每页 Markdown 里 ```sh 代码块就是读者照着运行的命令，
 * 其他语言的代码块（text、python、toml、ini……）是示例或输出，不运行。列表里缩进的代码块去掉缩进。
 */
export function shellBlocks(markdown: string): string[] {
	return [...markdown.matchAll(/^( *)```sh\n([\s\S]*?)^\1```$/gm)].map(
		([, indent = "", body = ""]) =>
			body
				.split("\n")
				.map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
				.join("\n"),
	);
}

export interface BlockResult {
	code: number;
	stdout: string;
	stderr: string;
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * 一个像读者终端那样的 bash 会话：代码块按原文 source 进同一个 shell，`cd`、`export` 在后续代码块里仍然有效。
 * 会话开着 `set -eo pipefail`，代码块里任何一条命令失败就整个会话退出，{@link run} 抛出带输出的错误。
 * 每个代码块的标准输入是 /dev/null，标准输出和标准错误分别写到 `dir` 下的文件里。
 * 会话在独立的进程组里，代码块在后台启动的进程（例如 `nohup … &`）在 {@link close} 时一起结束。
 */
export class DocShell {
	#count = 0;
	#stdout = "";
	#exited: Promise<number>;

	private constructor(
		private readonly shell: ChildProcess,
		private readonly dir: string,
	) {
		shell.stdout?.on("data", (chunk: Buffer) => {
			this.#stdout += chunk.toString();
		});
		this.#exited = new Promise((resolve) => shell.once("exit", (code) => resolve(code ?? -1)));
	}

	/** 在 `cwd` 启动会话；`env` 是完整的环境变量（不继承测试进程的环境）。 */
	static start(options: { cwd: string; env: Record<string, string>; dir: string }): DocShell {
		const shell = spawn("bash", ["--noprofile", "--norc"], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "inherit"],
			detached: true,
		});
		shell.stdin?.write("set -eo pipefail\n");
		return new DocShell(shell, options.dir);
	}

	/** 在会话里运行一个代码块；失败时会话结束，抛出包含代码块和输出的错误。 */
	async run(block: string): Promise<BlockResult> {
		const result = await this.#send(block, false);
		if (result.code !== 0) {
			throw new Error(
				`文档里的命令失败（退出码 ${result.code}）：\n${block}\n--- 标准输出\n${result.stdout}\n--- 标准错误\n${result.stderr}`,
			);
		}
		return result;
	}

	/** 在子 shell 里运行一个预期可能失败的代码块，返回退出码和输出；不影响会话的状态。 */
	check(block: string): Promise<BlockResult> {
		return this.#send(block, true);
	}

	async #send(block: string, subshell: boolean): Promise<BlockResult> {
		const n = ++this.#count;
		const file = join(this.dir, `block-${n}.sh`);
		const out = join(this.dir, `block-${n}.out`);
		const err = join(this.dir, `block-${n}.err`);
		await writeFile(file, block);
		const marker = `__sfly_doc_block_${n}__`;
		const redirect = `</dev/null >${quote(out)} 2>${quote(err)}`;
		this.shell.stdin?.write(
			subshell
				? `( . ${quote(file)} ) ${redirect} && s=0 || s=$?; echo "${marker} $s"\n`
				: `. ${quote(file)} ${redirect}; echo "${marker} 0"\n`,
		);
		const pattern = new RegExp(`${marker} (\\d+)\\n`);
		const code = await new Promise<number>((resolve) => {
			const poll = setInterval(() => {
				const match = pattern.exec(this.#stdout);
				if (match) {
					clearInterval(poll);
					resolve(Number(match[1]));
				}
			}, 50);
			void this.#exited.then((exitCode) => {
				clearInterval(poll);
				resolve(exitCode === 0 ? -1 : exitCode);
			});
		});
		const read = (path: string) => readFile(path, "utf8").catch(() => "");
		return { code, stdout: await read(out), stderr: await read(err) };
	}

	/** 结束会话和它启动的全部进程。 */
	async close(): Promise<void> {
		const pid = this.shell.pid;
		if (pid === undefined) return;
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// 进程组已经不在了。
		}
		await Promise.race([this.#exited, new Promise((r) => setTimeout(r, 5000))]);
	}
}
