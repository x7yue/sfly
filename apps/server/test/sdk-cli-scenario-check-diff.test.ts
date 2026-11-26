// sfly scenario check / push --strict / diff（#424）：真实的 sfly 进程检查、对比测试控制面里的场景。
// 检查和保存走同一段校验（控制面的 POST /orchestrations/:id/check），对比用控制面的 diffDocuments。
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { publishPackage } from "./support/package-archive.js";
import { createPresetOk } from "./support/presets.js";
import { startRecordingProxy } from "./support/recording-proxy.js";
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
					`这次改动带进来 1 条警告（对照场景 ${id} 的版本 1）：push 照常保存，push --strict 不保存。`,
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
			expect(body.warnings.map((w: { existing: boolean }) => w.existing)).toEqual([false]);
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

	describe("改动之前就有的警告不挡住这次改动", () => {
		/** 入口带一个写了默认值的 secret 参数：最新版本里就有一条 secret_param_default 警告。 */
		const withSecretDefault = (): Doc => {
			const doc = cleanDocument();
			(doc.nodes[0] as { params?: unknown[] }).params = [
				{ name: "token", type: "string", secret: true, default: "s3cr3t-default" },
			];
			return doc;
		};
		const rename = (doc: Doc) => {
			doc.nodes[1] = { ...doc.nodes[1], display_name: "探测一下" } as Node;
		};

		it("只改显示名称：check 退出码 0，原来的警告单独列出、写明改动之前就有；push --strict 照常保存", async () => {
			const id = await api.orchestrationWith(withSecretDefault(), "已有警告-改名");
			const file = await pulled(id, rename);
			const [existing] = await warningsOf(id, file);

			const result = await cli("scenario", "check", file);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toBe(
				[
					`这次改动没有带进来警告（对照场景 ${id} 的版本 1）。`,
					"改动之前就有的警告（1，不是这次改动带进来的，不影响退出码）：",
					`  ${existing}`,
					"保存之后相对版本 1 的改动：",
					"  节点：",
					"    ~ 探测一下（probe）",
					'        display_name："探测接口" → "探测一下"',
					"",
				].join("\n"),
			);
			const json = JSON.parse((await cli("scenario", "check", file, "--json")).stdout);
			expect(json.ok).toBe(true);
			expect(json.warnings).toMatchObject([{ code: "secret_param_default", existing: true }]);

			const strict = await cli("scenario", "push", file, "--strict");
			expect(strict.code, strict.stderr).toBe(0);
			expect(strict.stdout).toContain(`已保存场景 ${id} 的版本 2`);
			expect(strict.stdout).toContain(`改动之前就有的警告（1）：\n  ${existing}`);
			expect(await versionCount(id)).toBe(2);
		});

		it("再带进来一条：check 退出码 4、push --strict 不保存，新的和原来就有的各在各的段里", async () => {
			const id = await api.orchestrationWith(withSecretDefault(), "已有警告-新加");
			const file = await pulled(id, (doc) => {
				rename(doc);
				doc.packages = { demo: "9.9.9" };
			});
			const messages = await warningsOf(id, file);
			const fresh = messages.find((m) => m.includes("9.9.9")) as string;
			const existing = messages.find((m) => m !== fresh) as string;

			const result = await cli("scenario", "check", file);
			expect(result.code).toBe(EXIT_WARNINGS);
			expect(result.stdout).toContain(
				[
					`这次改动带进来 1 条警告（对照场景 ${id} 的版本 1）：push 照常保存，push --strict 不保存。`,
					`  ${fresh}`,
					"改动之前就有的警告（1，不是这次改动带进来的，不影响退出码）：",
					`  ${existing}`,
				].join("\n"),
			);

			const strict = await cli("scenario", "push", file, "--strict");
			expect(strict.code).toBe(EXIT_WARNINGS);
			expect(strict.stdout).toBe(
				[
					`没有保存：这次改动带进来 1 条警告（--strict），场景 ${id} 仍是版本 1。`,
					`  ${fresh}`,
					"改动之前就有的警告（1，不是这次改动带进来的）：",
					`  ${existing}`,
					"改掉这些警告再 push；要带着警告保存，去掉 --strict。",
					"",
				].join("\n"),
			);
			expect(await versionCount(id)).toBe(1);
		});

		it("检查通过之后、保存之前带进来了新的警告：保存在控制面那一侧拒绝（strict 在同一个事务里判断），不保存", async () => {
			const withEnv = cleanDocument();
			(withEnv.nodes[0] as { params?: unknown[] }).params = [{ name: "env", type: "string" }];
			const id = await api.orchestrationWith(withEnv, "严格保存-中途变化");
			const file = await pulled(id, (doc) => {
				// 改掉入口参数：这时还没有运行预设，检查没有警告
				(doc.nodes[0] as { params?: unknown[] }).params = [{ name: "stage", type: "string" }];
			});
			const proxy = await startRecordingProxy(cp.httpUrl, async (request) => {
				// 检查之后、保存之前：有人建了一个用旧参数的运行预设，保存会让它失效
				if (request.method === "POST" && request.path.endsWith("/versions")) {
					await createPresetOk(api, id, { name: "生产", params: [{ name: "env", value: "prod" }] });
				}
			});
			try {
				const result = await sfly(["scenario", "push", file, "--strict", "--server", proxy.url]);
				expect(result.code).toBe(EXIT_WARNINGS);
				expect(result.stdout).toContain("没有保存：这次改动带进来 1 条警告（--strict）");
				expect(result.stdout).toContain("运行预设「生产」已失效");
				expect(proxy.requests.map((r) => `${r.method} ${r.path.replace(id, ":id")}`)).toEqual([
					"POST /orchestrations/:id/check",
					"POST /orchestrations/:id/versions",
				]);
			} finally {
				await proxy.close();
			}
			expect(await versionCount(id)).toBe(1);
		});

		it("连到不支持 --strict 的旧控制面（没有检查接口）：报错，不保存", async () => {
			const id = await api.orchestrationWith(cleanDocument(), "严格保存-旧控制面");
			const file = await pulled(id, addNotify);
			const requests: string[] = [];
			const old = createServer((req, res) => {
				requests.push(`${req.method} ${req.url}`);
				res.writeHead(404, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						error: { code: "not_found", message: `route ${req.method} ${req.url} not found` },
					}),
				);
			});
			await new Promise<void>((resolve) => old.listen(0, "127.0.0.1", resolve));
			const url = `http://127.0.0.1:${(old.address() as AddressInfo).port}`;
			try {
				const result = await sfly(["scenario", "push", file, "--strict", "--server", url]);
				expect(result.code).toBe(2);
				expect(result.stdout).toBe("");
				expect(result.stderr).toContain("这个控制面不支持 --strict");
				expect(requests).toEqual([`POST /orchestrations/${id}/check`]);
			} finally {
				await new Promise((resolve) => old.close(resolve));
			}
			expect(await versionCount(id)).toBe(1);
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
					`没有保存：这次改动带进来 1 条警告（--strict），场景 ${id} 仍是版本 1。`,
					`  ${expected[0]}`,
					"改掉这些警告再 push；要带着警告保存，去掉 --strict。",
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

		it("--file 的文件基于的不是最新版本：差异照常列出，另外提示 push 会冲突、差异里混着撤销别人改动的部分", async () => {
			const scenarioId = await api.orchestrationWith(cleanDocument(), "对比-旧文件");
			const file = await pulled(scenarioId, addNotify);
			await api.saveVersion(scenarioId, cleanDocument(), "bob");
			const result = await cli("scenario", "diff", scenarioId, "--file", file);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toContain(`场景「对比-旧文件」最新版本 2 → 文件 ${file}：`);
			// 提示接在输出的最后（--json 时写到 stderr），和其他命令的提示一样
			const note =
				"注意：文件基于版本 1，最新版本是 2：push 这个文件会报版本冲突；" +
				"上面的差异是最新版本和文件比，版本 1 之后别人的改动在这里会显示成被撤销。" +
				`先 sfly scenario diff ${scenarioId} 1 2 看别人改了什么`;
			expect(result.stdout.endsWith(`\n${note}\n`)).toBe(true);
			const json = JSON.parse(
				(await cli("scenario", "diff", scenarioId, "--file", file, "--json")).stdout,
			);
			expect(json).toMatchObject({ from: 2, file, file_base_version: 1 });
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
