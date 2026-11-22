// 场景的局部编辑（#470）：POST /orchestrations/:id/edits 和只检查不保存的 POST /orchestrations/:id/edits/check。
// 操作由控制面用画布的编辑函数作用在最新版本上；一组里有一个不合法时整组不生效。
import {
	disconnectEdge,
	insertAfter,
	isEmptyDiff,
	newPackageNode,
	removeNodes,
	uniqueNodeId,
} from "@sfly/orchestration";
import { orchestrationsApi, type StoredOrchestrationDocument } from "@sfly/schema";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { packageMetadata, publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

type Doc = StoredOrchestrationDocument;

/** 入口 → 取数据 → 出报告，两个包节点在一个注释框里；锁定的包版本已发布，保存时没有警告。 */
const baseDocument = () => ({
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [{ name: "host", type: "string", default: "a.test" }] },
		{
			id: "fetch_data",
			kind: "package",
			package: "http",
			node: "get",
			display_name: "取数据",
			inputs: { url: "http://a.test" },
		},
		{
			id: "report",
			kind: "package",
			package: "http",
			node: "get",
			inputs: { url: "http://b.test" },
		},
	],
	edges: [
		{ from: "entry", to: "fetch_data", kind: "chain" },
		{ from: "fetch_data", to: "report", kind: "chain" },
	],
	packages: { http: "1.0.0" },
	annotations: [{ id: "annotation_1", title: "取数据", nodes: ["fetch_data", "report"] }],
});

