// sfly scenario check / push --strict / diff（#424）：真实的 sfly 进程检查、对比测试控制面里的场景。
// 检查和保存走同一段校验（控制面的 POST /orchestrations/:id/check），对比用控制面的 diffDocuments。
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { publishPackage } from "./support/package-archive.js";
import { sfly } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 检查只有警告时的退出码：不是 0（成功）、1（运行失败）、2（命令出错）、3（运行被取消）、124、130。 */
const EXIT_WARNINGS = 4;

type Node = Record<string, unknown> & { id: string };
interface Doc {
	default_agent: string;
	nodes: Node[];
	edges: Array<{ from: string; to: string; kind: string }>;
	packages: Record<string, string>;
}

const echo = (id: string, extra: Record<string, unknown> = {}): Node => ({
	id,
	kind: "package",
	package: "demo",
	node: "echo",
	...extra,
});

/** 入口和一个包节点：锁定的包版本已发布，保存时没有警告。 */
const cleanDocument = (): Doc => ({
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [], position: { x: 40, y: 40 } },
		echo("probe", { display_name: "探测接口", inputs: { v: "a" }, position: { x: 300, y: 40 } }),
	],
	edges: [{ from: "entry", to: "probe", kind: "chain" }],
	packages: { demo: "1.0.0" },
});

interface ScenarioFile {
	scenario: string;
	base_version: number;
	document: Doc;
}

