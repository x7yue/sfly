// 保存时的检查、局部编辑、预检、触发时的参数检查和派发，按名字找 Agent 和节点包时只看场景（运行）所在的项目（#610，ADR 0029）：
// 本项目的，加公共项目里的节点包；别的项目的 Agent 和节点包，和没有注册过、没有发布过一样，说明也是同一句，
// 不透露它在别的项目里存在。
//
// 真实控制面和数据库。HTTP 接口现在还只认默认项目（#488 之前路径里没有项目），所以别的项目的资源用库里的
// 一条 `update` 造出来：Agent 先正常连上，再把它的记录改到项目 `alpha`；节点包先发布，再改到 `alpha` 或 `public`；
// 场景同理。每一条断言都对着一个对照：同样的场景用本项目的 Agent、节点包做一遍，没有被拒绝。
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { TestAccounts } from "./support/credentials.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent, type HelloInit } from "./support/fake-agent.js";
import { putFocusItems } from "./support/focus-items.js";
import {
	packageArchive,
	packageMetadata,
	publishInit,
	publishPackage,
} from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 节点包里「Agent」类型的输入：和 agent-inputs.test.ts 一样的 `logs` 包。 */
const logsMetadata = (name = "logs") =>
	packageMetadata({
		name,
		version: "1.0.0",
		nodes: [
			{
				name: "clean",
				title: "清洗",
				entry: `${name.replace(/-/g, "_")}:clean`,
				inputs: {
					type: "object",
					properties: { source: { type: "string", "x-sfly-type": "agent" } },
					required: ["source"],
					order: ["source"],
				},
				outputs: { type: "object", properties: {} },
			},
			{
				name: "pick",
				title: "选择",
				entry: `${name.replace(/-/g, "_")}:pick`,
				inputs: { type: "object", properties: {} },
				outputs: { type: "object", properties: { agent: { type: "string" } } },
			},
		],
	});

/** 开发版本的元信息：一个节点 `ping`，只声明了输入 `host`。 */
const devMetadata = (name: string) =>
	JSON.stringify({
		name,
		version: "dev",
		requires_python: ">=3.10",
		nodes: [
			{
				name: "ping",
				title: "Ping",
				entry: `${name}:ping`,
				inputs: {
					type: "object",
					properties: { host: { type: "string" } },
					required: [],
					order: ["host"],
				},
				outputs: { type: "object", properties: {} },
			},
		],
	});

interface Problem {
	code: string;
	message: string;
	node_id?: string;
}

const node = (id: string, pkg: string, name: string, extra: Record<string, unknown> = {}) => ({
	id,
	kind: "package",
	package: pkg,
	node: name,
	inputs: {},
	...extra,
});

/** 入口 → 一串包节点（按给的顺序连成一条链）。 */
const chain = (
	defaultAgent: string,
	nodes: Record<string, unknown>[],
	packages: Record<string, string>,
	params: { name: string; type: string }[] = [],
) => ({
	default_agent: defaultAgent,
	nodes: [{ id: "entry", kind: "entry", params }, ...nodes],
	edges: nodes.map((n, i) => ({
		from: i === 0 ? "entry" : (nodes[i - 1] as { id: string }).id,
		to: n.id as string,
		kind: "chain",
	})),
	packages,
});

/** 一个没有登记过的 Agent 名字：用来拿「别的项目的 Agent」的说明和它比，两者必须一样。 */
const NOBODY = "nobody";