describe("场景的局部编辑", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;
	beforeAll(async () => {
		cp = await startTestControlPlane();
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
		await publishPackage(cp, "svc", "1.0.0", { scan: [] });
		await publishPackage(cp, "svc", "1.2.0", { scan: [] });
		// 只在 Agent 上以开发模式加载的包（联调时 sfly dev 的那种）
		agent = await FakeAgent.connect(cp.grpcUrl, {
			name: "agent-a",
			devPackages: [
				{
					name: "local-probe",
					source: "/src/local-probe",
					metadataJson: JSON.stringify(
						packageMetadata({
							name: "local-probe",
							version: "dev",
							nodes: [
								{
									name: "stats",
									title: "统计",
									entry: "local_probe.stats:stats",
									inputs: {
										type: "object",
										properties: { source: { type: "string" }, path: { type: "string" } },
										required: ["source", "path"],
										// 函数参数的顺序（sfly build 写出）：库里存的 JSON 不保留键的顺序
										order: ["source", "path"],
									},
									outputs: { type: "object", properties: {} },
								},
							],
						}),
					),
				},
			],
		});
		await eventually(async () => {
			const { agents } = await api.getJson<{ agents: Array<{ status: string }> }>("/agents");
			expect(agents[0]?.status).toBe("online");
		});
	});
	afterAll(async () => {
		await agent?.disconnect();
		await cp.close();
	});

	const versionCount = async (id: string) =>
		(await api.getJson<{ versions: unknown[] }>(`/orchestrations/${id}/versions`)).versions.length;
	const head = async (id: string) =>
		api.getJson<{ number: number; document: Doc }>(`/orchestrations/${id}/head`);
	const scenario = (name: string) => api.orchestrationWith(baseDocument(), name);

	const edit = async (id: string, operations: unknown[], base?: number) =>
		api.post(`/orchestrations/${id}/edits`, {
			base_version: base ?? (await api.headVersion(id)),
			operations,
		});
	const editOk = async (id: string, operations: unknown[]) => {
		const res = await edit(id, operations);
		const text = await res.text();
		expect(res.status, text).toBe(201);
		return orchestrationsApi.edit.response.parse(JSON.parse(text));
	};
	const problemOf = async (res: Response) => {
		const text = await res.text();
		expect(res.status, text).toBe(400);
		return (JSON.parse(text) as { error: { code: string; message: string; details: unknown } })
			.error;
	};

	/** 画布上做同样的事：在另一个一样的场景上用画布的编辑函数改最新版本，再整份保存，返回保存下来的文档。 */
	const viaCanvas = async (name: string, change: (doc: Doc) => Doc) => {
		const id = await scenario(name);
		await api.saveVersion(id, change((await head(id)).document));
		return (await head(id)).document;
	};

	describe("每种操作", () => {
		it("add_node 接在节点后面：插在它和下一个节点之间，存成新版本，和画布上「在后面添加」得到同样的文档", async () => {
			const id = await scenario("加节点");
			const saved = await editOk(id, [
				{ op: "add_node", package: "http", node: "get", after: "fetch_data", inputs: { url: "x" } },
			]);
			expect(saved.number).toBe(2);
			expect(saved.warnings).toEqual([]);
			expect(saved.diff.nodes.added).toEqual([{ id: "get_1", kind: "package" }]);
			expect(saved.diff.edges).toEqual({
				added: [
					{ from: "fetch_data", to: "get_1", kind: "chain" },
					{ from: "get_1", to: "report", kind: "chain" },
				],
				removed: [{ from: "fetch_data", to: "report", kind: "chain" }],
			});
			const canvas = await viaCanvas("加节点-画布", (doc) => {
				const ids = doc.nodes.map((n) => n.id);
				const node = {
					...newPackageNode("http", "get", uniqueNodeId("get", ids)),
					inputs: { url: "x" },
				};
				const result = insertAfter(doc, "fetch_data", node as Doc["nodes"][number]);
				if (!result.ok) throw new Error(result.reason);
				return result.doc;
			});
			expect((await head(id)).document).toEqual(canvas);
		});

		it("add_node 不写 after：不连线，保存时按整理布局补坐标；没锁定的包锁定最新发布的版本", async () => {
			const id = await scenario("加游离节点");
			const saved = await editOk(id, [
				{ op: "add_node", id: "scan", package: "svc", node: "scan", display_name: "扫描" },
			]);
			const node = saved.document.nodes.find((n) => n.id === "scan");
			expect(node).toMatchObject({
				kind: "package",
				display_name: "扫描",
				position: expect.any(Object),
			});
			expect(saved.document.packages).toEqual({ http: "1.0.0", svc: "1.2.0" });
			expect(saved.diff.settings).toEqual([{ path: "packages.svc", after: "1.2.0" }]);
			// 孤立的节点：保存时的警告照常给出
			expect(saved.warnings.map((w) => w.code)).toContain("orphan_node");
		});

		it("add_node 用开发版本的包：锁定 dev，节点类型和必填输入按在线 Agent 上报的元信息检查", async () => {
			const id = await scenario("加开发版本的节点");
			const missing = await problemOf(
				await edit(id, [
					{ op: "add_node", package: "local-probe", node: "stats", after: "report" },
				]),
			);
			expect(missing.details).toMatchObject({
				missing: [
					{ name: "source", type: "string" },
					{ name: "path", type: "string" },
				],
			});
			const saved = await editOk(id, [
				{
					op: "add_node",
					package: "local-probe",
					node: "stats",
					after: "report",
					inputs: { source: "sut-01", path: "/var/log/a.log" },
				},
			]);
			expect(saved.document.packages["local-probe"]).toBe("dev");
			expect(saved.document.edges).toContainEqual({ from: "report", to: "stats_1", kind: "chain" });
		});

		it("remove_node：前后接上，注释框里的成员一起去掉；和画布上删除一样", async () => {
			const id = await scenario("删节点");
			const saved = await editOk(id, [{ op: "remove_node", node: "fetch_data" }]);
			expect(saved.diff.nodes.removed).toEqual([
				{ id: "fetch_data", kind: "package", display_name: "取数据" },
			]);
			const canvas = await viaCanvas("删节点-画布", (doc) => {
				const result = removeNodes(doc, ["fetch_data"]);
				if (!result.ok) throw new Error(result.reason);
				return result.doc;
			});
			expect((await head(id)).document).toEqual(canvas);
			expect(canvas.annotations?.[0]?.nodes).toEqual(["report"]);
		});

		it("disconnect 和 connect：和画布上断开、连线一样", async () => {
			const id = await scenario("改连线");
			const saved = await editOk(id, [
				{ op: "disconnect", from: "fetch_data", to: "report" },
				{ op: "add_node", id: "check", package: "http", node: "get", inputs: { url: "c" } },
				{ op: "connect", from: "fetch_data", to: "check" },
				{ op: "connect", from: "check", to: "report" },
			]);
			expect(saved.diff.edges.removed).toEqual([
				{ from: "fetch_data", to: "report", kind: "chain" },
			]);
			const canvas = await viaCanvas("改连线-画布", (doc) => {
				const cut = disconnectEdge(doc, { from: "fetch_data", to: "report", kind: "chain" });
				return {
					...cut,
					nodes: [
						...cut.nodes,
						{ ...newPackageNode("http", "get", "check"), inputs: { url: "c" } },
					],
					edges: [
						...cut.edges,
						{ from: "fetch_data", to: "check", kind: "chain" },
						{ from: "check", to: "report", kind: "chain" },
					],
				} as Doc;
			});
			expect((await head(id)).document).toEqual(canvas);
		});

		it("set：改输入、显示名称、备注、Agent、执行设置，去掉字段；和画布检查器里改一样", async () => {
			const id = await scenario("改字段");
			const saved = await editOk(id, [
				{ op: "set", node: "report", field: "inputs.url", value: "${{ params.host }}" },
				{ op: "set", node: "report", field: "display_name", value: " 出报告 " },
				{ op: "set", node: "report", field: "note", value: "依赖报表服务" },
				{ op: "set", node: "report", field: "timeout", value: 60 },
				{ op: "set", node: "fetch_data", field: "display_name" },
			]);
			expect(saved.diff.nodes.changed.map((n) => n.id)).toEqual(["fetch_data", "report"]);
			const canvas = await viaCanvas("改字段-画布", (doc) => ({
				...doc,
				nodes: doc.nodes.map((n) => {
					if (n.id === "report" && n.kind === "package") {
						return {
							...n,
							inputs: { url: "${{ params.host }}" },
							display_name: "出报告",
							note: "依赖报表服务",
							timeout: 60,
						};
					}
					if (n.id === "fetch_data" && n.kind === "package") {
						const { display_name: _, ...rest } = n;
						return rest;
					}
					return n;
				}),
			}));
			expect((await head(id)).document).toEqual(canvas);
		});
	});

	describe("整组生效或都不生效", () => {
		it("有一个操作不合法：400 invalid_operation，指出是第几个；版本数不变", async () => {
			const id = await scenario("整组不生效");
			const res = await edit(id, [
				{ op: "remove_node", node: "report" },
				{ op: "connect", from: "fetch_data", to: "nope" },
			]);
			const error = await problemOf(res);
			expect(error.code).toBe("invalid_operation");
			expect(error.details).toMatchObject({ index: 1, op: "connect" });
			expect(await versionCount(id)).toBe(1);
		});

		it("编辑之后的文档不合法（值写错）时同样不生效", async () => {
			const id = await scenario("值不合法");
			const error = await problemOf(
				await edit(id, [{ op: "set", node: "report", field: "retries", value: -1 }]),
			);
			expect(error.code).toBe("invalid_operation");
			expect(error.message).toMatch(/^第 1 个操作（set）：字段 retries 的值不合法：/);
			expect(await versionCount(id)).toBe(1);
		});

		it("timeout 超过上限（#534）：拒绝，指出是第几个操作，和保存同一句话", async () => {
			const id = await scenario("超时超限");
			const error = await problemOf(
				await edit(id, [{ op: "set", node: "report", field: "timeout", value: 4_294_967_296 }]),
			);
			expect(error.code).toBe("invalid_operation");
			expect(error.message).toBe(
				"第 1 个操作（set）：节点 report：timeout 必须是 1 到 4294967295 之间的正整数（秒），实际是 4294967296",
			);
			expect(await versionCount(id)).toBe(1);
		});
	});

	describe("没有改动的一组操作", () => {
		it("结果和最新版本相同时不存出新版本：200，返回当前版本，unchanged 为 true", async () => {
			const id = await scenario("没有改动");
			for (const operations of [
				[{ op: "set", node: "fetch_data", field: "display_name", value: "取数据" }],
				[
					{ op: "add_node", id: "tmp", package: "http", node: "get", inputs: { url: "x" } },
					{ op: "remove_node", node: "tmp" },
				],
			]) {
				const res = await edit(id, operations);
				const text = await res.text();
				expect(res.status, text).toBe(200);
				const body = orchestrationsApi.edit.response.parse(JSON.parse(text));
				expect(body).toMatchObject({ number: 1, unchanged: true });
				expect(isEmptyDiff(body.diff)).toBe(true);
			}
			expect(await versionCount(id)).toBe(1);
			// 有改动时照常存成新版本，没有 unchanged。
			const changed = await editOk(id, [
				{ op: "set", node: "fetch_data", field: "display_name", value: "取数据 2" },
			]);
			expect(changed.number).toBe(2);
			expect(changed.unchanged).toBeUndefined();
		});
	});

	describe("让调用方自己改对的报错", () => {
		it("包名、版本写错：列出相近的包名、这个包已发布的版本", async () => {
			const id = await scenario("报错-包名");
			const typo = await problemOf(
				await edit(id, [{ op: "add_node", package: "htp", node: "get" }]),
			);
			expect(typo.message).toContain("相近的包：http");
			const version = await problemOf(
				await edit(id, [{ op: "add_node", package: "svc", node: "scan", version: "9.9.9" }]),
			);
			expect(version.message).toMatch(
				/控制面上没有节点包版本 svc@9\.9\.9，已发布的版本：1\.2\.0、1\.0\.0$/,
			);
		});

		it("包名写错时的线索按项目收窄：别的项目的已发布包、别的项目的 Agent 上的开发版本都不列出来", async () => {
			// 别的项目里的已发布包和 Agent（接口的路径还不带项目，直接改库把它们放进项目 other）。
			await publishPackage(cp, "secret-kit", "1.0.0", { scan: [] });
			const other = await FakeAgent.connect(cp.grpcUrl, {
				name: "agent-other",
				devPackages: [
					{
						name: "hidden-dev",
						source: "/src/hidden-dev",
						metadataJson: JSON.stringify(
							packageMetadata({ name: "hidden-dev", version: "dev", nodes: [] }),
						),
					},
				],
			});
			const pool = new pg.Pool({ connectionString: cp.database.url, max: 1 });
			try {
				await eventually(async () => {
					const { agents } = await api.getJson<{
						agents: Array<{ name: string; status: string }>;
					}>("/agents");
					expect(agents.find((a) => a.name === "agent-other")?.status).toBe("online");
				});
				await pool.query(
					"insert into projects (id, display_name, created_at) values ('other', 'other', now()) on conflict do nothing",
				);
				await pool.query("update node_packages set project_id = 'other' where name = 'secret-kit'");
				await pool.query("update agents set project_id = 'other' where name = 'agent-other'");
				const id = await scenario("报错-包名-别的项目");
				for (const typo of ["secret-ki", "hidden-de"]) {
					const error = await problemOf(
						await edit(id, [{ op: "add_node", package: typo, node: "scan" }]),
					);
					expect(JSON.stringify(error)).not.toMatch(/secret-kit|hidden-dev/);
				}
				// 对照：同样的写错在本项目的包上给出线索。
				const here = await problemOf(
					await edit(id, [{ op: "add_node", package: "local-prob", node: "stats" }]),
				);
				expect(here.message).toContain("相近的包：local-probe");
			} finally {
				await other.disconnect();
				await pool.end();
			}
		});

		it("节点 ID 不存在：列出相近的 ID", async () => {
			const id = await scenario("报错-节点不存在");
			const error = await problemOf(await edit(id, [{ op: "remove_node", node: "fetch-data" }]));
			expect(error).toEqual({
				code: "invalid_operation",
				message: "第 1 个操作（remove_node）：节点 fetch-data 不存在，相近的节点：fetch_data",
				details: {
					index: 0,
					op: "remove_node",
					message: "第 1 个操作（remove_node）：节点 fetch-data 不存在，相近的节点：fetch_data",
					similar: ["fetch_data"],
				},
			});
		});

		it("包节点缺必填输入：列出缺哪几个和各自的类型", async () => {
			const id = await scenario("报错-缺输入");
			const error = await problemOf(
				await edit(id, [{ op: "add_node", package: "http", node: "probe", after: "report" }]),
			);
			expect(error.message).toBe(
				"第 1 个操作（add_node）：节点类型 http/probe 缺少必填输入：host（string）、count（integer）",
			);
			expect(error.details).toMatchObject({
				missing: [
					{ name: "host", type: "string" },
					{ name: "count", type: "integer" },
				],
			});
		});

		it("连线两端接不上：写明两端各是什么", async () => {
			const id = await scenario("报错-接不上");
			const error = await problemOf(
				await edit(id, [{ op: "connect", from: "report", to: "entry" }]),
			);
			expect(error.message).toBe(
				"第 1 个操作（connect）：入口节点不能有入线（起点 report 是包节点 http/get，终点 entry 是入口）",
			);
			expect(error.details).toMatchObject({
				from: { id: "report", kind: "package", type: "http/get" },
				to: { id: "entry", kind: "entry" },
			});
		});
	});

	describe("只检查不保存", () => {
		it("版本数不变；警告、差异和真正保存时一样", async () => {
			const id = await scenario("检查编辑");
			const operations = [
				{
					op: "add_node",
					id: "p",
					package: "http",
					node: "probe",
					after: "report",
					inputs: { host: "h", count: "三" },
				},
				{ op: "set", node: "report", field: "agent", value: "agent-a" },
			];
			const checked = await api.post(`/orchestrations/${id}/edits/check`, { operations });
			const text = await checked.text();
			expect(checked.status, text).toBe(200);
			const body = orchestrationsApi.checkEdits.response.parse(JSON.parse(text));
			expect(await versionCount(id)).toBe(1);
			expect(body.warnings.map((w) => [w.code, w.existing])).toEqual([
				["input_type_mismatch", false],
			]);

			const saved = await editOk(id, operations);
			expect(body.warnings).toEqual(saved.warnings);
			expect(body.diff).toEqual(saved.diff);
		});

		it("警告带标记：场景原来就有的标成已有，这组操作带进来的标成新的；保存的响应里也一样", async () => {
			const doc = baseDocument();
			// 原来就有：report 的必填输入 url 没写
			doc.nodes[2] = { ...doc.nodes[2], inputs: {} } as (typeof doc.nodes)[number];
			const id = await api.orchestrationWith(doc, "检查编辑-已有警告");
			const operations = [
				{ op: "set", node: "fetch_data", field: "display_name", value: "取一下数据" },
				{
					op: "add_node",
					id: "p",
					package: "http",
					node: "probe",
					inputs: { host: "h", count: "三" },
				},
			];
			const checked = await api.post(`/orchestrations/${id}/edits/check`, { operations });
			const body = orchestrationsApi.checkEdits.response.parse(await checked.json());
			const flags = (ws: Array<{ code: string; node_id?: string; existing: boolean }>) =>
				ws.map((w) => `${w.existing ? "已有" : "新的"} ${w.code} ${w.node_id}`).sort();
			expect(flags(body.warnings)).toEqual(
				["已有 input_required report", "新的 input_type_mismatch p", "新的 orphan_node p"].sort(),
			);
			const saved = await editOk(id, operations);
			expect(flags(saved.warnings)).toEqual(flags(body.warnings));
		});

		it("不合法的操作和保存时一样报错", async () => {
			const id = await scenario("检查编辑-报错");
			const error = await problemOf(
				await api.post(`/orchestrations/${id}/edits/check`, {
					operations: [{ op: "remove_node", node: "entry" }],
				}),
			);
			expect(error.message).toBe("第 1 个操作（remove_node）：入口节点不能删除");
		});
	});

	describe("base_version", () => {
		it("落后时保存和检查都返回 version_conflict，版本数不变；缺 base_version 时 base_version_required", async () => {
			const id = await scenario("冲突");
			await api.saveVersion(id, baseDocument(), "bob");
			const ops = [{ op: "remove_node", node: "report" }];
			for (const path of ["edits", "edits/check"]) {
				const res = await api.post(`/orchestrations/${id}/${path}`, {
					base_version: 1,
					operations: ops,
				});
				expect(res.status, path).toBe(409);
				expect(await res.json(), path).toMatchObject({
					error: {
						code: "version_conflict",
						details: { base_version: 1, head: { number: 2, author: "bob" } },
					},
				});
			}
			expect(await versionCount(id)).toBe(2);
			const missing = await api.post(`/orchestrations/${id}/edits`, { operations: ops });
			expect(missing.status).toBe(400);
			expect(await missing.json()).toMatchObject({ error: { code: "base_version_required" } });
		});
	});

	it("场景不存在时 404", async () => {
		const res = await api.post("/orchestrations/00000000-0000-4000-8000-000000000000/edits", {
			base_version: 0,
			operations: [{ op: "remove_node", node: "x" }],
		});
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({
			error: { code: "not_found", message: "orchestration not found" },
		});
	});
});