describe("sfly scenario check / push --strict / diff → 控制面", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let dir: string;
	let fileCount = 0;
	const cli = (...args: string[]) => sfly([...args, "--server", cp.httpUrl]);

	const versionCount = async (id: string) =>
		(await api.getJson<{ versions: unknown[] }>(`/orchestrations/${id}/versions`)).versions.length;

	/** pull 到一个新文件，改文档后写回，返回文件路径。 */
	const pulled = async (id: string, change: (doc: Doc) => void = () => {}): Promise<string> => {
		const file = join(dir, `scenario-${++fileCount}.json`);
		const result = await cli("scenario", "pull", id, "-o", file);
		expect(result.code, result.stderr).toBe(0);
		const content = JSON.parse(await readFile(file, "utf8")) as ScenarioFile;
		change(content.document);
		await writeFile(file, JSON.stringify(content, null, 2));
		return file;
	};

	/** 文件里的文档在控制面上检查出的警告消息（和保存时一样）。 */
	const warningsOf = async (id: string, file: string): Promise<string[]> => {
		const { document } = JSON.parse(await readFile(file, "utf8")) as ScenarioFile;
		const res = await api.post(`/orchestrations/${id}/check`, { document });
		expect(res.status).toBe(200);
		return ((await res.json()) as { warnings: Array<{ message: string }> }).warnings.map(
			(w) => w.message,
		);
	};

	/** 加一个节点和一条连线（有显示名称）；包版本锁到一个没发布的版本（有警告）。 */
	const addNotify = (doc: Doc) => {
		doc.nodes.push(echo("notify", { display_name: "通知", inputs: { v: "n" } }));
		doc.edges.push({ from: "probe", to: "notify", kind: "chain" });
	};

	beforeAll(async () => {
		const version = (await sfly(["--version"])).stdout.trim().replace(/^sfly /, "");
		cp = await startTestControlPlane({ version });
		api = new ApiClient(cp);
		await publishPackage(cp, "demo", "1.0.0", { echo: ["v"] });
		await publishPackage(cp, "demo", "1.1.0", { echo: ["v"] });
		dir = await mkdtemp(join(tmpdir(), "sfly-scenario-check-"));
	}, 120_000);

	afterAll(async () => {
		await cp?.close();
		await rm(dir, { recursive: true, force: true });
	});

	describe("check", () => {
		it("没有问题：退出码 0，写明没有警告，列出保存之后的改动；不产生版本", async () => {
			const id = await api.orchestrationWith(cleanDocument(), "检查-没有问题");
			const file = await pulled(id, addNotify);
			const result = await cli("scenario", "check", file);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toBe(
				[
					`文档没有问题：没有警告（对照场景 ${id} 的版本 1）。`,
					"保存之后相对版本 1 的改动：",
					"  节点：",
					"    + 通知（notify）  package",
					"  连线：",
					"    + probe → notify（chain）",
					"",
				].join("\n"),
			);
			expect(await versionCount(id)).toBe(1);

			const same = await cli("scenario", "check", await pulled(id));
			expect(same.code, same.stderr).toBe(0);
			expect(same.stdout).toBe(
				[`文档没有问题：没有警告（对照场景 ${id} 的版本 1）。`, "和版本 1 相比没有改动。", ""].join(
					"\n",
				),
			);
		});

		it("只有警告：专门的退出码，列出和保存时相同的警告；不产生版本", async () => {
			const id = await api.orchestrationWith(cleanDocument(), "检查-只有警告");
			const file = await pulled(id, (doc) => {
				doc.packages = { demo: "9.9.9" };
			});
			const expected = await warningsOf(id, file);
			expect(expected).toHaveLength(1);
			const result = await cli("scenario", "check", file);
			expect(result.code).toBe(EXIT_WARNINGS);
			expect(result.stderr).toBe("");
			expect(result.stdout).toBe(
				[
					`文档有 1 条警告（对照场景 ${id} 的版本 1）：push 照常保存，push --strict 不保存。`,
					`  ${expected[0]}`,
					"保存之后相对版本 1 的改动：",
					"  设置：",
					'    节点包 demo："1.0.0" → "9.9.9"',
					"",
				].join("\n"),
			);

			const json = await cli("scenario", "check", file, "--json");
			expect(json.code).toBe(EXIT_WARNINGS);
			const body = JSON.parse(json.stdout);
			expect(body).toMatchObject({ scenario: id, base_version: 1, ok: false });
			expect(body.warnings.map((w: { message: string }) => w.message)).toEqual(expected);
			expect(body.diff.settings).toEqual([
				{ path: "packages.demo", before: "1.0.0", after: "9.9.9" },
			]);
			expect(await versionCount(id)).toBe(1);
		});

		it("有错误：退出码 2，和其他命令出错一样写到 stderr；本地校验没通过时不发请求", async () => {
			const id = await api.orchestrationWith(cleanDocument(), "检查-有错误");
			const invalid = await pulled(id, (doc) => {
				doc.nodes.push({ id: "bad", kind: "package" });
			});
			const result = await cli("scenario", "check", invalid);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toMatch(/^错误：场景文档没有通过校验（\d+ 处），没有发请求：\n/);
			expect(result.stderr).toContain("（节点 bad）");

			// 控制面上的错误：编辑起点过期（和 push 一样报冲突，给出重新 pull 的命令）
			const stale = await pulled(id);
			await api.saveVersion(id, cleanDocument());
			const conflict = await cli("scenario", "check", stale);
			expect(conflict.code).toBe(2);
			expect(conflict.stdout).toBe("");
			expect(conflict.stderr).toContain("场景已有更新的版本：版本 2");
			expect(conflict.stderr).toContain("下一步：sfly scenario pull");

			const json = await cli("scenario", "check", stale, "--json");
			expect(json.code).toBe(2);
			expect(JSON.parse(json.stderr).error.code).toBe("version_conflict");
			expect(await versionCount(id)).toBe(2);
		});
	});

	describe("push --strict", () => {
		it("有警告时不保存：专门的退出码，列出警告；不加 --strict 照常保存", async () => {
			const id = await api.orchestrationWith(cleanDocument(), "严格保存-有警告");
			const file = await pulled(id, (doc) => {
				doc.packages = { demo: "9.9.9" };
			});
			const expected = await warningsOf(id, file);
			const before = await readFile(file, "utf8");

			const strict = await cli("scenario", "push", file, "--strict");
			expect(strict.code).toBe(EXIT_WARNINGS);
			expect(strict.stderr).toBe("");
			expect(strict.stdout).toBe(
				[
					`没有保存：文档有 1 条警告（--strict），场景 ${id} 仍是版本 1。`,
					`  ${expected[0]}`,
					"改掉警告再 push；要带着警告保存，去掉 --strict。",
					"",
				].join("\n"),
			);
			expect(await versionCount(id)).toBe(1);
			expect(await readFile(file, "utf8")).toBe(before);

			const json = await cli("scenario", "push", file, "--strict", "--json");
			expect(json.code).toBe(EXIT_WARNINGS);
			expect(JSON.parse(json.stdout)).toMatchObject({
				scenario: id,
				saved: false,
				base_version: 1,
			});
			expect(await versionCount(id)).toBe(1);

			const plain = await cli("scenario", "push", file);
			expect(plain.code, plain.stderr).toBe(0);
			expect(await versionCount(id)).toBe(2);
		});

		it("没有警告时照常保存", async () => {
			const id = await api.orchestrationWith(cleanDocument(), "严格保存-没有警告");
			const file = await pulled(id, addNotify);
			const result = await cli("scenario", "push", file, "--strict");
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toContain(`已保存场景 ${id} 的版本 2`);
			expect(await versionCount(id)).toBe(2);
		});
	});

	describe("diff", () => {
		let id: string;
		beforeAll(async () => {
			id = await api.orchestrationWith(cleanDocument(), "对比");
			const v2 = cleanDocument();
			addNotify(v2);
			await api.saveVersion(id, v2);
			const v3 = cleanDocument();
			(v3.nodes[1] as unknown as { inputs: Record<string, unknown> }).inputs.v = "b";
			v3.packages = { demo: "1.1.0" };
			await api.saveVersion(id, v3);
		});

		it("不写版本：对比最新的两个版本；新增、删除的节点写显示名称和节点 ID", async () => {
			const result = await cli("scenario", "diff", "对比");
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toBe(
				[
					"场景「对比」版本 2 → 版本 3：",
					"  设置：",
					'    节点包 demo："1.0.0" → "1.1.0"',
					"  节点：",
					"    - 通知（notify）  package",
					"    ~ 探测接口（probe）",
					'        inputs.v："a" → "b"',
					"  连线：",
					"    - probe → notify（chain）",
					"",
				].join("\n"),
			);
		});

		it("写两个版本：从第一个到第二个；--json 输出控制面的差异", async () => {
			const result = await cli("scenario", "diff", id, "1", "2", "--json");
			expect(result.code, result.stderr).toBe(0);
			const body = JSON.parse(result.stdout);
			expect(body).toMatchObject({ scenario: id, from: 1, to: 2 });
			expect(body.diff.nodes.added).toEqual([
				{ id: "notify", kind: "package", display_name: "通知" },
			]);
			expect(body.diff.edges.added).toEqual([{ from: "probe", to: "notify", kind: "chain" }]);

			const text = await cli("scenario", "diff", id, "1", "2");
			expect(text.stdout).toBe(
				[
					"场景「对比」版本 1 → 版本 2：",
					"  节点：",
					"    + 通知（notify）  package",
					"  连线：",
					"    + probe → notify（chain）",
					"",
				].join("\n"),
			);
		});

		it("只写一个版本：和最新版本比；两个版本相同时写明没有差异", async () => {
			const one = await cli("scenario", "diff", id, "3");
			expect(one.code, one.stderr).toBe(0);
			expect(one.stdout).toBe("场景「对比」版本 3 和版本 3 没有差异。\n");
			const json = await cli("scenario", "diff", id, "3", "3", "--json");
			expect(JSON.parse(json.stdout).diff).toEqual({
				settings: [],
				nodes: { added: [], removed: [], changed: [] },
				edges: { added: [], removed: [] },
				moved: [],
				annotations: { added: [], removed: [], changed: [] },
			});
		});

		it("--file：本地文件和最新版本比（保存之后的改动）", async () => {
			const file = await pulled(id, addNotify);
			const result = await cli("scenario", "diff", id, "--file", file);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toBe(
				[
					`场景「对比」最新版本 3 → 文件 ${file}：`,
					"  节点：",
					"    + 通知（notify）  package",
					"  连线：",
					"    + probe → notify（chain）",
					"",
				].join("\n"),
			);
		});

		it("版本不存在、只有一个版本、--file 和版本号一起写：退出码 2", async () => {
			const missing = await cli("scenario", "diff", id, "1", "9");
			expect(missing.code).toBe(2);
			expect(missing.stderr).toContain("没有版本 9，最新版本是 3");

			const single = await api.orchestrationWith(cleanDocument(), "对比-一个版本");
			const only = await cli("scenario", "diff", single);
			expect(only.code).toBe(2);
			expect(only.stderr).toContain("只有 1 个版本");

			const both = await cli("scenario", "diff", id, "1", "--file", "x.json");
			expect(both.code).toBe(2);
			expect(both.stderr).toContain("--file 和版本号不能一起写");
		});
	});
});
