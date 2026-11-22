import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import type { AgentClient } from "./agent.js";

/**
 * skill 由助手服务从自己的镜像写到工作台上（#540 要求 2：不从工作台往回复制任何东西）。镜像里的那份是
 * `docs/guide/skills/` 下的两份（和 `sfly init` 放进节点包的是同一份），pi 经 `--skill` 读镜像里的；
 * 工作台上的同一份放在 `<工作区>/.agents/skills/`，模型用读工具读的是它（扩展把系统提示里 skill 的位置改成它）。
 */

/** 镜像里 skill 目录下的全部文件（相对路径，用 `/` 分隔），按路径排序。 */
export function skillFiles(skillsDir: string): string[] {
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else files.push(relative(skillsDir, path).split(sep).join("/"));
		}
	};
	walk(skillsDir);
	return files;
}

/** skill 在工作台上的目录。 */
export const workbenchSkillsDir = (workdir: string) => posix.join(workdir, ".agents", "skills");

/** 把镜像里的 skill 原样写到工作台上（父目录经命令 `mkdir -p` 建）。 */
export async function writeSkillsToWorkbench(
	agent: AgentClient,
	skillsDir: string,
	workdir: string,
): Promise<void> {
	const target = workbenchSkillsDir(workdir);
	const files = skillFiles(skillsDir);
	const dirs = [...new Set(files.map((file) => posix.dirname(posix.join(target, file))))];
	const code = await agent.run(["mkdir", "-p", ...dirs], { cwd: workdir, timeoutMs: 30_000 });
	if (code !== 0) throw new Error(`在工作台上建 skill 目录失败（mkdir 退出码 ${code}）`);
	for (const file of files) {
		await agent.writeFile(posix.join(target, file), readFileSync(join(skillsDir, file)));
	}
}
