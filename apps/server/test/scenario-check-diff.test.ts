// 场景的检查接口（POST /orchestrations/:id/check）和版本对比接口（GET /orchestrations/:id/versions/:a/diff/:b）（#424）。
// 检查走和保存同一段校验：同一份文档，检查和保存返回的错误、警告完全一样，检查不产生版本。
// 对比用 @sfly/orchestration 的 diffDocuments（前端的版本对比用的也是它）。
import { orchestrationsApi } from "@sfly/schema";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { publishPackage } from "./support/package-archive.js";
import { createPresetOk } from "./support/presets.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

type Doc = Record<string, unknown> & {
	nodes: Array<Record<string, unknown>>;
	edges: Array<Record<string, unknown>>;
	packages: Record<string, string>;
};

const baseDocument = (): Doc => ({
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [{ name: "env", type: "string", default: "staging" }] },
		{
			id: "check",
			kind: "package",
			package: "http",
			node: "check",
			display_name: "探测接口",
			inputs: { url: "http://a.test" },
		},
	],
	edges: [{ from: "entry", to: "check", kind: "chain" }],
	packages: { http: "1.0.0" },
});

/** 检查的警告去掉 `existing` 标记，和保存的警告比较。 */
const withoutFlag = (warnings: unknown) =>
	(warnings as Array<Record<string, unknown>>).map(({ existing: _, ...rest }) => rest);

const EMPTY_DIFF = {
	settings: [],
	nodes: { added: [], removed: [], changed: [] },
	edges: { added: [], removed: [] },
	moved: [],
	annotations: { added: [], removed: [], changed: [] },
};

