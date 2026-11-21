// pi（`@earendil-works/*`）只能被助手服务依赖（ADR 0027）。引入的写法由 lint 规则 biome-plugins/pi-only-in-assistant.grit 拦
// （它的自测在 biome-plugins.test.ts）；这里检查规则看不见的两处：
//   - `package.json` 的依赖：只有 apps/assistant/package.json 可以把 pi 的包写进依赖（#552 删除评测集臂 B 之前，
//     evals/assistant/remote-tools/ 也可以）；
//   - 三斜线指令 `/// <reference types="…" />`：注释不在语法树里，规则匹配不到。
// 规则管不了的写法还有拼出来的包名，那一种静态检查做不到。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./support/agent-binary.js";

const PI_SCOPE = "@earendil-works/";

/** 可以依赖 pi 的目录（仓库根下的路径前缀）：助手服务；评测集臂 B 的原型扩展（#552 删除臂 B 时一起删掉这一项）。 */
const ALLOWED = ["apps/assistant/", "evals/assistant/remote-tools/"] as const;

const allowed = (path: string) => ALLOWED.some((prefix) => path.startsWith(prefix));

const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
] as const;

interface Manifest {
	path: string;
	json: Record<string, unknown>;
}

/**
 * 不在允许的目录里、却把 pi 的包写进依赖的 `package.json`：依赖名是 pi 的包，或者别名的值指向 pi 的包
 * （`"x": "npm:@earendil-works/…"`）。返回每一处的说明。
 */
function piDependencyProblems(manifests: readonly Manifest[]): string[] {
	const problems: string[] = [];
	for (const { path, json } of manifests) {
		if (allowed(path)) continue;
		for (const field of DEPENDENCY_FIELDS) {
			const dependencies = json[field];
			if (typeof dependencies !== "object" || dependencies === null) continue;
			for (const [name, spec] of Object.entries(dependencies)) {
				if (name.startsWith(PI_SCOPE) || (typeof spec === "string" && spec.includes(PI_SCOPE))) {
					problems.push(`${path} 的 ${field} 里有 ${name}（${String(spec)}）`);
				}
			}
		}
	}
	return problems;
}

interface Source {
	path: string;
	text: string;
}

const TRIPLE_SLASH_REFERENCE = /^\s*\/\/\/\s*<reference\b[^>]*@earendil-works\//;

/** 不在允许的目录里、却用三斜线指令引用 pi 的包的源文件：返回「路径:行号」。 */
function piReferenceProblems(sources: readonly Source[]): string[] {
	const problems: string[] = [];
	for (const { path, text } of sources) {
		if (allowed(path)) continue;
		text.split("\n").forEach((line, index) => {
			if (TRIPLE_SLASH_REFERENCE.test(line)) problems.push(`${path}:${index + 1}`);
		});
	}
	return problems;
}

