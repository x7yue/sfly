// biome.json 的 overrides 作用在哪些路径上。
// 引用语法 `${{ ... }}`（GLOSSARY「引用」）在测试里写成字符串很常见，`noTemplateCurlyInString` 会把它当成写错的模板字符串；
// 测试目录整体关掉这条规则，而不是在每个文件顶上写 biome-ignore-all。应用代码（apps/web/src、apps/server/src）里仍然开着。
// 做法：把真实 biome.json 的 linter 和 overrides 原样放进临时目录的配置，在对应路径下放样例文件，用 biome lint 看报不报。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot } from "./support/agent-binary.js";

const biomeBin = join(repoRoot, "node_modules", ".bin", "biome");
const RULE = "lint/suspicious/noTemplateCurlyInString";
const REFERENCE = 'export const ref = "${{ steps.a.outputs.b }}";\n';

const real = JSON.parse(readFileSync(join(repoRoot, "biome.json"), "utf8")) as {
	linter: unknown;
	overrides?: unknown;
};

const scratch = mkdtempSync(join(tmpdir(), "sfly-biome-config-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
writeFileSync(
	join(scratch, "biome.json"),
	JSON.stringify({
		vcs: { enabled: false },
		files: { includes: ["**"] },
		linter: real.linter,
		overrides: real.overrides,
	}),
);

/** 在临时目录的 `path` 下放一个写着引用语法的文件，返回 biome lint 对它报出的规则。 */
function rulesReportedAt(path: string): string[] {
	mkdirSync(dirname(join(scratch, path)), { recursive: true });
	writeFileSync(join(scratch, path), REFERENCE);
	// 不用 --config-path：它会让 overrides 里 apps/web/e2e/** 这样带目录的匹配对不上路径。从临时目录起找 biome.json。
	const result = spawnSync(biomeBin, ["lint", "--reporter=json", path], {
		cwd: scratch,
		encoding: "utf8",
	});
	const report = JSON.parse(result.stdout) as { diagnostics: { category: string }[] };
	return report.diagnostics.map((d) => d.category);
}

describe("biome.json 对 noTemplateCurlyInString 的覆盖", () => {
	it.each([
		"apps/server/test/example.test.ts",
		"apps/server/test/support/example.ts",
		"packages/orchestration/test/example.test.ts",
		"apps/web/e2e/example.spec.ts",
	])("%s：引用语法写成字符串不报", (path) => {
		expect(
			rulesReportedAt(path),
			`${path} 里写 \${{ ... }} 不该报 ${RULE}：biome.json 的 overrides 要对 **/test/** 和 apps/web/e2e/** 关掉这条规则，不要在文件里写 biome-ignore。`,
		).not.toContain(RULE);
	});

	it.each([
		"apps/web/src/example.ts",
		"apps/server/src/example.ts",
	])("%s：应用代码里仍然报", (path) => {
		expect(
			rulesReportedAt(path),
			`${path} 里的 \${{ ... }} 应该报 ${RULE}：这条规则在应用代码里要保持开着，只在测试目录关掉。`,
		).toContain(RULE);
	});
});