describe("场景的检查接口和版本对比接口", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		const check = { outputs: [], inputs: { properties: { url: { type: "string" } } } };
		// probe 有必填输入 host：缺了它保存时有 input_required 警告
		const probe = {
			outputs: [],
			inputs: { properties: { host: { type: "string" } }, required: ["host"] },
		};
		await publishPackage(cp, "http", "1.0.0", { check, probe });
		await publishPackage(cp, "http", "1.1.0", { check, probe });
	});
	afterAll(async () => {
		await cp.close();
	});

	const versionCount = async (id: string) =>
		(await api.getJson<{ versions: unknown[] }>(`/orchestrations/${id}/versions`)).versions.length;

	/** 最新版本的文档（带着控制面补好的坐标），改完以它为基线保存。 */
	const head = async (id: string) =>
		(await api.getJson<{ number: number; document: Doc }>(`/orchestrations/${id}/head`)).document;

	const edit = async (id: string, change: (doc: Doc) => void): Promise<number> => {
		const doc = await head(id);
		change(doc);
		return api.saveVersion(id, doc);
	};

	const diff = async (id: string, a: number | string, b: number | string) => {
		const res = await api.get(`/orchestrations/${id}/versions/${a}/diff/${b}`);
		const text = await res.text();
		expect(res.status, text).toBe(200);
		return orchestrationsApi.versionDiff.response.parse(JSON.parse(text)).diff;
	};

	describe("检查", () => {
		it("同一份文档，检查和保存返回的错误、警告完全一样；检查不产生版本", async () => {
			const id = await api.orchestrationWith(baseDocument(), "检查和保存一致");
			// 第 1 版上建一个预设：改掉入口参数 env 之后它会失效（preset_invalidated）
			await createPresetOk(api, id, { name: "生产", params: [{ name: "env", value: "prod" }] });

			const withSecret = baseDocument();
			(withSecret.nodes[0] as { params: unknown[] }).params.push({
				name: "token",
				type: "string",
				secret: true,
				default: "s3cr3t-default",
			});
			const renamedParam = baseDocument();
			(renamedParam.nodes[0] as { params: unknown[] }).params = [
				{ name: "stage", type: "string", default: "staging" },
			];
			const placeholder = baseDocument();
			(placeholder.nodes[0] as { params: unknown[] }).params.push({
				name: "password",
				type: "string",
				secret: true,
				default: "******",
			});
			const cases: Array<[string, unknown]> = [
				["没有问题", baseDocument()],
				["只有警告：没发布过的包版本", { ...baseDocument(), packages: { http: "9.9.9" } }],
				["只有警告：secret 参数写了默认值", withSecret],
				["只有警告：改掉入口参数，预设失效", renamedParam],
				["错误：文档不合法", { ...baseDocument(), nodes: "not-a-list" }],
				["错误：secret 默认值的占位符沿用不了", placeholder],
			];

			const seen = new Set<string>();
			for (const [name, document] of cases) {
				const base = await api.headVersion(id);
				const before = await versionCount(id);
				const checked = await api.post(`/orchestrations/${id}/check`, {
					document,
					base_version: base,
				});
				const checkedBody = (await checked.json()) as Record<string, unknown>;
				expect(await versionCount(id), `${name}：检查不产生版本`).toBe(before);

				const saved = await api.post(`/orchestrations/${id}/versions`, {
					document,
					base_version: base,
				});
				const savedBody = (await saved.json()) as Record<string, unknown>;
				if (saved.status === 201) {
					expect(checked.status, name).toBe(200);
					// 检查的警告多一个标记：改动之前（最新版本里）是否就有
					expect(withoutFlag(checkedBody.warnings), name).toEqual(savedBody.warnings);
					if (name === "没有问题") expect(savedBody.warnings).toEqual([]);
					for (const w of savedBody.warnings as Array<{ code: string }>) seen.add(w.code);
				} else {
					expect(checked.status, name).toBe(saved.status);
					expect(checkedBody, name).toEqual(savedBody);
					seen.add((savedBody.error as { code: string }).code);
				}
			}
			// 每一类问题真的出现过，比较不是空转
			expect([...seen].sort()).toEqual(
				[
					"invalid_document",
					"package_version_missing",
					"preset_invalidated",
					"secret_default_placeholder",
					"secret_param_default",
				].sort(),
			);
		});

		it("base_version 不是最新版本时和保存一样返回 409；不写 base_version 时对照最新版本检查", async () => {
			const id = await api.orchestrationWith(baseDocument(), "检查冲突");
			await api.saveVersion(id, baseDocument());
			const stale = await api.post(`/orchestrations/${id}/check`, {
				document: baseDocument(),
				base_version: 1,
			});
			expect(stale.status).toBe(409);
			expect(await stale.json()).toMatchObject({
				error: { code: "version_conflict", details: { base_version: 1, head: { number: 2 } } },
			});

			const latest = await api.post(`/orchestrations/${id}/check`, { document: baseDocument() });
			expect(latest.status).toBe(200);
			expect(await versionCount(id)).toBe(2);
		});

		it("响应带着和最新版本比的差异：保存之后会改变什么", async () => {
			const id = await api.orchestrationWith(baseDocument(), "检查带差异");
			const doc = await head(id);
			doc.nodes.push({
				id: "notify",
				kind: "package",
				package: "http",
				node: "check",
				display_name: "通知",
				inputs: { url: "http://b.test" },
			});
			doc.edges.push({ from: "check", to: "notify", kind: "chain" });
			const res = await api.post(`/orchestrations/${id}/check`, { document: doc });
			expect(res.status).toBe(200);
			const body = orchestrationsApi.check.response.parse(await res.json());
			expect(body.diff.nodes.added).toEqual([
				{ id: "notify", kind: "package", display_name: "通知" },
			]);
			expect(body.diff.edges.added).toEqual([{ from: "check", to: "notify", kind: "chain" }]);

			const same = await api.post(`/orchestrations/${id}/check`, { document: await head(id) });
			expect(orchestrationsApi.check.response.parse(await same.json()).diff).toEqual(EMPTY_DIFF);
		});

		it("场景不存在时 404", async () => {
			const res = await api.post("/orchestrations/00000000-0000-4000-8000-000000000000/check", {
				document: baseDocument(),
			});
			expect(res.status).toBe(404);
			expect(await res.json()).toEqual({
				error: { code: "not_found", message: "orchestration not found" },
			});
		});
	});

	describe("警告分成这次改动新带进来的和改动之前就有的", () => {
		/** 入口带一个写了默认值的 secret 参数，probe 节点缺必填输入 host：最新版本里就有两条警告。 */
		const withExisting = (): Doc => {
			const doc = baseDocument();
			(doc.nodes[0] as { params: unknown[] }).params.push({
				name: "token",
				type: "string",
				secret: true,
				default: "s3cr3t-default",
			});
			doc.nodes.push({
				id: "probe_a",
				kind: "package",
				package: "http",
				node: "probe",
				inputs: {},
			});
			doc.edges.push({ from: "check", to: "probe_a", kind: "chain" });
			return doc;
		};
		const check = async (id: string, document: unknown, extra: Record<string, unknown> = {}) => {
			const res = await api.post(`/orchestrations/${id}/check`, { document, ...extra });
			const text = await res.text();
			expect(res.status, text).toBe(200);
			return orchestrationsApi.check.response.parse(JSON.parse(text));
		};
		/** 每条警告写成「已有/新的 种类 节点 字段 具体对象」（没有的部分不写）。 */
		const flags = (
			warnings: Array<{
				code: string;
				node_id?: string;
				input?: string;
				annotation_id?: string;
				target?: string;
				existing: boolean;
			}>,
		) =>
			warnings
				.map((w) =>
					[w.existing ? "已有" : "新的", w.code, w.node_id ?? w.annotation_id, w.input, w.target]
						.filter((part) => part !== undefined)
						.join(" "),
				)
				.sort();

		it("只改显示名称：原来就有的警告都标成已有", async () => {
			const id = await api.orchestrationWith(withExisting(), "已有警告-改名");
			const doc = await head(id);
			doc.nodes[1] = { ...doc.nodes[1], display_name: "探测一下" };
			const body = await check(id, doc);
			expect(flags(body.warnings)).toEqual(
				["已有 input_required probe_a host", "已有 secret_param_default entry token"].sort(),
			);
		});

		it("再带进来一条：新的那条标成新的；同一种警告指向另一个节点也算新的", async () => {
			const id = await api.orchestrationWith(withExisting(), "已有警告-新加");
			const doc = await head(id);
			doc.nodes.push({
				id: "probe_b",
				kind: "package",
				package: "http",
				node: "probe",
				inputs: {},
			});
			doc.edges.push({ from: "probe_a", to: "probe_b", kind: "chain" });
			const body = await check(id, doc);
			expect(flags(body.warnings)).toEqual(
				[
					"已有 input_required probe_a host",
					"已有 secret_param_default entry token",
					"新的 input_required probe_b host",
				].sort(),
			);
		});

		it("原来那条改好了、同一种警告出现在另一个节点上：算新的（按指向的节点认，不是按种类数条数）", async () => {
			const id = await api.orchestrationWith(withExisting(), "已有警告-换节点");
			const doc = await head(id);
			doc.nodes = doc.nodes.map((n) => (n.id === "probe_a" ? { ...n, inputs: { host: "h" } } : n));
			doc.nodes.push({
				id: "probe_b",
				kind: "package",
				package: "http",
				node: "probe",
				inputs: {},
			});
			doc.edges.push({ from: "probe_a", to: "probe_b", kind: "chain" });
			const body = await check(id, doc);
			expect(flags(body.warnings)).toEqual(
				["已有 secret_param_default entry token", "新的 input_required probe_b host"].sort(),
			);
		});

		/** 入口上两个 secret 参数：A 写了默认值（最新版本里有一条 secret_param_default），B 没有。 */
		const twoSecrets = (): Doc => {
			const doc = baseDocument();
			(doc.nodes[0] as { params: unknown[] }).params = [
				{ name: "A", type: "string", secret: true, default: "s3cr3t-a" },
				{ name: "B", type: "string", secret: true },
			];
			return doc;
		};
		const paramsOf = (doc: Doc) =>
			(doc.nodes[0] as { params: Array<Record<string, unknown>> }).params;

		it("去掉 A 的默认值、给 B 写上默认值：B 那条是新的（同一个入口节点上的不同参数是不同的对象）", async () => {
			const id = await api.orchestrationWith(twoSecrets(), "已有警告-换参数");
			const doc = await head(id);
			const [a, b] = paramsOf(doc);
			const { default: _, ...withoutDefault } = a as Record<string, unknown>;
			paramsOf(doc).splice(0, 2, withoutDefault, { ...b, default: "s3cr3t-b" });
			expect(flags((await check(id, doc)).warnings)).toEqual(["新的 secret_param_default entry B"]);
		});

		it("在 A 前面新加一个带默认值的 B：B 是新的，A 仍是原来就有的", async () => {
			const id = await api.orchestrationWith(twoSecrets(), "已有警告-前面加参数");
			const doc = await head(id);
			paramsOf(doc).splice(1, 1);
			paramsOf(doc).unshift({ name: "B", type: "string", secret: true, default: "s3cr3t-b" });
			expect(flags((await check(id, doc)).warnings)).toEqual(
				["已有 secret_param_default entry A", "新的 secret_param_default entry B"].sort(),
			);
		});

		it("注释框把重复写的成员从 check 换成 probe_a：算新的（注释框里的不同成员是不同的对象）", async () => {
			const before = withExisting();
			before.annotations = [{ id: "ann", title: "一组", nodes: ["check", "check"] }];
			const id = await api.orchestrationWith(before, "已有警告-换成员");
			const doc = await head(id);
			doc.annotations = [{ id: "ann", title: "一组", nodes: ["probe_a", "probe_a"] }];
			const body = await check(id, doc);
			expect(flags(body.warnings.filter((w) => w.annotation_id === "ann"))).toEqual([
				"新的 annotation_duplicate_member ann nodes/probe_a",
			]);
		});

		it("改掉入口参数让预设失效：预设失效的警告总是新的（它说的就是这次改动）", async () => {
			const id = await api.orchestrationWith(withExisting(), "已有警告-预设");
			await createPresetOk(api, id, { name: "生产", params: [{ name: "env", value: "prod" }] });
			const doc = await head(id);
			const params = (doc.nodes[0] as { params: Array<{ name: string }> }).params;
			params[0] = { ...params[0], name: "stage" };
			const body = await check(id, doc);
			expect(body.warnings.find((w) => w.code === "preset_invalidated")?.existing).toBe(false);
		});

		it("场景还没有版本：全部算新带进来的", async () => {
			const id = await api.createOrchestration("已有警告-第一个版本");
			const body = await check(id, withExisting());
			expect(body.warnings.length).toBeGreaterThan(0);
			expect(body.warnings.every((w) => w.existing === false)).toBe(true);
		});
	});

	describe("保存的 strict：有这次改动新带进来的警告就不保存，在同一个事务里判断", () => {
		const strictSave = async (id: string, document: unknown) =>
			api.post(`/orchestrations/${id}/versions`, {
				document,
				base_version: await api.headVersion(id),
				strict: true,
			});

		it("新带进来警告：400 strict_warnings，details 和检查的结构一样（带标记的警告和差异），不产生版本", async () => {
			const id = await api.orchestrationWith(baseDocument(), "严格保存-新警告");
			const doc = await head(id);
			doc.packages = { http: "9.9.9" };
			const res = await strictSave(id, doc);
			const text = await res.text();
			expect(res.status, text).toBe(400);
			const error = JSON.parse(text).error;
			expect(error.code).toBe("strict_warnings");
			const details = orchestrationsApi.check.response.parse(error.details);
			expect(details.warnings.map((w) => [w.code, w.existing])).toEqual([
				["package_version_missing", false],
			]);
			expect(details.diff.settings).toEqual([
				{ path: "packages.http", before: "1.0.0", after: "9.9.9" },
			]);
			expect(await versionCount(id)).toBe(1);
		});

		it("判断在保存的事务里（拿到场景的行锁之后）：等锁期间别人建了会失效的预设，保存照样拒绝", async () => {
			const id = await api.orchestrationWith(baseDocument(), "严格保存-等锁");
			const doc = await head(id);
			// 改掉入口参数 env：这时还没有运行预设，事务外先判断的话没有警告
			(doc.nodes[0] as { params: unknown[] }).params = [{ name: "stage", type: "string" }];
			const locker = new pg.Client({ connectionString: cp.database.url });
			const watcher = new pg.Client({ connectionString: cp.database.url });
			await locker.connect();
			await watcher.connect();
			try {
				// 另一个连接先拿住场景的行锁，并在同一个事务里建一个用 env 的预设（提交之前保存看不到它）
				await locker.query("BEGIN");
				await locker.query("SELECT 1 FROM orchestrations WHERE id = $1 FOR UPDATE", [id]);
				await locker.query(
					`INSERT INTO run_presets (id, orchestration_id, name, values, created_at, updated_at, updated_by)
					 VALUES (gen_random_uuid(), $1, '生产', '{"env": "prod"}', now(), now(), 'tester')`,
					[id],
				);
				const saving = strictSave(id, doc);
				// 等到保存的事务卡在这把行锁上，再提交：保存拿到锁之后才看得到这个预设
				await eventually(async () => {
					const { rows } = await watcher.query(
						"SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()",
					);
					expect(rows[0].n).toBeGreaterThan(0);
				}, 10_000);
				await locker.query("COMMIT");
				const res = await saving;
				const text = await res.text();
				expect(res.status, text).toBe(400);
				const error = JSON.parse(text).error;
				expect(error.code).toBe("strict_warnings");
				expect(error.details.warnings).toMatchObject([
					{ code: "preset_invalidated", target: "生产", existing: false },
				]);
			} finally {
				await locker.end();
				await watcher.end();
			}
			expect(await versionCount(id)).toBe(1);
		});

		it("只有改动之前就有的警告：照常保存", async () => {
			const id = await api.orchestrationWith(baseDocument(), "严格保存-已有警告");
			const withSecret = await head(id);
			(withSecret.nodes[0] as { params: unknown[] }).params.push({
				name: "token",
				type: "string",
				secret: true,
				default: "s3cr3t-default",
			});
			await api.saveVersion(id, withSecret);
			const doc = await head(id);
			doc.nodes[1] = { ...doc.nodes[1], display_name: "改个名" };
			const res = await strictSave(id, doc);
			expect(res.status, await res.clone().text()).toBe(201);
			expect(await versionCount(id)).toBe(3);
		});
	});

	describe("对比两个版本", () => {
		let id: string;
		/** 各个版本号（beforeAll 里依次保存）。 */
		const v = {
			base: 0,
			added: 0,
			removed: 0,
			input: 0,
			edge: 0,
			rewired: 0,
			param: 0,
			package: 0,
			same: 0,
		};
		beforeAll(async () => {
			id = await api.orchestrationWith(baseDocument(), "对比");
			v.base = 1;
			v.added = await edit(id, (doc) => {
				doc.nodes.push({
					id: "notify",
					kind: "package",
					package: "http",
					node: "check",
					display_name: "通知",
					inputs: { url: "http://b.test" },
					position: { x: 400, y: 0 },
				});
				doc.edges.push({ from: "check", to: "notify", kind: "chain" });
			});
			v.removed = await edit(id, (doc) => {
				doc.nodes = doc.nodes.filter((n) => n.id !== "notify");
				doc.edges = doc.edges.filter((e) => e.to !== "notify");
			});
			v.input = await edit(id, (doc) => {
				(doc.nodes[1] as { inputs: Record<string, unknown> }).inputs.url = "http://c.test";
			});
			v.edge = await edit(id, (doc) => {
				doc.nodes.push({
					id: "after",
					kind: "package",
					package: "http",
					node: "check",
					inputs: { url: "http://d.test" },
					position: { x: 400, y: 200 },
				});
				doc.edges.push({ from: "check", to: "after", kind: "chain" });
			});
			v.rewired = await edit(id, (doc) => {
				doc.edges = doc.edges.map((e) =>
					e.to === "after" ? { from: "entry", to: "after", kind: "chain" } : e,
				);
			});
			v.param = await edit(id, (doc) => {
				(doc.nodes[0] as { params: unknown[] }).params = [
					{ name: "env", type: "string", default: "prod" },
				];
			});
			v.package = await edit(id, (doc) => {
				doc.packages = { http: "1.1.0" };
			});
			v.same = await edit(id, () => {});
		});

		it("新增节点：写出节点 ID、种类和显示名称，以及新增的连线", async () => {
			expect(await diff(id, v.base, v.added)).toEqual({
				...EMPTY_DIFF,
				nodes: {
					added: [{ id: "notify", kind: "package", display_name: "通知" }],
					removed: [],
					changed: [],
				},
				edges: { added: [{ from: "check", to: "notify", kind: "chain" }], removed: [] },
			});
		});

		it("删除节点", async () => {
			expect(await diff(id, v.added, v.removed)).toEqual({
				...EMPTY_DIFF,
				nodes: {
					added: [],
					removed: [{ id: "notify", kind: "package", display_name: "通知" }],
					changed: [],
				},
				edges: { added: [], removed: [{ from: "check", to: "notify", kind: "chain" }] },
			});
		});

		it("改节点的参数：字段的前后值", async () => {
			expect(await diff(id, v.removed, v.input)).toEqual({
				...EMPTY_DIFF,
				nodes: {
					added: [],
					removed: [],
					changed: [
						{
							id: "check",
							kind: "package",
							display_name: "探测接口",
							changes: [{ path: "inputs.url", before: "http://a.test", after: "http://c.test" }],
						},
					],
				},
			});
		});

		it("改连线", async () => {
			expect((await diff(id, v.edge, v.rewired)).edges).toEqual({
				added: [{ from: "entry", to: "after", kind: "chain" }],
				removed: [{ from: "check", to: "after", kind: "chain" }],
			});
		});

		it("改入口参数", async () => {
			expect((await diff(id, v.rewired, v.param)).nodes.changed).toEqual([
				{
					id: "entry",
					kind: "entry",
					changes: [
						// 两边都有的参数按字段比较，只写变了的字段（#341）；required、secret 按保存时补齐的默认值比较，没有变
						{ path: "params.env.default", before: "staging", after: "prod" },
					],
				},
			]);
		});

		it("改节点包版本", async () => {
			expect(await diff(id, v.param, v.package)).toEqual({
				...EMPTY_DIFF,
				settings: [{ path: "packages.http", before: "1.0.0", after: "1.1.0" }],
			});
		});

		it("两个版本相同（同一个版本、内容相同的两个版本）：空差异", async () => {
			expect(await diff(id, v.package, v.package)).toEqual(EMPTY_DIFF);
			expect(await diff(id, v.package, v.same)).toEqual(EMPTY_DIFF);
		});

		it("版本不存在或不是整数时 404", async () => {
			for (const [a, b] of [
				[1, 99],
				[0, 1],
				["x", 1],
				[1, "1.5"],
			]) {
				const res = await api.get(`/orchestrations/${id}/versions/${a}/diff/${b}`);
				expect(res.status, `${a} → ${b}`).toBe(404);
				expect(await res.json(), `${a} → ${b}`).toEqual({
					error: { code: "not_found", message: "orchestration version not found" },
				});
			}
		});
	});
});
