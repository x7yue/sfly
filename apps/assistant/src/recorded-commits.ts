import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 平台在每个工作区上次记下的提交号（#546）：一轮结束时提交工作区，这一轮改了什么，是「这一轮的树」和「平台上次记下的树」之差，
 * 不是和 `HEAD` 比（模型自己 `git commit`、`reset` 之后 `HEAD` 就不是平台上次看到的样子了，见 workspace.ts 文件头）。
 *
 * 记在助手服务自己的数据目录里，**不放工作台上**：工作台上的东西模型都能改。每个工作区（工作台地址加工作区路径）一个小文件，
 * 文件名是这两样的哈希。不是协议的一部分：控制面和页面不知道它。数据目录丢了、文件坏了都读成「没有记过」，这时提交退回和 `HEAD` 比
 * （workspace.ts 的「记什么」），不出错。
 */
export class RecordedCommits {
	constructor(private readonly dir: string) {}

	#path(workbench: string, workdir: string): string {
		const key = createHash("sha256").update(`${workbench}\0${workdir}`).digest("hex").slice(0, 32);
		return join(this.dir, `${key}.json`);
	}

	/** 这个工作区上次记下的提交号；没有记过、文件认不出来时 undefined。 */
	get(workbench: string, workdir: string): string | undefined {
		try {
			const body = JSON.parse(readFileSync(this.#path(workbench, workdir), "utf8")) as {
				commit?: unknown;
			};
			return typeof body.commit === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(body.commit)
				? body.commit
				: undefined;
		} catch {
			return undefined;
		}
	}

	/** 记下来：先写旁边的临时文件再换上去，读的人不会读到写了一半的。 */
	set(workbench: string, workdir: string, commit: string): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const path = this.#path(workbench, workdir);
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ workbench, workdir, commit })}\n`, {
			mode: 0o600,
		});
		renameSync(temporary, path);
	}
}