describe("按项目找 Agent 和节点包（保存、检查、局部编辑、预检、触发、派发）", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let accounts: TestAccounts;
	let sql: pg.Client;
	const agents: FakeAgent[] = [];

	const connect = async (hello: HelloInit, project = "default") => {
		const agent = await FakeAgent.connect(cp.grpcUrl, hello);
		agents.push(agent);
		if (project !== "default") await moveAgent(hello.name, project);
		return agent;
	};
	/** 注册过、现在离线的 Agent。 */
	const registerOffline = async (name: string, project = "default") => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name });
		await agent.close();
		await eventually(async () => {
			const { agents: list } = await api.getJson<{ agents: { name: string; status: string }[] }>(
				"/agents",
			);
			expect(list.find((a) => a.name === name)?.status).toBe("offline");
		});
		if (project !== "default") await moveAgent(name, project);
	};
	const moveAgent = (name: string, project: string) =>
		sql.query("update agents set project_id = $2 where name = $1", [name, project]);
	const movePackage = (name: string, project: string) =>
		sql.query("update node_packages set project_id = $2 where name = $1", [name, project]);

	/** 新建一个场景（在默认项目里或 `alpha` 里）、存下文档，返回场景 ID 和保存时的警告。 */
	const scenario = async (doc: unknown, project = "default") => {
		const id = await api.createOrchestration(`场景 ${Math.random().toString(36).slice(2, 8)}`);
		if (project !== "default") {
			await sql.query("update orchestrations set project_id = $2 where id = $1", [id, project]);
		}
		return { id, warnings: await save(id, doc) };
	};
	const save = async (id: string, doc: unknown): Promise<Problem[]> => {
		const res = await api.post(`/orchestrations/${id}/versions`, {
			base_version: await api.headVersion(id),
			document: doc,
		});
		expect(res.status, await res.clone().text()).toBe(201);
		return ((await res.json()) as { warnings: Problem[] }).warnings;
	};
	const check = async (id: string, doc: unknown): Promise<Problem[]> => {
		const res = await api.post(`/orchestrations/${id}/check`, {
			base_version: await api.headVersion(id),
			document: doc,
		});
		expect(res.status, await res.clone().text()).toBe(200);
		return ((await res.json()) as { warnings: Problem[] }).warnings;
	};
	const preflight = (id: string) =>
		api.getJson<{ problems: Problem[]; agents: { name: string; status: string }[] }>(
			`/orchestrations/${id}/preflight`,
		);

	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		accounts = new TestAccounts(cp.database.url);
		sql = new pg.Client({ connectionString: cp.database.url });
		await sql.connect();
		await accounts.project("alpha");
		await accounts.project("public");

		// 节点包：默认项目里的 logs，只在项目 alpha 里的 alpha-only，在公共项目里的 public-only。
		for (const name of ["logs", "logs-alpha"]) {
			const published = await cp.fetch(
				"/packages",
				publishInit(packageArchive(logsMetadata(name))),
			);
			expect(published.status, name).toBe(201);
		}
		await publishPackage(cp, "alpha-only", "1.0.0", { scan: ["found"] });
		await publishPackage(cp, "public-only", "1.0.0", { scan: ["found"] });
		const gauge = (title: string) => ({
			outputs: [],
			metrics: [{ name: "load", unit: "x", kind: "gauge" as const }],
			charts: [{ title, type: "line" as const, metrics: ["load"] }],
		});
		await publishPackage(cp, "charts-default", "1.0.0", { scan: gauge("负载") });
		await publishPackage(cp, "charts-alpha", "1.0.0", { scan: gauge("负载") });
		await publishPackage(cp, "charts-public", "1.0.0", { scan: gauge("负载") });
		await movePackage("alpha-only", "alpha");
		await movePackage("charts-alpha", "alpha");
		await movePackage("charts-public", "public");
		await movePackage("logs-alpha", "alpha");
		await movePackage("public-only", "public");

		// Agent：默认项目里的 runner、peer；项目 alpha 里的 foreign（在线）和 foreign-off（离线）。
		await connect({ name: "runner" });
		await connect({ name: "peer", peer: { port: 50061 } });
		await connect({ name: "foreign", peer: { port: 50062 } }, "alpha");
		await registerOffline("foreign-off", "alpha");
	});
	afterAll(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await sql?.end();
		await accounts?.close();
		await cp?.close();
	});

	const cleanWith = (source: string, agent = "runner", pkg = "logs") =>
		chain(agent, [node("c", pkg, "clean", { inputs: { source } })], { [pkg]: "1.0.0" });

	it("保存和检查：「Agent」类型的输入选了别的项目的 Agent，警告和没有注册过的一样；本项目的 Agent 不警告，反过来也一样", async () => {
		const own = await scenario(cleanWith("peer"));
		expect(own.warnings).toEqual([]);

		const ghost = (await scenario(cleanWith(NOBODY))).warnings;
		expect(ghost).toMatchObject([{ code: "agent_input_not_registered", node_id: "c" }]);
		for (const foreign of ["foreign", "foreign-off"]) {
			const { id, warnings } = await scenario(cleanWith(foreign));
			// 同一种警告、同一个位置，说明里只有名字不同：看不出它在别的项目里存在。
			expect(
				warnings.map(({ code, node_id }) => ({ code, node_id })),
				foreign,
			).toEqual(ghost.map(({ code, node_id }) => ({ code, node_id })));
			expect(warnings[0]?.message, foreign).toBe(ghost[0]?.message.replace(NOBODY, foreign));
			// 检查和保存是同一段校验。
			expect(
				(await check(id, cleanWith(foreign))).map((w) => w.code),
				foreign,
			).toEqual(warnings.map((w) => w.code));
		}

		// 反过来：项目 alpha 里的场景，默认项目的 Agent 是别人的，alpha 自己的 Agent 不警告。
		const alphaOwn = await scenario(cleanWith("foreign", "foreign", "logs-alpha"), "alpha");
		expect(alphaOwn.warnings).toEqual([]);
		const alphaForeign = await scenario(cleanWith("peer", "foreign", "logs-alpha"), "alpha");
		expect(alphaForeign.warnings).toMatchObject([{ code: "agent_input_not_registered" }]);
	});

	it("保存：锁定的包版本只在别的项目里发布过，和没有发布过一样；公共项目里的包任何项目都能用", async () => {
		const only = (pkg: string) => chain("runner", [node("a", pkg, "scan")], { [pkg]: "1.0.0" });
		const missing = (await scenario(only("never-published"))).warnings;
		expect(missing.length).toBeGreaterThan(0);

		const foreignPkg = await scenario(only("alpha-only"));
		expect(foreignPkg.warnings.map((w) => w.code)).toEqual(missing.map((w) => w.code));
		expect(foreignPkg.warnings.map((w) => w.node_id)).toEqual(missing.map((w) => w.node_id));
		expect((await check(foreignPkg.id, only("alpha-only"))).map((w) => w.code)).toEqual(
			foreignPkg.warnings.map((w) => w.code),
		);

		// 项目 alpha 里的场景用它自己的包：不警告；用默认项目的 logs：警告。
		expect((await scenario(only("alpha-only"), "alpha")).warnings).toEqual([]);
		const alphaLogs = chain("foreign", [node("c", "logs", "pick")], { logs: "1.0.0" });
		expect((await scenario(alphaLogs, "alpha")).warnings.length).toBeGreaterThan(0);

		// 公共项目里的包：默认项目和 alpha 的场景都不警告。
		expect((await scenario(only("public-only"))).warnings).toEqual([]);
		expect((await scenario(only("public-only"), "alpha")).warnings).toEqual([]);
	});

	it("节点类型的声明（关注项的图表）也只在场景所在的项目里找：别的项目发布的包没有这张图表，公共项目的有", async () => {
		// 把图表设为关注项要求节点类型声明了它：别的项目发布的包的图表和没有发布过一样，被拒绝。
		const focus = async (pkg: string, project = "default") => {
			const doc = chain("runner", [node("a", pkg, "scan")], { [pkg]: "1.0.0" });
			const { id } = await scenario(doc, project);
			const res = await putFocusItems(api, id, [{ node_id: "a", chart: "负载" }]);
			if (res.status === 200) return "ok";
			return ((await res.json()) as { error: { code: string } }).error.code;
		};
		expect(await focus("charts-default")).toBe("ok");
		expect(await focus("charts-public")).toBe("ok");
		expect(await focus("charts-alpha")).toBe("focus_item_unknown_chart");
		expect(await focus("charts-alpha", "alpha")).toBe("ok");
		expect(await focus("charts-default", "alpha")).toBe("focus_item_unknown_chart");
	});

	it("复制场景和恢复历史版本带出的警告也按场景所在的项目：别的项目发布的包和没有发布过一样", async () => {
		const only = (pkg: string) => chain("runner", [node("a", pkg, "scan")], { [pkg]: "1.0.0" });
		const warningsOf = async (res: Response) => {
			expect(res.status, await res.clone().text()).toBe(201);
			return ((await res.json()) as { warnings: Problem[] }).warnings.map((w) => w.code);
		};
		const copyAndRestore = async (pkg: string, project: string) => {
			const { id } = await scenario(only(pkg), project);
			const copied = await warningsOf(
				await api.post(`/orchestrations/${id}/copy`, { name: "副本" }),
			);
			const restored = await warningsOf(
				await api.postEmpty(`/orchestrations/${id}/versions/1/restore`),
			);
			return { copied, restored };
		};
		const missing = await copyAndRestore("never-published", "default");
		expect(missing.copied.length).toBeGreaterThan(0);
		expect(await copyAndRestore("alpha-only", "default")).toEqual(missing);
		expect(await copyAndRestore("alpha-only", "alpha")).toEqual({ copied: [], restored: [] });
		expect(await copyAndRestore("public-only", "default")).toEqual({ copied: [], restored: [] });
	});

	it("局部编辑：改成别的项目的 Agent 警告同保存；加别的项目发布的包和加没有发布过的包是同一种错误", async () => {
		const { id } = await scenario(cleanWith("peer"));
		const edit = (operations: unknown[]) =>
			api.post(`/orchestrations/${id}/edits/check`, {
				base_version: 1,
				operations,
			});
		const warningsOf = async (res: Response) => {
			expect(res.status, await res.clone().text()).toBe(200);
			return ((await res.json()) as { warnings: Problem[] }).warnings;
		};
		const setSource = (value: string) => [{ op: "set", node: "c", field: "inputs.source", value }];
		expect(await warningsOf(await edit(setSource("peer")))).toEqual([]);
		const ghost = await warningsOf(await edit(setSource(NOBODY)));
		expect(ghost).toMatchObject([{ code: "agent_input_not_registered", node_id: "c" }]);
		const foreign = await warningsOf(await edit(setSource("foreign")));
		expect(foreign.map((w) => w.code)).toEqual(ghost.map((w) => w.code));

		const add = async (pkg: string) => {
			const res = await edit([{ op: "add_node", package: pkg, node: "scan", after: "c" }]);
			expect(res.status, pkg).toBe(400);
			return ((await res.json()) as { error: { code: string; message: string; details: unknown } })
				.error;
		};
		const missing = await add("never-published");
		const foreignPkg = await add("alpha-only");
		// 同一种错误、同一句话：只有调用方自己写的包名不同，看不出它在别的项目里发布过。
		expect(foreignPkg.code).toBe(missing.code);
		expect(foreignPkg.message).toBe(missing.message.replace("never-published", "alpha-only"));
		expect(JSON.stringify(foreignPkg.details)).toBe(
			JSON.stringify(missing.details).replace("never-published", "alpha-only"),
		);
		// 公共项目里的包可以加。
		const publicAdd = await edit([
			{ op: "add_node", package: "public-only", node: "scan", after: "c" },
		]);
		expect(publicAdd.status, await publicAdd.clone().text()).toBe(200);
	});

	it("预检：节点派发到别的项目的 Agent，和没有注册过一样阻断，触发被拒绝；预检里那台 Agent 的状态是未知，不是在线", async () => {
		const toAgent = (agent: string) =>
			chain("runner", [node("a", "logs", "pick", { agent })], { logs: "1.0.0" });
		const own = await scenario(toAgent("peer"));
		expect((await preflight(own.id)).problems).toEqual([]);

		const ghost = await scenario(toAgent(NOBODY));
		const ghostProblems = (await preflight(ghost.id)).problems;
		expect(ghostProblems).toMatchObject([{ code: "agent_not_registered", node_id: "a" }]);

		for (const foreign of ["foreign", "foreign-off"]) {
			const { id } = await scenario(toAgent(foreign));
			const result = await preflight(id);
			expect(
				result.problems.map(({ code, node_id }) => ({ code, node_id })),
				foreign,
			).toEqual(ghostProblems.map(({ code, node_id }) => ({ code, node_id })));
			expect(result.problems[0]?.message, foreign).toBe(
				ghostProblems[0]?.message.replace(NOBODY, foreign),
			);
			// 预检响应里引用到的 Agent：别的项目的 Agent 没有状态可看，和没有注册过一样。
			expect(
				result.agents.find((a) => a.name === foreign),
				foreign,
			).toMatchObject({
				status: "unknown",
			});
			const refused = await api.trigger(id);
			expect(refused.status, foreign).toBe(400);
			expect(((await refused.json()) as { error: { code: string } }).error.code, foreign).toBe(
				"invalid_orchestration",
			);
			const { runs } = await api.getJson<{ runs: unknown[] }>(`/orchestrations/${id}/runs`);
			expect(runs, foreign).toEqual([]);
		}
		expect((await preflight(own.id)).agents.find((a) => a.name === "peer")).toMatchObject({
			status: "online",
		});
	});

	it("预检和保存：开发版本的节点类型只取本项目的 Agent 上报的元信息，别的项目的 Agent 上报的当作不知道", async () => {
		await connect({
			name: "dev-own",
			devPackages: [
				{ name: "demo-dev", source: "/src/demo-dev", metadataJson: devMetadata("demo-dev") },
			],
		});
		await connect(
			{
				name: "dev-foreign",
				devPackages: [
					{ name: "demo-dev", source: "/src/demo-dev", metadataJson: devMetadata("demo-dev") },
				],
			},
			"alpha",
		);
		// 输入 `bogus` 没有在元信息里声明：知道节点类型时警告，不知道时没有这条警告。
		const ping = (agent: string) =>
			chain("runner", [node("a", "demo-dev", "ping", { agent, inputs: { bogus: "x" } })], {
				"demo-dev": "dev",
			});
		const own = await scenario(ping("dev-own"));
		expect(own.warnings.map((w) => w.code)).toEqual(["input_not_declared"]);
		const foreign = await scenario(ping("dev-foreign"));
		expect(foreign.warnings.map((w) => w.code)).toEqual([]);
		// 预检：那台 Agent 没有注册过，派发的目标不对；不会因为它加载了开发版本就多出别的结论。
		expect((await preflight(foreign.id)).problems.map((p) => p.code)).toEqual([
			"agent_not_registered",
		]);
		// 别的项目里在线、没有加载开发版本的 Agent：同样只是「没有注册过」，预检不多说它在线、没有加载。
		const notLoaded = await scenario(ping("foreign"));
		expect((await preflight(notLoaded.id)).problems.map((p) => p.code)).toEqual([
			"agent_not_registered",
		]);
	});

	it("触发时按入口参数的实际值检查：参数指向别的项目的 Agent，和没有注册过的一样被拒绝", async () => {
		const doc = chain(
			"runner",
			[node("c", "logs", "clean", { inputs: { source: "${{ params.src }}" } })],
			{ logs: "1.0.0" },
			[{ name: "src", type: "string" }],
		);
		const { id, warnings } = await scenario(doc);
		expect(warnings).toEqual([]);
		const rejection = async (src: string) => {
			const res = await api.trigger(id, { src });
			expect(res.status, src).toBe(400);
			return (
				(await res.json()) as { error: { code: string; message: string; details: Problem[] } }
			).error;
		};
		const ghost = await rejection(NOBODY);
		expect(ghost.code).toBe("invalid_params");
		for (const foreign of ["foreign", "foreign-off"]) {
			const error = await rejection(foreign);
			expect(error.code, foreign).toBe("invalid_params");
			expect(
				error.details.map((d) => d.code),
				foreign,
			).toEqual(["agent_input_not_registered"]);
			expect(error.message, foreign).toBe(ghost.message.replace(NOBODY, foreign));
		}
		expect((await api.trigger(id, { src: "peer" })).status).toBe(201);
	});

	describe("派发", () => {
		/** 每个测试自己的入口 Agent：别的测试留在 runner 上没取走的任务不会混进来。 */
		let entries = 0;
		const entryAgent = async () => connect({ name: `entry-${++entries}` });
		const twoNodes = (first: string, second: string) =>
			chain(first, [node("a", "logs", "pick"), node("b", "logs", "pick", { agent: second })], {
				logs: "1.0.0",
			});
		const failed = async (runId: string, nodeId: string, agent: string) => {
			await eventually(async () => {
				const view = await api.node(runId, nodeId);
				expect(view.status).toBe("failed");
				expect(view.error).toEqual({
					kind: "config_error",
					message: `节点 ${nodeId} 派发到的 Agent ${agent} 还没有注册过`,
					location: null,
				});
			});
		};

		it("入队时核对项目：预检之后目标 Agent 才换了项目，任务不入队，按配置错误失败，那台 Agent 没有收到任务", async () => {
			const entry = await entryAgent();
			const mover = await connect({ name: "mover" });
			const { id } = await scenario(twoNodes(entry.name, "mover"));
			expect((await preflight(id)).problems).toEqual([]);

			const runId = await api.triggerOk(id);
			const first = await entry.nextAssign();
			// 节点 a 还在执行时，mover 被换到了别的项目：预检时它还是本项目的。
			await moveAgent("mover", "alpha");
			await entry.succeed(first, { agent: "x" });

			await failed(runId, "b", "mover");
			expect((await api.node(runId, "b")).attempts[0]?.agent).toBeNull();
			await mover.expectNoAssign();
			expect((await api.run(runId)).status).toBe("failed");
		});

		it("同一个场景里目标 Agent 还在本项目：照常派发（对照）", async () => {
			const entry = await entryAgent();
			const stays = await connect({ name: "stays" });
			const { id } = await scenario(twoNodes(entry.name, "stays"));
			const runId = await api.triggerOk(id);
			await entry.succeed(await entry.nextAssign(), { agent: "x" });
			const assign = await stays.nextAssign();
			expect(assign.nodeId).toBe("b");
			await stays.succeed(assign, { agent: "y" });
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
		});

		it("场景和 Agent 都在另一个项目（alpha）里：照常入队、派发、完成（对照：不是只有默认项目的场景能跑）", async () => {
			const entry = await connect({ name: `entry-alpha-${++entries}` }, "alpha");
			const second = await connect({ name: `second-alpha-${entries}` }, "alpha");
			const doc = chain(
				entry.name,
				[node("a", "logs-alpha", "pick"), node("b", "logs-alpha", "pick", { agent: second.name })],
				{ "logs-alpha": "1.0.0" },
			);
			const { id, warnings } = await scenario(doc, "alpha");
			expect(warnings).toEqual([]);
			expect((await preflight(id)).problems).toEqual([]);
			const runId = await api.triggerOk(id);
			await entry.succeed(await entry.nextAssign(), { agent: "x" });
			const assign = await second.nextAssign();
			expect(assign.nodeId).toBe("b");
			await second.succeed(assign, { agent: "y" });
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
		});

		it("已经在排队的任务：目标 Agent 之后换了项目，它上线派发时任务按配置错误失败，不卡在队里，Agent 没有收到任务", async () => {
			await registerOffline("late");
			const { id } = await scenario(chain("late", [node("a", "logs", "pick")], { logs: "1.0.0" }));
			const runId = await api.triggerOk(id);
			expect((await api.node(runId, "a")).status).toBe("queued");
			await moveAgent("late", "alpha");

			const late = await connect({ name: "late" }, "alpha");
			await failed(runId, "a", "late");
			await late.expectNoAssign();
		});

		it("「Agent」类型的输入的值取自前面节点的输出、指向别的项目的 Agent：派发时按配置错误失败，注册信息不下发；指向本项目的 Agent 照常下发", async () => {
			const entry = await entryAgent();
			const { id } = await scenario(
				chain(
					entry.name,
					[
						node("pick", "logs", "pick"),
						node("c", "logs", "clean", { inputs: { source: "${{ nodes.pick.outputs.agent }}" } }),
					],
					{ logs: "1.0.0" },
				),
			);

			const toForeign = await api.triggerOk(id);
			await entry.succeed(await entry.nextAssign(), { agent: "foreign" });
			await eventually(async () => {
				const view = await api.node(toForeign, "c");
				expect(view.status).toBe("failed");
				expect(view.error).toEqual({
					kind: "config_error",
					message: "节点 c 的输入 source 选择的 Agent foreign 还没有注册过",
					location: null,
				});
			});
			// 任务没有派发出去：它的地址、端口、版本没有发给任何 Agent。
			await entry.expectNoAssign();

			const toOwn = await api.triggerOk(id);
			await entry.succeed(await entry.nextAssign(), { agent: "peer" });
			const clean = await entry.nextAssign();
			expect(clean.referencedAgents.map((a) => [a.name, a.port])).toEqual([["peer", 50061]]);
			await entry.succeed(clean, {});
			await eventually(async () => expect((await api.run(toOwn)).status).toBe("success"));
		});

		it("公共项目里的节点包：任何项目的场景都能预检、派发", async () => {
			const entry = await entryAgent();
			const { id, warnings } = await scenario(
				chain(entry.name, [node("a", "public-only", "scan")], { "public-only": "1.0.0" }),
			);
			expect(warnings).toEqual([]);
			expect((await preflight(id)).problems).toEqual([]);
			await api.triggerOk(id);
			const assign = await entry.nextAssign();
			expect(assign.package).toBe("public-only");
		});

		it("控制面启动时：升级前排上队、已经派出去的任务，目标 Agent 属于别的项目的，按配置错误失败", async () => {
			await registerOffline("waiting");
			const sitting = await connect({ name: "holding" });
			const queued = await scenario(
				chain("waiting", [node("a", "logs", "pick")], { logs: "1.0.0" }),
			);
			const held = await scenario(chain("holding", [node("a", "logs", "pick")], { logs: "1.0.0" }));
			const queuedRun = await api.triggerOk(queued.id);
			const heldRun = await api.triggerOk(held.id);
			await sitting.nextAssign();
			expect((await api.node(queuedRun, "a")).status).toBe("queued");
			await moveAgent("waiting", "alpha");
			await moveAgent("holding", "alpha");

			await cp.restart();

			await failed(queuedRun, "a", "waiting");
			await failed(heldRun, "a", "holding");
			expect((await api.run(queuedRun)).status).toBe("failed");
			expect((await api.run(heldRun)).status).toBe("failed");
		});
	});
});