describe("pi 只能被 apps/assistant 依赖：规则看不见的两处（样例）", () => {
	const pkg = (fields: Record<string, unknown>) => fields;

	it("package.json 的依赖：该拦的", () => {
		const hit = (path: string, json: Record<string, unknown>) =>
			piDependencyProblems([{ path, json }]);
		expect(
			hit("apps/server/package.json", pkg({ dependencies: { "@earendil-works/pi-ai": "^1.0.0" } })),
		).toHaveLength(1);
		expect(
			hit(
				"packages/schema/package.json",
				pkg({ devDependencies: { "@earendil-works/pi-coding-agent": "1.2.3" } }),
			),
		).toHaveLength(1);
		expect(
			hit("apps/web/package.json", pkg({ peerDependencies: { "@earendil-works/pi-ai": "*" } })),
		).toHaveLength(1);
		expect(
			hit("package.json", pkg({ optionalDependencies: { "@earendil-works/pi-ai": "*" } })),
		).toHaveLength(1);
		// 别名：名字是别的，值指向 pi 的包。
		expect(
			hit(
				"apps/server/package.json",
				pkg({ dependencies: { agent: "npm:@earendil-works/pi-ai@1" } }),
			),
		).toHaveLength(1);
		// 路径里只是含有 apps/assistant 这几个字（不是仓库根上的 apps/assistant/）：不是例外。
		expect(
			hit(
				"apps/server/src/apps/assistant/package.json",
				pkg({ dependencies: { "@earendil-works/pi-ai": "*" } }),
			),
		).toHaveLength(1);
	});

	it("package.json 的依赖：不该拦的", () => {
		const miss = (path: string, json: Record<string, unknown>) =>
			piDependencyProblems([{ path, json }]);
		// 助手服务和评测集臂 B 的原型扩展可以。
		const pi = pkg({ dependencies: { "@earendil-works/pi-coding-agent": "1.2.3" } });
		expect(miss("apps/assistant/package.json", pi)).toEqual([]);
		expect(miss("evals/assistant/remote-tools/package.json", pi)).toEqual([]);
		// 别的依赖、没有依赖、相近的作用域名。
		expect(
			miss("apps/server/package.json", pkg({ dependencies: { zod: "4.6.7", "@earendil/x": "1" } })),
		).toEqual([]);
		expect(miss("apps/server/package.json", pkg({ name: "@sfly/server" }))).toEqual([]);
		// 名字里提到不算依赖（scripts、description）。
		expect(
			miss(
				"apps/server/package.json",
				pkg({
					description: "不依赖 @earendil-works/pi-ai",
					scripts: { x: "echo @earendil-works/" },
				}),
			),
		).toEqual([]);
	});

	it("三斜线指令：该拦的", () => {
		const hit = (path: string, text: string) => piReferenceProblems([{ path, text }]);
		expect(
			hit("apps/server/src/types.d.ts", '/// <reference types="@earendil-works/pi-ai" />\n'),
		).toEqual(["apps/server/src/types.d.ts:1"]);
		expect(
			hit(
				"packages/schema/src/x.ts",
				"export {};\n  ///<reference path='@earendil-works/pi-ai/x.d.ts'/>",
			),
		).toEqual(["packages/schema/src/x.ts:2"]);
		expect(
			hit("apps/web/src/y.ts", '/// <reference lib="x" types="@earendil-works/pi-ai" />'),
		).toEqual(["apps/web/src/y.ts:1"]);
		// 目录名相同但不在仓库根上：不是例外。
		expect(
			hit("apps/server/src/apps/assistant/z.ts", '/// <reference types="@earendil-works/pi-ai" />'),
		).toEqual(["apps/server/src/apps/assistant/z.ts:1"]);
	});

	it("三斜线指令：不该拦的", () => {
		const miss = (path: string, text: string) => piReferenceProblems([{ path, text }]);
		const reference = '/// <reference types="@earendil-works/pi-ai" />';
		expect(miss("apps/assistant/src/types.d.ts", reference)).toEqual([]);
		expect(miss("evals/assistant/remote-tools/types.d.ts", reference)).toEqual([]);
		// 别的包的三斜线指令、写在字符串里或普通注释里的包名。
		expect(miss("apps/server/src/a.ts", '/// <reference types="node" />')).toEqual([]);
		expect(
			miss("apps/server/src/b.ts", '// see @earendil-works/pi-ai\nconst x = "@earendil-works/";'),
		).toEqual([]);
	});
});

/** 仓库里的文件（含还没提交的新文件，不含被忽略的）。 */
function repoFiles(patterns: readonly string[]): string[] {
	const result = spawnSync(
		"git",
		["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...patterns],
		{ cwd: repoRoot, encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(`git ls-files 失败：${result.stderr}`);
	return result.stdout.split("\0").filter((path) => path !== "");
}

describe("pi 只能被 apps/assistant 依赖：仓库里现在的样子", () => {
	it("只有 apps/assistant/package.json（和 #552 删掉之前的评测集臂 B）把 pi 的包写进依赖", () => {
		const manifests = repoFiles(["package.json", "**/package.json"])
			.filter((path) => !path.includes("node_modules/"))
			.map((path) => ({
				path,
				json: JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as Record<string, unknown>,
			}));
		expect(manifests.length).toBeGreaterThan(3);
		expect(piDependencyProblems(manifests)).toEqual([]);
	});

	it("只有 apps/assistant（和 #552 删掉之前的评测集臂 B）用三斜线指令引用 pi 的包", () => {
		const sources = repoFiles(["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.mjs", "*.cjs"]).map(
			(path) => ({ path, text: readFileSync(join(repoRoot, path), "utf8") }),
		);
		expect(sources.length).toBeGreaterThan(100);
		expect(piReferenceProblems(sources)).toEqual([]);
	});
});
