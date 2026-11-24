// 用 biome-plugins/ 里的一条规则检查一段源码，返回命中的行号（和 apps/server/test/support/plugin-lint.ts 同一个做法，
// 测试不跨应用引用，所以这里一份）：测试要「按规则认的写法」判断一份源码，不是自己另写一套匹配。
// 源码放进临时目录里按指定的相对路径存放（规则按文件路径划范围），只加载这一条规则，关掉内置规则。
// Biome 2.4.x 偶发的工作区竞态（#582，见 apps/server/test/support/biome-lint.ts）：只认那一种内部错误，重跑。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

interface Diagnostic {
	category: string;
	message: string;
	location?: { path: string; start: { line: number } };
}

const isWorkspaceRace = (d: Diagnostic) =>
	d.category === "internalError/fs" && d.message.includes("does not exist in the workspace");

/** 规则在这份源码里命中的行（1 起），升序；规则以外的诊断（语法错误等）抛错。 */
export function pluginHitLines(plugin: string, relativePath: string, source: string): number[] {
	const dir = mkdtempSync(join(tmpdir(), "sfly-plugin-lint-"));
	try {
		const file = join(dir, relativePath);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, source);
		writeFileSync(
			join(dir, "biome.json"),
			JSON.stringify({
				vcs: { enabled: false },
				files: { includes: ["**"] },
				linter: { rules: { recommended: false } },
				plugins: [join(repoRoot, "biome-plugins", `${plugin}.grit`)],
			}),
		);
		let diagnostics: Diagnostic[] = [];
		for (let attempt = 1; attempt <= 5; attempt++) {
			const result = spawnSync(
				join(repoRoot, "node_modules", ".bin", "biome"),
				["lint", `--config-path=${dir}`, "--reporter=json", dir],
				{ cwd: dir, encoding: "utf8" },
			);
			try {
				diagnostics = (JSON.parse(result.stdout) as { diagnostics: Diagnostic[] }).diagnostics;
			} catch {
				throw new Error(
					`biome lint 没有给出 JSON 报告（退出码 ${result.status}）：\n${result.stderr}`,
				);
			}
			if (!diagnostics.some(isWorkspaceRace)) break;
		}
		const others = diagnostics.filter((d) => d.category !== "plugin");
		if (others.length > 0) {
			throw new Error(
				`规则以外的诊断：${others.map((d) => `${d.category}: ${d.message}`).join("；")}`,
			);
		}
		return diagnostics
			.map((d) => d.location?.start.line ?? 0)
			.filter((line) => line > 0)
			.sort((a, b) => a - b);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
