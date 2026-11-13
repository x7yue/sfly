import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { repoRoot } from "./agent-binary.js";

/** 用户文档里一段 ```ts 示例代码：`line` 是代码第一行在 Markdown 里的行号（从 1 开始）。 */
export interface ExampleBlock {
	line: number;
	code: string;
}

/** 页面里的 ```ts 代码块，按出现顺序；列表里缩进的代码块去掉缩进。 */
export function typeScriptBlocks(markdown: string): ExampleBlock[] {
	const lines = markdown.split("\n");
	const blocks: ExampleBlock[] = [];
	for (let i = 0; i < lines.length; i++) {
		const open = /^( *)```ts$/.exec(lines[i] ?? "");
		if (!open) continue;
		const indent = open[1] ?? "";
		const end = lines.findIndex((l, j) => j > i && l === `${indent}\`\`\``);
		if (end < 0) throw new Error(`第 ${i + 1} 行的代码块没有结束`);
		const body = lines
			.slice(i + 1, end)
			.map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l));
		blocks.push({ line: i + 2, code: body.join("\n") });
		i = end;
	}
	return blocks;
}

/** 读者项目常见的严格设置：浏览器页面，没有 Node 的类型。 */
const COMPILER_OPTIONS = {
	target: "ES2022",
	module: "ESNext",
	moduleResolution: "Bundler",
	lib: ["ES2023", "DOM"],
	types: [],
	strict: true,
	noUncheckedIndexedAccess: true,
	noEmit: true,
	skipLibCheck: true,
};

/**
 * 像读者那样从上往下照抄：页面的 ```ts 代码块按顺序拼成 `project` 目录里的一个模块，从那里解析 `@sfly/client`，
 * 返回这个模块的类型错误，每条写明在 `page` 的第几行。
 */
export function typecheckExamples(markdown: string, page: string, project: string): string[] {
	const blocks = typeScriptBlocks(markdown);
	const offsets: Array<{ start: number; line: number }> = [];
	let source = "";
	for (const block of blocks) {
		offsets.push({ start: source.split("\n").length - 1, line: block.line });
		source += `${block.code}\n`;
	}
	const file = join(project, `${page.replace(/\.md$/, "")}.examples.ts`);
	ts.sys.writeFile(file, source);
	const { options, errors } = ts.convertCompilerOptionsFromJson(COMPILER_OPTIONS, project);
	if (errors.length > 0)
		throw new Error(ts.flattenDiagnosticMessageText(errors[0]?.messageText, "\n"));
	const program = ts.createProgram([file], options);
	return ts.getPreEmitDiagnostics(program, program.getSourceFile(file)).map((d) => {
		const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
		if (d.file?.fileName !== file || d.start === undefined) return message;
		const generated = d.file.getLineAndCharacterOfPosition(d.start).line;
		const block = offsets.findLast((o) => o.start <= generated);
		return `${page}:${block ? block.line + generated - block.start : "?"}: ${message}`;
	});
}

/** 一个临时的读者项目：`node_modules/@sfly/client` 指向仓库里的 API 客户端。 */
export async function workspaceClientProject(): Promise<{ dir: string; close(): Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "sfly-doc-examples-"));
	await mkdir(join(dir, "node_modules", "@sfly"), { recursive: true });
	await symlink(join(repoRoot, "packages", "client"), join(dir, "node_modules", "@sfly", "client"));
	await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
	return { dir, close: () => rm(dir, { recursive: true, force: true }) };
}
