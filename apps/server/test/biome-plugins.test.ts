// 自定义 lint 规则（biome-plugins/*.grit）的自测。
//
// 这些规则匹配的是具体写法（deps.db、runsApi.get、#event……）：被拦的代码改了名，或者规则自己写坏了，
// 规则就静默地不再拦任何东西，没有哪个检查会报错。所以每个规则配两组样例，这里用真实的 biome 跑一遍：
//   biome-plugins/fixtures/<规则名>/hit/   应该命中。要命中的那一行，上一行写 `// @hit`（JSX 里写 `{/* @hit */}`）；
//   biome-plugins/fixtures/<规则名>/miss/  不应命中：同样的写法落在规则的范围之外，或者用了规则允许的写法。
// 样例文件按规则看的路径存放（例如 hit/apps/web/e2e/xxx.ts）：规则按文件路径划范围。
// fixtures/ 在 biome.json 的 files.includes 里被排除，`pnpm lint:ts` 不检查它们，否则「应该命中」的样例会让它失败。
// 每个规则单独跑一遍（只加载这一个规则），报出的诊断才对得上这个规则。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot } from "./support/agent-binary.js";
import { retryOnWorkspaceRace } from "./support/biome-lint.js";

const pluginsDir = join(repoRoot, "biome-plugins");
const fixturesDir = join(pluginsDir, "fixtures");
const biomeBin = join(repoRoot, "node_modules", ".bin", "biome");

const plugins = readdirSync(pluginsDir)
	.filter((name) => name.endsWith(".grit"))
	.map((name) => name.slice(0, -".grit".length))
	.sort();

/** 目录下的全部文件，路径相对于 dir。 */
function filesUnder(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(dir, join(entry.parentPath, entry.name)))
		.sort();
}

function subdirs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

