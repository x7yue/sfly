// sfly scenario edit（#470）：真实的 sfly 进程对测试控制面里的场景做局部编辑。
// 操作由控制面执行（POST /orchestrations/:id/edits 和 /edits/check），命令行只把参数变成操作、把结果写成文本。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { packageMetadata, publishPackage } from "./support/package-archive.js";
import { startRecordingProxy } from "./support/recording-proxy.js";
import { sfly } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 只有警告时的退出码（和 scenario check 一样）。 */
const EXIT_WARNINGS = 4;

/** 入口 → 取数据 → 出报告；锁定的包版本已发布，保存时没有警告。 */
const baseDocument = () => ({
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [], position: { x: 40, y: 40 } },
		{
			id: "fetch_data",
			kind: "package",
			package: "http",
			node: "get",
			display_name: "取数据",
			inputs: { url: "http://a.test" },
			position: { x: 340, y: 40 },
		},
		{
			id: "report",
			kind: "package",
			package: "http",
			node: "get",
			inputs: { url: "http://b.test" },
			position: { x: 640, y: 40 },
		},
	],
	edges: [
		{ from: "entry", to: "fetch_data", kind: "chain" },
		{ from: "fetch_data", to: "report", kind: "chain" },
	],
	packages: { http: "1.0.0" },
});

