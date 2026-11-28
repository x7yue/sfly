// 派发内容（src/engine/assign-content.ts）：给任务、节点和目标 Agent，回答「派什么」或「为什么派不了」。
// 直接对这个模块说话，不经过引擎和 Agent：节点包由正常的控制面发布，被引用的 Agent 由假 Agent 注册，
// 模块直接连同一个数据库。版本要求和输入校验的各条规则、Agent 地址的取法由 HTTP 级的测试
// （requires-sdk、requires-agent、agent-inputs、feishu-bot-inputs、failures）覆盖，这里只看模块自己的回答：
// 派发内容有哪些字段、各个失败出口的类型、哪些失败带已解析的输入。
import { createHash } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import type { ResolveScope } from "@sfly/orchestration";
import { AssignTaskSchema } from "@sfly/proto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/database.js";
import { type AssignRequest, createAssignContent } from "../src/engine/assign-content.js";
import type { PackageNode } from "../src/engine/chain.js";
import { DEFAULT_PROJECT, type ProjectId } from "../src/projects/project-id.js";
import { FakeAgent } from "./support/fake-agent.js";
import { packageArchive, packageMetadata, publishInit } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const agentInput = { type: "string", "x-sfly-type": "agent" };
const botInput = { type: "string", "x-sfly-type": "feishu_bot" };
const nodeType = (name: string, properties: Record<string, unknown>, required: string[] = []) => ({
	name,
	title: name,
	entry: `demo.nodes:${name}`,
	inputs: { type: "object", properties, required },
	outputs: { type: "object", properties: {} },
});

/** demo：plain(url: string 必填, n: integer)、pick(source: Agent)、notify(bot、backup、other: 飞书机器人)。 */
const demo = packageArchive(
	packageMetadata({
		name: "demo",
		version: "1.0.0",
		nodes: [
			nodeType("plain", { url: { type: "string" }, n: { type: "integer" } }, ["url"]),
			nodeType("pick", { source: agentInput }, ["source"]),
			nodeType("notify", { bot: botInput, backup: botInput, other: botInput }),
		],
	}),
);
/** strict：声明了 requires_agent 的节点包。 */
const strict = packageArchive(
	packageMetadata({
		name: "strict",
		version: "1.0.0",
		requires_agent: ">=1.1",
		nodes: [nodeType("pick", { source: agentInput }, ["source"])],
	}),
);