const HIT_MARKER = /(?:\/\/|\{\/\*)\s*@hit\b/;

/** 文件里标了 `@hit` 的行的下一行：规则要在这一行报出诊断。 */
function expectedHitLines(file: string): number[] {
	const lines = readFileSync(file, "utf8").split("\n");
	const expected: number[] = [];
	lines.forEach((line, index) => {
		if (HIT_MARKER.test(line)) expected.push(index + 2);
	});
	return expected;
}

type Diagnostic = {
	category: string;
	message: string;
	location?: { path: string; start: { line: number } };
};

const scratch = mkdtempSync(join(tmpdir(), "sfly-biome-plugins-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** 只加载 `plugin` 这一个规则，用 biome lint 检查 `dir`，返回诊断和检查过的文件数。 */
function lint(plugin: string, dir: string): { diagnostics: Diagnostic[]; files: number } {
	const configDir = join(scratch, `${plugin}-${relative(fixturesDir, dir).replaceAll("/", "-")}`);
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "biome.json"),
		JSON.stringify({
			vcs: { enabled: false },
			files: { includes: ["**"] },
			// 关掉内置规则：诊断只来自这个规则。
			linter: { rules: { recommended: false } },
			plugins: [join(pluginsDir, `${plugin}.grit`)],
		}),
	);
	// biome 偶发工作区竞态（CPU 紧张时 `internalError/fs: The file does not exist in the workspace`，
	// 和规则、样例的内容无关），出现时重跑，见 support/biome-lint.ts。
	return retryOnWorkspaceRace(() => {
		const result = spawnSync(
			biomeBin,
			["lint", `--config-path=${configDir}`, "--reporter=json", dir],
			// 在样例目录里跑：biome 会先扫描工作目录里的全部文件，工作目录只有样例时扫描的范围小得多。
			// 诊断里的路径相对于工作目录。
			{ cwd: dir, encoding: "utf8" },
		);
		let report: { summary: { changed: number; unchanged: number }; diagnostics: Diagnostic[] };
		try {
			report = JSON.parse(result.stdout);
		} catch {
			throw new Error(
				`biome lint 没有给出 JSON 报告（退出码 ${result.status}）：\n${result.stderr}`,
			);
		}
		return {
			diagnostics: report.diagnostics,
			files: report.summary.changed + report.summary.unchanged,
		};
	});
}

/** 把诊断换成「相对 fixtures 的路径:行号」；诊断里的路径相对于 `dir`（biome 的工作目录）。 */
function placesOf(diagnostics: Diagnostic[], dir: string): string[] {
	return diagnostics
		.map(
			(d) =>
				`${relative(fixturesDir, resolve(dir, d.location?.path ?? "?"))}:${d.location?.start.line}`,
		)
		.sort();
}

describe("自定义 lint 规则（biome-plugins/）", () => {
	it("每个规则文件都登记在 biome.json 的 plugins 里", () => {
		const config = JSON.parse(readFileSync(join(repoRoot, "biome.json"), "utf8")) as {
			plugins?: string[];
		};
		const registered = (config.plugins ?? []).map((p) => p.replace(/^\.\//, "")).sort();
		const expected = plugins.map((name) => `biome-plugins/${name}.grit`);
		expect(
			registered,
			'biome-plugins/ 里的规则文件和 biome.json 的 plugins 不一致：新规则要在 plugins 里加一行 "./biome-plugins/<名字>.grit"，不然它不会生效；删掉规则文件时同时删掉这一行。',
		).toEqual(expected);
	});

	it("fixtures/ 里没有找不到规则的样例目录", () => {
		const orphans = subdirs(fixturesDir).filter((name) => !plugins.includes(name));
		expect(
			orphans,
			"biome-plugins/fixtures/ 下的目录名要和规则文件同名（biome-plugins/<名字>.grit）：规则改名或删除时，样例目录一起改名或删除。",
		).toEqual([]);
	});

	describe.each(plugins)("%s", (plugin) => {
		const hitDir = join(fixturesDir, plugin, "hit");
		const missDir = join(fixturesDir, plugin, "miss");
		const hitFiles = subdirs(join(fixturesDir, plugin)).includes("hit") ? filesUnder(hitDir) : [];
		const missFiles = subdirs(join(fixturesDir, plugin)).includes("miss")
			? filesUnder(missDir)
			: [];

		it("有应该命中和不应命中的样例", () => {
			const how = `新规则要配样例：在 biome-plugins/fixtures/${plugin}/hit/ 放会被命中的文件（命中的那一行上一行写 // @hit），在 miss/ 放同样写法但不该命中的文件（落在规则范围之外，或用了规则允许的写法）；目录结构按规则看的文件路径来（例如 hit/apps/web/e2e/xxx.ts）。`;
			expect(hitFiles, `${plugin}.grit 没有「应该命中」的样例。${how}`).not.toEqual([]);
			expect(missFiles, `${plugin}.grit 没有「不应命中」的样例。${how}`).not.toEqual([]);
		});

		it("应该命中的样例，每个 @hit 标出的行都被报出，没有多报", () => {
			if (hitFiles.length === 0) return;
			const expected = hitFiles
				.flatMap((file) =>
					expectedHitLines(join(hitDir, file)).map((line) => `${plugin}/hit/${file}:${line}`),
				)
				.sort();
			expect(
				expected,
				`biome-plugins/fixtures/${plugin}/hit/ 里没有 // @hit 标记：在每个会被命中的那一行的上一行写 // @hit（JSX 里写 {/* @hit */}）。`,
			).not.toEqual([]);

			const { diagnostics, files } = lint(plugin, hitDir);
			expect(
				diagnostics
					.filter((d) => d.category !== "plugin")
					.map((d) => `${d.category}: ${d.message}`),
				"样例文件里有规则以外的诊断（语法错误，或 biome-ignore 放行注释没有起作用）：规则没有真正跑到这些写法，先把样例改成能解析、放行写法和规则对得上的代码。",
			).toEqual([]);
			expect(
				files,
				"biome 没有检查全部样例文件（扩展名不认识，或被 biome.json 的忽略规则跳过）。",
			).toBe(hitFiles.length);
			expect(
				placesOf(diagnostics, hitDir),
				`biome-plugins/${plugin}.grit 报出的位置和样例里 // @hit 标出的不一致：规则匹配的写法改了、匹配条件写坏了，或样例没跟上规则；多报的位置说明规则拦了不该拦的写法。`,
			).toEqual(expected);

			// 规则里每一种写法有名字（`$form = "名字"`，诊断以 `[名字]` 开头）：样例要把每一种都命中过。只看位置，
			// 样例删掉一半、或者规则里新加了一种写法没配样例，这条测试照样绿，哪一种写法没有被守住也看不出来。
			const grit = readFileSync(join(pluginsDir, `${plugin}.grit`), "utf8");
			const declared = [
				...new Set([...grit.matchAll(/\$form = "([\w-]+)"/g)].map((m) => m[1])),
			].sort();
			if (declared.length > 0) {
				const reported = [
					...new Set(
						diagnostics.map(
							(d) => /^\[([\w-]+)\]/.exec(d.message)?.[1] ?? `（没有名字）${d.message}`,
						),
					),
				].sort();
				expect(
					reported,
					`biome-plugins/${plugin}.grit 里的每一种写法（$form 的名字）都要在 fixtures/${plugin}/hit/ 里有样例命中它：样例少了哪一种，或者规则里新加的写法没配样例，这里会不一致；报出的名字不在规则里说明诊断的写法和规则对不上。`,
				).toEqual(declared);
			}
		});

		it("不应命中的样例，一个诊断也没有", () => {
			if (missFiles.length === 0) return;
			for (const file of missFiles) {
				expect(
					expectedHitLines(join(missDir, file)),
					`${plugin}/miss/${file} 里有 // @hit 标记：「不应命中」的样例不标命中，要命中的样例放到 hit/ 下。`,
				).toEqual([]);
			}
			const { diagnostics, files } = lint(plugin, missDir);
			expect(
				diagnostics
					.filter((d) => d.category !== "plugin")
					.map((d) => `${d.category}: ${d.message}`),
				"样例文件里有规则以外的诊断（语法错误，或 biome-ignore 放行注释没有起作用）：规则没有真正跑到这些写法，先把样例改成能解析、放行写法和规则对得上的代码。",
			).toEqual([]);
			expect(
				files,
				"biome 没有检查全部样例文件（扩展名不认识，或被 biome.json 的忽略规则跳过）。",
			).toBe(missFiles.length);
			expect(
				placesOf(diagnostics, missDir),
				`biome-plugins/${plugin}.grit 拦了不该拦的写法：收窄规则的匹配条件，或确认这写法本来就该拦、把样例挪到 hit/。`,
			).toEqual([]);
		});
	});
});
