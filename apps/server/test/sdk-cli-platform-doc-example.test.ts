// 「用命令行操作平台」页「编辑场景」里的完整场景文档示例（#320）：它同时是 sfly-platform skill 的参考文档，
// AI 编程助手照它写场景。真实的 sfly 进程对着测试控制面，`scenario create --from` 经过本地和服务端的校验、
// 不产生警告，`scenario show` 列出显示名称、备注、注释框和入口参数说明。
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "./support/agent-binary.js";
import { sfly } from "./support/sfly-cli.js";
import { makeTempDir } from "./support/temp-dir.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

interface Param {
	name: string;
	description?: string;
}
interface ExampleNode {
	id: string;
	kind: string;
	name?: string;
	display_name?: string;
	note?: string;
	params?: Param[] | Record<string, unknown>;
}
interface ExampleAnnotation {
	id: string;
	title: string;
	note?: string;
	nodes: string[];
	subflows: string[];
}
interface Example {
	nodes: ExampleNode[];
	annotations: ExampleAnnotation[];
}

/** 「编辑场景」一节里的场景文档示例：这一节唯一的 json 代码块，文件的顶层只有 `document`。 */
async function exampleFile(): Promise<{ text: string; document: Example }> {
	const page = await readFile(join(repoRoot, "docs/guide/platform-cli.md"), "utf8");
	const section = /^## 编辑场景\n([\s\S]*?)(?=^## )/m.exec(page)?.[1] ?? "";
	const blocks = [...section.matchAll(/^```json\n([\s\S]*?)^```$/gm)].map((m) => m[1] ?? "");
	expect(blocks, "「编辑场景」一节要有且只有一个 json 示例").toHaveLength(1);
	const text = blocks[0] ?? "";
	return { text, document: (JSON.parse(text) as { document: Example }).document };
}

const firstLine = (text: string) => text.split("\n", 1)[0] ?? "";
const paramsOf = (node: ExampleNode): Param[] => (Array.isArray(node.params) ? node.params : []);

describe("「用命令行操作平台」页的场景文档示例 → sfly scenario create / show", () => {
	let cp: TestControlPlane;
	let dir: string;
	let cliVersion: string;
	let example: { text: string; document: Example };
	const cli = (...args: string[]) => sfly([...args, "--server", cp.httpUrl]);

	beforeAll(async () => {
		cliVersion = (await sfly(["--version"])).stdout.trim().replace(/^sfly /, "");
		cp = await startTestControlPlane({ version: cliVersion });
		dir = await makeTempDir("sfly-doc-example-");
		example = await exampleFile();
	}, 120_000);

	afterAll(async () => {
		await cp?.close();
		await rm(dir, { recursive: true, force: true });
	});

	it("示例带着显示名称、备注、注释框，入口和子流程入口的参数都有说明；注释框的成员有节点也有子流程", () => {
		const { nodes, annotations } = example.document;
		expect(nodes.filter((n) => n.kind !== "subflow_entry").every((n) => n.display_name)).toBe(true);
		expect(nodes.some((n) => n.note)).toBe(true);
		for (const kind of ["entry", "subflow_entry"]) {
			const params = nodes.filter((n) => n.kind === kind).flatMap(paramsOf);
			expect(params.length, kind).toBeGreaterThan(0);
			expect(
				params.every((p) => p.description),
				kind,
			).toBe(true);
		}
		expect(annotations.length).toBeGreaterThan(0);
		expect(annotations.some((a) => a.note)).toBe(true);
		expect(annotations.some((a) => a.nodes.length > 0)).toBe(true);
		expect(annotations.some((a) => a.subflows.length > 0)).toBe(true);
	});

	it("scenario create --from：本地校验和控制面的校验都通过；保存警告只有测试控制面里没有发布示例引用的节点包", async () => {
		const file = join(dir, "example.scenario.json");
		await writeFile(file, example.text);

		const created = await cli("scenario", "create", "--name", "文档示例", "--from", file, "--json");

		expect(created.code, created.stderr).toBe(0);
		expect(created.stderr).toBe("");
		const json = JSON.parse(created.stdout) as {
			name: string;
			head_version: number;
			warnings: { code: string }[];
		};
		expect(json).toMatchObject({ name: "文档示例", head_version: 1 });
		expect(json.warnings.filter((w) => w.code !== "package_version_missing")).toEqual([]);
	});

	it("scenario show：列出每个节点的显示名称、备注，每个注释框的标题、成员和备注，每个入口参数的说明", async () => {
		const shown = await cli("scenario", "show", "文档示例");
		expect(shown.code, shown.stderr).toBe(0);
		const text = shown.stdout;
		const { nodes, annotations } = example.document;

		for (const node of nodes) {
			// 入口节点不在节点表里，`scenario show` 不列它的显示名称。
			if (node.display_name && node.kind !== "entry") {
				expect(text, `节点 ${node.id} 的显示名称`).toContain(node.display_name);
			}
			if (node.note) expect(text, `节点 ${node.id} 的备注`).toContain(firstLine(node.note));
			for (const param of paramsOf(node)) {
				if (param.description)
					expect(text, `参数 ${param.name} 的说明`).toContain(param.description);
			}
		}
		const section = text.slice(text.indexOf("注释框："));
		for (const annotation of annotations) {
			expect(section, `注释框 ${annotation.id}`).toContain(
				`${annotation.title}（${annotation.id}）`,
			);
			if (annotation.note) expect(section).toContain(firstLine(annotation.note));
			for (const id of annotation.nodes)
				expect(section, `${annotation.id} 的成员 ${id}`).toContain(id);
		}
	});

	it("scenario show --json：显示名称、备注、注释框和参数说明和文档里写的一样", async () => {
		const shown = await cli("scenario", "show", "文档示例", "--json");
		expect(shown.code, shown.stderr).toBe(0);
		const json = JSON.parse(shown.stdout) as {
			annotations: ExampleAnnotation[];
			params: Param[];
			nodes: { id: string; display_name?: string; note?: string }[];
		};
		const { nodes, annotations } = example.document;

		expect(json.annotations).toEqual(annotations);
		const entry = nodes.find((n) => n.kind === "entry");
		expect(json.params.map((p) => [p.name, p.description])).toEqual(
			paramsOf(entry as ExampleNode).map((p) => [p.name, p.description]),
		);
		for (const node of json.nodes) {
			const written = nodes.find((n) => n.id === node.id);
			expect(node.display_name, node.id).toBe(written?.display_name);
			expect(node.note, node.id).toBe(written?.note);
		}
	});
});