describe("派发内容", () => {
	let cp: TestControlPlane;
	let database: Database;

	beforeAll(async () => {
		cp = await startTestControlPlane();
		for (const archive of [demo, strict]) {
			expect((await cp.fetch("/projects/default/packages", publishInit(archive))).status).toBe(201);
		}
		// 被引用的 Agent：注册过、现在离线；一台版本够，一台太旧。
		for (const [name, agentVersion] of [
			["new-agent", "1.2.0"],
			["old-agent", "1.0.0"],
		] as const) {
			await (await FakeAgent.connect(cp.grpcUrl, { name, agentVersion })).close();
		}
		database = openDatabase(cp.database.url, () => {});
	});
	afterAll(async () => {
		await database.close();
		await cp.close();
	});

	const content = createAssignContent({
		packageArchiveUrl: (project, name, version) =>
			`http://sfly.test/${project}/${name}/${version}/archive`,
		artifactUploadUrl: (taskId) => `http://sfly.test/artifacts/${taskId}`,
		artifactLimitBytes: 5000,
	});
	const scope = (
		params: Record<string, unknown> = {},
		earlier: Record<string, Record<string, unknown>> = {},
	): ResolveScope => ({ params, earlierOutputs: new Map(Object.entries(earlier)) });
	const node = (over: Partial<PackageNode> = {}): PackageNode => ({
		id: "n1",
		kind: "package",
		always: false,
		package: "demo",
		node: "plain",
		inputs: {},
		...over,
	});
	const request = (over: Partial<AssignRequest> = {}): AssignRequest => ({
		task: { id: "task-1", attempt: 2, runId: "run-1" },
		project: DEFAULT_PROJECT,
		node: node(),
		packageVersion: "1.0.0",
		scope: scope(),
		target: { name: "runner", info: { agent_version: "1.2.0" } },
		...over,
	});
	/** 在事务里回答，和引擎调用它的方式一样。 */
	const assign = (over: Partial<AssignRequest> = {}) =>
		database.db.transaction((tx) => content(tx, request(over)));

	it("可以派发：输入按作用域解析，派发内容带下载地址、sha256、产物上传地址和默认超时", async () => {
		const result = await assign({
			node: node({ inputs: { url: "${{ params.host }}", n: 3 } }),
			scope: scope({ host: "http://target" }),
		});
		const inputs = { url: "http://target", n: 3 };
		expect(result).toEqual({
			ok: true,
			inputs,
			referencedFeishuBots: [],
			assign: {
				taskId: "task-1",
				attempt: 2,
				package: "demo",
				packageVersion: "1.0.0",
				node: "plain",
				inputsJson: JSON.stringify(inputs),
				timeoutSeconds: 3600,
				runId: "run-1",
				nodeId: "n1",
				packageSha256: createHash("sha256").update(demo).digest("hex"),
				packageUrl: "http://sfly.test/default/demo/1.0.0/archive",
				artifactUploadUrl: "http://sfly.test/artifacts/task-1",
				artifactLimitBytes: 5000n,
				referencedAgents: [],
				referencedFeishuBots: [],
			},
		});
	});

	it("包版本只在第三个私有项目里：派发视为没有发布（不下发地址和 sha256，不用它的元信息）；公共项目里的照常下发", async () => {
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			await client.query(
				"insert into projects (id, display_name, created_at) values ('third-team', '第三个', now())",
			);
			// 它的元信息里 plain 要求 url：用了这份元信息，下面不给 url 的派发就会以配置错误失败。
			const insert = (name: string, project: string) =>
				client.query(
					`insert into node_packages (name, version, project_id, metadata, file_path, sha256, size, published_at)
					 values ($1, '2.0.0', $2, $3, $4, 'ffff', 1, now())`,
					[
						name,
						project,
						JSON.stringify(
							packageMetadata({
								name,
								version: "2.0.0",
								nodes: [nodeType("plain", { url: { type: "string" } }, ["url"])],
							}),
						),
						`packages/${name}/2.0.0.sflypkg`,
					],
				);
			await insert("elsewhere", "third-team");
			await insert("shared", "public");
		} finally {
			await client.end();
		}
		const hidden = await assign({ node: node({ package: "elsewhere" }), packageVersion: "2.0.0" });
		expect(hidden).toMatchObject({ ok: true, assign: { packageSha256: "", packageUrl: "" } });
		// 对照：在它自己的项目里派发，拿得到；公共项目里的包任何项目都拿得到。
		const own = await assign({
			project: "third-team" as ProjectId,
			node: node({ package: "elsewhere", inputs: { url: "http://x" } }),
			packageVersion: "2.0.0",
		});
		expect(own).toMatchObject({
			ok: true,
			assign: { packageUrl: "http://sfly.test/third-team/elsewhere/2.0.0/archive" },
		});
		const fromPublic = await assign({
			node: node({ package: "shared", inputs: { url: "http://x" } }),
			packageVersion: "2.0.0",
		});
		expect(fromPublic).toMatchObject({
			ok: true,
			assign: { packageSha256: "ffff", packageUrl: "http://sfly.test/public/shared/2.0.0/archive" },
		});
	});

	it("产物上限是 Infinity 或超过 uint64 时夹在 uint64 的最大值：派发内容能序列化（不让派发出错）", async () => {
		for (const wild of [Number.POSITIVE_INFINITY, 1e30]) {
			const wildContent = createAssignContent({
				packageArchiveUrl: (project, name, version) =>
					`http://sfly.test/${project}/${name}/${version}/archive`,
				artifactUploadUrl: (taskId) => `http://sfly.test/artifacts/${taskId}`,
				artifactLimitBytes: wild,
			});
			const result = await database.db.transaction((tx) =>
				wildContent(tx, request({ node: node({ inputs: { url: "u" } }) })),
			);

			expect(result).toMatchObject({ ok: true, assign: { artifactLimitBytes: 2n ** 64n - 1n } });
			if (!result.ok) throw new Error("派发内容应该能生成");
			expect(() =>
				toBinary(AssignTaskSchema, create(AssignTaskSchema, result.assign)),
			).not.toThrow();
		}
	});

	it("产物上限是 0、负数或 NaN：造派发内容的函数时就抛出（不留到派发时，也不悄悄下发成「没有上限」）", () => {
		for (const bad of [0, -1, Number.NaN]) {
			expect(
				() =>
					createAssignContent({
						packageArchiveUrl: () => "",
						artifactUploadUrl: () => "",
						artifactLimitBytes: bad,
					}),
				String(bad),
			).toThrow(/不合法/);
		}
	});

	it("节点自己设了超时就用它", async () => {
		const result = await assign({ node: node({ inputs: { url: "u" }, timeout: 90 }) });
		expect(result).toMatchObject({ ok: true, assign: { timeoutSeconds: 90 } });
	});

	it("控制面没有这个版本的节点包时不带下载地址，也不校验输入", async () => {
		const result = await assign({ node: node({ package: "ghost" }), packageVersion: "9.9.9" });
		expect(result).toMatchObject({
			ok: true,
			assign: { packageSha256: "", packageUrl: "", packageVersion: "9.9.9" },
		});
	});

	it("引用解析不出来：config_error，还没有可记的输入", async () => {
		const result = await assign({
			node: node({ inputs: { url: "${{ nodes.a.outputs.missing }}" } }),
			scope: scope({}, { a: {} }),
		});
		expect(result).toMatchObject({ ok: false, kind: "config_error" });
		expect(result).not.toHaveProperty("inputs");
	});

	it("输入类型不符：config_error，带已解析的输入让调用方记在任务上", async () => {
		const result = await assign({ node: node({ inputs: { url: 42 } }) });
		expect(result).toEqual({
			ok: false,
			kind: "config_error",
			message: "输入 url 应为 string，实际是 42",
			inputs: { url: 42 },
		});
	});

	it("节点所在的 Agent 版本不满足节点包的要求：env_error，输入校验之前就失败，没有可记的输入", async () => {
		const result = await assign({
			node: node({ package: "strict", node: "pick", inputs: { source: "new-agent" } }),
			target: { name: "runner", info: { agent_version: "1.0.0" } },
		});
		expect(result).toMatchObject({ ok: false, kind: "env_error" });
		expect(result).not.toHaveProperty("inputs");
	});

	it("开发版本的元信息取目标 Agent 上报的", async () => {
		const dev = packageMetadata({
			name: "devpkg",
			version: "dev",
			nodes: [nodeType("plain", { url: { type: "string" } }, ["url"])],
		});
		const target = {
			name: "runner",
			info: {
				agent_version: "1.2.0",
				dev_packages: [{ name: "devpkg", source: "/src/devpkg", metadata: dev }],
			},
		};
		const dispatch = { node: node({ package: "devpkg" }), packageVersion: "dev" };
		expect(await assign({ ...dispatch, target })).toMatchObject({
			ok: false,
			kind: "config_error",
			message: "缺少必填输入 url",
			inputs: {},
		});
		// 目标 Agent 没有加载它：不知道节点类型，不校验（Agent 会以 env_error 失败）。
		expect(
			await assign({ ...dispatch, target: { name: "runner", info: { agent_version: "1.2.0" } } }),
		).toMatchObject({ ok: true, assign: { packageUrl: "", packageSha256: "" } });
	});

	it("「Agent」类型的输入引用的 Agent 没有注册过：config_error，带已解析的输入", async () => {
		const result = await assign({ node: node({ node: "pick", inputs: { source: "ghost" } }) });
		expect(result).toMatchObject({
			ok: false,
			kind: "config_error",
			inputs: { source: "ghost" },
		});
	});

	it("引用的 Agent 版本太旧：env_error，带已解析的输入；版本够的随派发内容下发", async () => {
		const pick = (source: string) => node({ package: "strict", node: "pick", inputs: { source } });
		expect(await assign({ node: pick("old-agent") })).toMatchObject({
			ok: false,
			kind: "env_error",
			inputs: { source: "old-agent" },
		});
		const result = await assign({ node: pick("new-agent") });
		expect(result).toMatchObject({ ok: true });
		expect(result.ok && result.assign.referencedAgents?.map((a) => a.name)).toEqual(["new-agent"]);
	});

	it("「飞书机器人」类型的输入引用的机器人去重，记在任务上并随派发内容下发", async () => {
		const result = await assign({
			node: node({ node: "notify", inputs: { bot: "ops", backup: "ops", other: "dev" } }),
		});
		expect(result).toMatchObject({
			ok: true,
			referencedFeishuBots: ["ops", "dev"],
			assign: { referencedFeishuBots: ["ops", "dev"] },
		});
	});
});
