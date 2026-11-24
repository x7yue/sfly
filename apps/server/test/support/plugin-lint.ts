// 用 biome-plugins/ 里的一条规则检查一段源码，返回命中的行号：测试要「按规则认的写法」判断一份源码，不是自己另写一套匹配。
// 源码放进临时目录里按指定的相对路径存放（规则按文件路径划范围，例如 apps/server/src/…），只加载这一条规则，关掉内置规则。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoRoot } from "./agent-binary.js";
import { type BiomeDiagnostic, retryOnWorkspaceRace } from "./biome-lint.js";

interface Diagnostic extends BiomeDiagnostic {
	location?: { path: string; start: { line: number } };
}

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
		const { diagnostics } = retryOnWorkspaceRace(() => {
			const result = spawnSync(
				join(repoRoot, "node_modules", ".bin", "biome"),
				["lint", `--config-path=${dir}`, "--reporter=json", dir],
				{ cwd: dir, encoding: "utf8" },
			);
			try {
				return {
					diagnostics: (JSON.parse(result.stdout) as { diagnostics: Diagnostic[] }).diagnostics,
				};
			} catch {
				throw new Error(
					`biome lint 没有给出 JSON 报告（退出码 ${result.status}）：\n${result.stderr}`,
				);
			}
		});
		const others = diagnostics.filter((d) => d.category !== "plugin");
		if (others.length > 0) {
			throw new Error(
				`规则以外的诊断：${others.map((d) => `${d.category}: ${d.message}`).join("；")}`,
			);
		}
		return diagnostics
			.map((d) => (d as Diagnostic).location?.start.line ?? 0)
			.filter((line) => line > 0)
			.sort((a, b) => a - b);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
