import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { repoRoot } from "./agent-binary.js";

export interface ExampleBlock {
	firstMarkdownLine: number;
	code: string;
}

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
		blocks.push({ firstMarkdownLine: i + 2, code: body.join("\n") });
		i = end;
	}
	return blocks;
}

const BROWSER_PAGE_COMPILER_OPTIONS = {
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

export function typecheckPageExamples(
	markdown: string,
	pageName: string,
	projectDir: string,
): string[] {
	const blocks = typeScriptBlocks(markdown);
	const offsets: Array<{ generatedLine: number; markdownLine: number }> = [];
	let source = "";
	for (const block of blocks) {
		offsets.push({
			generatedLine: source.split("\n").length - 1,
			markdownLine: block.firstMarkdownLine,
		});
		source += `${block.code}\n`;
	}
	const file = join(projectDir, `${pageName.replace(/\.md$/, "")}.examples.ts`);
	ts.sys.writeFile(file, source);
	const { options, errors } = ts.convertCompilerOptionsFromJson(
		BROWSER_PAGE_COMPILER_OPTIONS,
		projectDir,
	);
	if (errors.length > 0)
		throw new Error(ts.flattenDiagnosticMessageText(errors[0]?.messageText, "\n"));
	const program = ts.createProgram([file], options);
	return ts.getPreEmitDiagnostics(program, program.getSourceFile(file)).map((d) => {
		const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
		if (d.file?.fileName !== file || d.start === undefined) return message;
		const generated = d.file.getLineAndCharacterOfPosition(d.start).line;
		const block = offsets.findLast((o) => o.generatedLine <= generated);
		const line = block ? block.markdownLine + generated - block.generatedLine : "?";
		return `${pageName}:${line}: ${message}`;
	});
}

export async function workspaceClientProject(): Promise<{ dir: string; close(): Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "sfly-doc-examples-"));
	await mkdir(join(dir, "node_modules", "@sfly"), { recursive: true });
	await symlink(join(repoRoot, "packages", "client"), join(dir, "node_modules", "@sfly", "client"));
	await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
	return { dir, close: () => rm(dir, { recursive: true, force: true }) };
}