describe("sfly scenario edit → 控制面", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let dir: string;
	const cli = (...args: string[]) => sfly([...args, "--server", cp.httpUrl]);
	const versionCount = async (id: string) =>
		(await api.getJson<{ versions: unknown[] }>(`/orchestrations/${id}/versions`)).versions.length;
	const headDoc = async (id: string) =>
		(
			await api.getJson<{
				document: {
					nodes: Array<Record<string, unknown> & { id: string }>;
					edges: Array<{ from: string; to: string; kind: string }>;
				};
			}>(`/orchestrations/${id}/head`)
		).document;
	const scenario = (name: string) => api.orchestrationWith(baseDocument(), name);

	beforeAll(async () => {
		const version = (await sfly(["--version"])).stdout.trim().replace(/^sfly /, "");
		cp = await startTestControlPlane({ version });
		api = new ApiClient(cp);
		await publishPackage(cp, "http", "1.0.0", {
			get: {
				outputs: ["body"],
				inputs: { properties: { url: { type: "string" } }, required: ["url"] },
			},
			probe: {
				outputs: [],
				inputs: {
					properties: { host: { type: "string" }, count: { type: "integer" } },
					required: ["host", "count"],
				},
			},
		});
		dir = await mkdtemp(join(tmpdir(), "sfly-scenario-edit-ops-"));
	}, 120_000);

	afterAll(async () => {
		await cp?.close();
		await rm(dir, { recursive: true, force: true });
	});

	describe("一次一个操作", () => {
		it("add --after：存成新版本，输出新版本号和改动；输入的值按 JSON 解析，不是 JSON 的当字符串", async () => {
			const id = await scenario("编辑-加节点");
			const result = await cli(
				"scenario",
				"edit",
				"编辑-加节点",
				"add",
				"http/probe",
				"--after",
				"fetch_data",
				"--id",
				"probe",
				"--input",
				"host=api.test",
				"--input",
				"count=3",
				"--display-name",
				"探测接口",
			);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toBe(
				[
					"已保存场景「编辑-加节点」的版本 2（基于版本 1）：",
					"  节点：",
					"    + 探测接口（probe）  package",
					"  连线：",
					"    + fetch_data → probe（chain）",
					"    + probe → report（chain）",
					"    - fetch_data → report（chain）",
					"  只改了位置的节点：report",
					"",
				].join("\n"),
			);
			const probe = (await headDoc(id)).nodes.find((n) => n.id === "probe");
			expect(probe).toMatchObject({
				inputs: { host: "api.test", count: 3 },
				display_name: "探测接口",
			});
		});

		it("remove、connect、disconnect、set：各存一个版本", async () => {
			const id = await scenario("编辑-各种操作");
			const removed = await cli("scenario", "edit", id, "remove", "report");
			expect(removed.code, removed.stderr).toBe(0);
			expect(removed.stdout).toContain("    - report  package");

			const cut = await cli("scenario", "edit", id, "disconnect", "entry", "fetch_data");
			expect(cut.code, cut.stderr).toBe(0);
			expect(cut.stdout).toContain("    - entry → fetch_data（chain）");

			const joined = await cli("scenario", "edit", id, "connect", "entry", "fetch_data");
			expect(joined.code, joined.stderr).toBe(0);
			expect(joined.stdout).toContain("    + entry → fetch_data（chain）");

			const set = await cli(
				"scenario",
				"edit",
				id,
				"set",
				"fetch_data",
				"inputs.url",
				"http://c.test",
			);
			expect(set.code, set.stderr).toBe(0);
			expect(set.stdout).toContain('        inputs.url："http://a.test" → "http://c.test"');

			const unset = await cli("scenario", "edit", id, "set", "fetch_data", "display_name");
			expect(unset.code, unset.stderr).toBe(0);
			expect(unset.stdout).toContain('        display_name："取数据" → （无）');
			expect(await versionCount(id)).toBe(6);
		});

		it("值按节点类型的声明解析：声明是字符串的输入按原样存（1.10、true、3 不变成数字和布尔），声明是整数的照常是数字", async () => {
			const id = await scenario("编辑-字符串输入");
			const added = await cli(
				"scenario",
				"edit",
				id,
				"add",
				"http/probe",
				"--after",
				"report",
				"--id",
				"probe",
				"--input",
				"host=1.10",
				"--input",
				"count=3",
			);
			expect(added.code, added.stderr).toBe(0);
			expect(added.stdout).not.toContain("警告");
			for (const [value, stored] of [
				["true", "true"],
				["3", "3"],
				['"7"', "7"],
			] as const) {
				const set = await cli("scenario", "edit", id, "set", "fetch_data", "inputs.url", value);
				expect(set.code, set.stderr).toBe(0);
				expect((await headDoc(id)).nodes.find((n) => n.id === "fetch_data")?.inputs).toEqual({
					url: stored,
				});
			}
			expect((await headDoc(id)).nodes.find((n) => n.id === "probe")?.inputs).toEqual({
				host: "1.10",
				count: 3,
			});
			// 以 - 开头的值前面加 --（帮助里写的做法）。
			// （--server 写在前面：-- 之后的都是值。）
			const dashed = await sfly([
				"scenario",
				"edit",
				"--server",
				cp.httpUrl,
				id,
				"set",
				"probe",
				"inputs.count",
				"--",
				"-5",
			]);
			expect(dashed.code, dashed.stderr).toBe(0);
			expect((await headDoc(id)).nodes.find((n) => n.id === "probe")?.inputs).toEqual({
				host: "1.10",
				count: -5,
			});
		});

		it("开发版本的值按节点派发到的那台 Agent 的声明解析（两台声明不同时），和控制面的检查一个口径", async () => {
			// 两台在线的 Agent 都加载着开发包 devkit：build1 声明 tag 是整数，build-2 声明是字符串。名字按字符排
			// build-2 在前，按数据库的排序 build1 在前：取声明不能看名字的顺序，要看节点派发到哪台。
			const agents = await Promise.all(
				[
					["build1", { type: "integer" }],
					["build-2", { type: "string" }],
				].map(([name, tag]) =>
					FakeAgent.connect(cp.grpcUrl, {
						name: name as string,
						devPackages: [
							{
								name: "devkit",
								source: "/src/devkit",
								metadataJson: JSON.stringify(
									packageMetadata({
										name: "devkit",
										version: "dev",
										nodes: [
											{
												name: "t",
												title: "t",
												entry: "devkit.nodes:t",
												inputs: { type: "object", properties: { tag: tag as object } },
												outputs: { type: "object", properties: {} },
											},
											...(name === "build1"
												? [
														{
															name: "only_b1",
															title: "only_b1",
															entry: "devkit.nodes:only_b1",
															inputs: { type: "object", properties: {} },
															outputs: { type: "object", properties: {} },
														},
													]
												: []),
										],
									}),
								),
							},
						],
					}),
				),
			);
			try {
				await eventually(async () => {
					const { agents: listed } = await api.getJson<{
						agents: Array<{ name: string; status: string }>;
					}>("/projects/default/agents");
					for (const name of ["build1", "build-2"]) {
						expect(listed.find((a) => a.name === name)?.status).toBe("online");
					}
				});
				const id = await api.orchestrationWith(
					{ ...baseDocument(), default_agent: "build-2" },
					"编辑-开发版本按派发目标",
				);
				// 派到默认 Agent build-2（字符串）：3 存成 "3"，没有警告。
				const onDefault = await cli(
					"scenario",
					"edit",
					id,
					"add",
					"devkit/t",
					"--after",
					"report",
					"--id",
					"a",
					"--input",
					"tag=3",
				);
				expect(onDefault.code, onDefault.stdout + onDefault.stderr).toBe(0);
				expect(onDefault.stdout).not.toContain("警告");
				// 另选 build1（整数）：3 存成 3，没有警告。场景里已有的 devkit 节点派到 build-2、声明不同，
				// 控制面当作不知道（不检查），命令行也一样（按 JSON 解析）。
				const onOther = await cli(
					"scenario",
					"edit",
					id,
					"add",
					"devkit/t",
					"--after",
					"a",
					"--id",
					"b",
					"--agent",
					"build1",
					"--input",
					"tag=3",
				);
				expect(onOther.code, onOther.stdout + onOther.stderr).toBe(0);
				expect(onOther.stdout).not.toContain("警告");
				const nodes = (await headDoc(id)).nodes;
				expect(nodes.find((n) => n.id === "a")?.inputs).toEqual({ tag: "3" });
				expect(nodes.find((n) => n.id === "b")?.inputs).toEqual({ tag: 3 });
				// 控制面加节点时按派发目标认节点类型：只有 build1 上报的 only_b1，派到默认 Agent build-2 时加不上，
				// 另选 build1 时加得上。
				const fresh = await api.orchestrationWith(
					{ ...baseDocument(), default_agent: "build-2" },
					"编辑-开发版本的节点类型按派发目标",
				);
				const onB2 = await cli(
					"scenario",
					"edit",
					fresh,
					"add",
					"devkit/only_b1",
					"--after",
					"report",
				);
				expect(onB2.code).toBe(2);
				expect(onB2.stderr).toContain("没有节点类型 only_b1");
				const onB1 = await cli(
					"scenario",
					"edit",
					fresh,
					"add",
					"devkit/only_b1",
					"--after",
					"report",
					"--agent",
					"build1",
				);
				expect(onB1.code, onB1.stdout + onB1.stderr).toBe(0);
			} finally {
				await Promise.all(agents.map((a) => a.disconnect()));
			}
		});

		it("结果和原来相同：不存出新版本，写明没有改动", async () => {
			const id = await scenario("编辑-没有改动");
			const same = await cli("scenario", "edit", id, "set", "fetch_data", "display_name", "取数据");
			expect(same.code, same.stderr).toBe(0);
			expect(same.stdout).toBe("没有改动，没有存出新版本（场景「编辑-没有改动」仍是版本 1）。\n");
			const json = await cli(
				"scenario",
				"edit",
				id,
				"set",
				"fetch_data",
				"display_name",
				"取数据",
				"--json",
			);
			expect(JSON.parse(json.stdout)).toMatchObject({ saved: false, unchanged: true, version: 1 });
			expect(await versionCount(id)).toBe(1);
		});

		it("--json：一个对象，带版本号、警告和控制面的差异", async () => {
			const id = await scenario("编辑-json");
			const result = await cli("scenario", "edit", id, "remove", "report", "--json");
			expect(result.code, result.stderr).toBe(0);
			const body = JSON.parse(result.stdout);
			expect(body).toMatchObject({
				scenario: id,
				saved: true,
				version: 2,
				base_version: 1,
				warnings: [],
			});
			expect(body.diff.nodes.removed).toEqual([{ id: "report", kind: "package" }]);
		});
	});

	describe("--file 一次提交一组", () => {
		it("一组操作存成一个版本", async () => {
			const id = await scenario("编辑-文件");
			const file = join(dir, "ops.json");
			await writeFile(
				file,
				JSON.stringify([
					{
						op: "add_node",
						id: "check",
						package: "http",
						node: "get",
						after: "report",
						inputs: { url: "x" },
					},
					{ op: "set", node: "check", field: "note", value: "收尾检查" },
				]),
			);
			const result = await cli("scenario", "edit", id, "--file", file);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toContain("已保存场景「编辑-文件」的版本 2（基于版本 1）：");
			expect(await versionCount(id)).toBe(2);
		});

		it("有一个操作不合法：整组不生效，退出码 2，写明第几个；版本数不变", async () => {
			const id = await scenario("编辑-文件不合法");
			const file = join(dir, "bad-ops.json");
			await writeFile(
				file,
				JSON.stringify({
					operations: [
						{ op: "remove_node", node: "report" },
						{ op: "remove_node", node: "entry" },
					],
				}),
			);
			const result = await cli("scenario", "edit", id, "--file", file);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe(
				"错误：没有保存，这组操作都不生效：第 2 个操作（remove_node）：入口节点不能删除\n",
			);
			expect(await versionCount(id)).toBe(1);
		});
	});

	describe("--dry-run", () => {
		it("版本数不变；警告和真正保存时一样，只有警告时退出码 4", async () => {
			const id = await scenario("编辑-只检查");
			const args = ["scenario", "edit", id, "add", "http/get", "--id", "loose", "--input", "url=x"];
			const dry = await cli(...args, "--dry-run");
			expect(dry.code).toBe(EXIT_WARNINGS);
			expect(await versionCount(id)).toBe(1);
			const dryJson = JSON.parse((await cli(...args, "--dry-run", "--json")).stdout);
			expect(dryJson).toMatchObject({ scenario: id, saved: false, base_version: 1 });
			expect(dry.stdout).toMatch(/^检查过了，没有保存（场景「编辑-只检查」仍是版本 1）：/);
			expect(dry.stdout).toContain("    + loose  package");
			expect(dry.stdout).toContain("警告（1）：");

			const saved = JSON.parse((await cli(...args, "--json")).stdout);
			expect(saved.warnings).toEqual(dryJson.warnings);
			expect(saved.diff).toEqual(dryJson.diff);
		});

		it("场景原来就有的警告：单独一段、写明改动之前就有，不影响退出码", async () => {
			const doc = baseDocument();
			(doc.nodes[2] as { inputs: Record<string, unknown> }).inputs = {};
			const id = await api.orchestrationWith(doc, "编辑-只检查-已有警告");
			const result = await cli(
				"scenario",
				"edit",
				id,
				"set",
				"fetch_data",
				"display_name",
				"取一下数据",
				"--dry-run",
			);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toContain(
				"改动之前就有的警告（1，不是这次改动带进来的，不影响退出码）：\n  节点 report 的必填输入 url 没有填写",
			);
			const saved = await cli(
				"scenario",
				"edit",
				id,
				"set",
				"fetch_data",
				"display_name",
				"取一下数据",
			);
			expect(saved.code, saved.stderr).toBe(0);
			expect(saved.stdout).toContain("改动之前就有的警告（1，不是这次改动带进来的）：");
		});

		it("没有警告时退出码 0", async () => {
			const id = await scenario("编辑-只检查-没有警告");
			const result = await cli("scenario", "edit", id, "remove", "report", "--dry-run");
			expect(result.code, result.stderr).toBe(0);
			expect(await versionCount(id)).toBe(1);
		});
	});

	it("--base-version 落后：报冲突，退出码 2，提示和 push 一样写明最新版本的作者和时间", async () => {
		const id = await scenario("编辑-冲突");
		await api.saveVersion(id, baseDocument(), "bob");
		const result = await cli("scenario", "edit", id, "remove", "report", "--base-version", "1");
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(
			/^错误：场景已有更新的版本：版本 2 由 bob 保存于 \S+，这次编辑基于版本 1。/,
		);
		expect(result.stderr).toContain(`下一步：sfly scenario diff ${id} 1 2`);
		expect(await versionCount(id)).toBe(2);
	});

	it("没写 --base-version、读到最新版本之后有人保存了：报冲突，提示重新执行（不提 --base-version）", async () => {
		const id = await scenario("编辑-中途冲突");
		const proxy = await startRecordingProxy(cp.httpUrl, async (request) => {
			if (request.method === "POST" && request.path.endsWith("/edits")) {
				await api.saveVersion(id, baseDocument(), "bob");
			}
		});
		try {
			const result = await sfly([
				"scenario",
				"edit",
				id,
				"remove",
				"report",
				"--server",
				proxy.url,
			]);
			expect(result.code).toBe(2);
			expect(result.stderr).toMatch(
				/^错误：场景已有更新的版本：版本 2 由 bob 保存于 \S+，这次编辑基于版本 1。/,
			);
			expect(result.stderr).toContain("确认这次编辑仍然要做之后再执行一次同样的命令");
			expect(result.stderr).not.toContain("--base-version");
		} finally {
			await proxy.close();
		}
		expect(await versionCount(id)).toBe(2);
	});

	describe("让模型自己改对的报错", () => {
		it("节点 ID 不存在：列出相近的 ID", async () => {
			const id = await scenario("编辑-报错-节点");
			const result = await cli("scenario", "edit", id, "remove", "fetch-data");
			expect(result.code).toBe(2);
			expect(result.stderr).toBe(
				"错误：没有保存，这组操作都不生效：第 1 个操作（remove_node）：节点 fetch-data 不存在，相近的节点：fetch_data\n",
			);
			// --json 时线索是结构化的：控制面给的 details 原样带上
			const json = await cli("scenario", "edit", id, "remove", "fetch-data", "--json");
			expect(json.code).toBe(2);
			expect(JSON.parse(json.stderr).error).toMatchObject({
				code: "invalid_operation",
				details: { index: 0, op: "remove_node", similar: ["fetch_data"] },
			});
		});

		it("包节点缺必填输入：列出缺哪几个和各自的类型", async () => {
			const id = await scenario("编辑-报错-输入");
			const result = await cli("scenario", "edit", id, "add", "http/probe", "--after", "report");
			expect(result.code).toBe(2);
			expect(result.stderr).toContain(
				"节点类型 http/probe 缺少必填输入：host（string）、count（integer）",
			);
			const json = await cli("scenario", "edit", id, "add", "http/probe", "--json");
			expect(JSON.parse(json.stderr).error.code).toBe("invalid_operation");
		});

		it("连线两端接不上：写明两端各是什么", async () => {
			const id = await scenario("编辑-报错-连线");
			const result = await cli("scenario", "edit", id, "connect", "report", "entry");
			expect(result.code).toBe(2);
			expect(result.stderr).toContain(
				"入口节点不能有入线（起点 report 是包节点 http/get，终点 entry 是入口）",
			);
		});

		it("命令写错：节点类型不是「包/节点」、输入不是「名=值」，在本地报错", async () => {
			const id = await scenario("编辑-报错-参数");
			const type = await cli("scenario", "edit", id, "add", "http.get");
			expect(type.code).toBe(2);
			expect(type.stderr).toContain("节点类型要写成 包名/节点名");
			const input = await cli("scenario", "edit", id, "add", "http/get", "--input", "url");
			expect(input.code).toBe(2);
			expect(input.stderr).toContain("--input 要写成 名=值");
		});
	});
});
