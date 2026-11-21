// 存储层按项目查询（ADR 0029，规格 #487）：在库里另建项目乙和它的场景、运行、Agent、节点包、飞书机器人，
// 用项目甲（默认项目）调用按项目查询的入口，列表里没有项目乙的任何一行，按 ID 或名字取项目乙的资源得到「不存在」；
// 项目乙自己调用时只看得到自己的（对照：证明上面的断言不是因为什么都查不到）。
// 入口的签名里项目是必填参数：漏传的调用过不了类型检查（文件末尾的 `@ts-expect-error`，`pnpm typecheck` 检查）。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsApi } from "@sfly/schema";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentHub } from "../src/agents/agent-hub.js";
import { dashboardView } from "../src/dashboard/dashboard-stats.js";
import { setupSummary } from "../src/dashboard/setup-summary.js";
import { type Database, openDatabase } from "../src/db/database.js";
import type { Engine } from "../src/engine/engine.js";
import { scenariosReferencingBot } from "../src/feishu/bot-references.js";
import { FeishuBots } from "../src/feishu/feishu-bots.js";
import { listOrchestrationSummaries } from "../src/orchestrations/orchestration-list.js";
import { OrchestrationStore } from "../src/orchestrations/orchestration-store.js";
import { createPackageRepository, PackageError } from "../src/packages/package-repository.js";
import { DEFAULT_PROJECT, type ProjectId, PUBLIC_PROJECT } from "../src/projects/project-id.js";
import { getRunViewInProject } from "../src/runs/run-in-project.js";
import { listAllRuns } from "../src/runs/run-list.js";
import { AsyncQueue } from "../src/util/async-queue.js";
import { Mutex } from "../src/util/mutex.js";
import { ApiClient } from "./support/api-client.js";
import { ManualClock } from "./support/manual-clock.js";
import { packageArchive, packageMetadata, publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

/** 项目乙：测试里直接写库建（建项目的接口在 #499）。 */
const OTHER = "other-team" as ProjectId;
const ACTOR = { nickname: "测试", via: null };
const AT = "2026-01-01T00:00:00Z";
const DOCUMENT = {
	default_agent: "agent-a",
	nodes: [{ id: "entry", kind: "entry" as const, params: [] }],
	edges: [],
	packages: {},
	annotations: [],
	sticky_notes: [],
};
const AGENT_INFO = { agent_version: "1.0.0", os: "linux", arch: "x86_64", slots: 2 };

/** 项目里的一整套资源（场景、版本、运行、Agent、节点包、飞书机器人），名字带项目标记以便区分。 */
interface Resources {
	scenario: string;
	run: string;
	agent: string;
	pkg: string;
	bot: string;
}

describe("存储层按项目查询：项目甲看不到项目乙", () => {
	let testDb: TestDatabase;
	let database: Database;
	let dataDir: string;
	const clock = new ManualClock();
	let scenarios: OrchestrationStore;
	let hub: AgentHub;
	let packages: ReturnType<typeof createPackageRepository>;
	let bots: FeishuBots;
	let a: Resources;
	let b: Resources;

	/** 用存储层的入口在 `project` 里建一整套资源。 */
	async function populate(project: ProjectId, tag: string): Promise<Resources> {
		const scenario = await scenarios.create(project, `场景${tag}`);
		await scenarios.saveVersion(scenario.id, DOCUMENT, ACTOR, 0);
		const version = (await scenarios.getVersion(scenario.id, 1))?.id;
		const run = crypto.randomUUID();
		await database.pool.query(
			`insert into runs (id, orchestration_id, orchestration_version_id, project_id, triggered_by, params, status, started_at)
			values ($1, $2, $3, $4, '测试', '{}', 'success', $5)`,
			[run, scenario.id, version, project, AT],
		);
		const agent = `agent-${tag}`;
		await hub.attach(project, agent, AGENT_INFO, new AsyncQueue());
		const pkg = `pkg-${tag}`;
		await packages.publish(
			project,
			packageArchive(packageMetadata({ name: pkg, version: "1.0.0" })),
		);
		const bot = `bot-${tag}`;
		await bots.create(project, bot, `https://open.feishu.cn/hook/${tag}`);
		return { scenario: scenario.id, run, agent, pkg, bot };
	}

	beforeAll(async () => {
		testDb = await createTestDatabase();
		database = openDatabase(testDb.url, () => {});
		await database.migrate();
		await database.pool.query(
			"insert into projects (id, display_name, created_at) values ($1, '项目乙', $2)",
			[OTHER, AT],
		);
		dataDir = await mkdtemp(join(tmpdir(), "sfly-isolation-"));
		const { db } = database;
		scenarios = new OrchestrationStore({ db, clock });
		hub = new AgentHub({ db, clock, mutex: new Mutex(), version: "1.0.0" });
		packages = createPackageRepository({ db, clock, dataDir });
		bots = new FeishuBots({
			db,
			clock,
			logs: { appendSystem: async () => {} },
			onError: (error) => {
				throw error;
			},
		});
		a = await populate(DEFAULT_PROJECT, "a");
		b = await populate(OTHER, "b");
		// 公共项目里的标准节点包：每个项目都读得到。
		await packages.publish(
			PUBLIC_PROJECT,
			packageArchive(packageMetadata({ name: "sfly-std", version: "0.1.0" })),
		);
	});
	afterAll(async () => {
		hub.closeAll();
		await database.close();
		await testDb.drop();
		await rm(dataDir, { recursive: true, force: true });
	});

	it("场景：列表只有本项目的，按 ID 取别的项目的场景得到「不存在」", async () => {
		const { db } = database;
		const names = async (project: ProjectId) =>
			(await listOrchestrationSummaries(db, project, {})).orchestrations.map((o) => o.name);
		expect(await names(DEFAULT_PROJECT)).toEqual(["场景a"]);
		expect(await names(OTHER)).toEqual(["场景b"]);

		expect((await scenarios.getInProject(DEFAULT_PROJECT, a.scenario))?.name).toBe("场景a");
		expect(await scenarios.getInProject(DEFAULT_PROJECT, b.scenario)).toBeUndefined();
		expect((await scenarios.getInProject(OTHER, b.scenario))?.name).toBe("场景b");
		expect(await scenarios.getInProject(OTHER, a.scenario)).toBeUndefined();

		// 每个项目只统计自己场景的最新版本文档；已归档的场景计数也只算本项目。
		expect(await scenarios.rawHeadDocuments(DEFAULT_PROJECT)).toHaveLength(1);
		expect(await scenarios.rawHeadDocuments(OTHER)).toHaveLength(1);
	});

	it("场景：新建的场景属于传入的项目，复制出的副本和源场景在同一个项目里", async () => {
		const copied = await scenarios.copy(b.scenario, "场景b的副本", ACTOR);
		expect(copied).toBeDefined();
		expect(await scenarios.getInProject(OTHER, copied?.id ?? "")).toBeDefined();
		expect(await scenarios.getInProject(DEFAULT_PROJECT, copied?.id ?? "")).toBeUndefined();
		const { rows } = await database.pool.query(
			"select project_id from orchestrations where id = $1",
			[copied?.id],
		);
		expect(rows).toEqual([{ project_id: OTHER }]);
		// 这个用例建的副本不留给后面的用例（项目乙里只有场景b）。
		const copy = copied?.id;
		await database.pool.query("delete from orchestration_versions where orchestration_id = $1", [
			copy,
		]);
		await database.pool.query("delete from orchestrations where id = $1", [copy]);
	});

	it("运行：列表和各状态的计数只有本项目的，按 ID 取别的项目的运行得到「不存在」", async () => {
		const { db } = database;
		const listed = async (project: ProjectId) => {
			const { runs, counts } = await listAllRuns(db, project, { limit: 50 });
			return { ids: runs.map((r) => r.id), counts };
		};
		expect(await listed(DEFAULT_PROJECT)).toMatchObject({
			ids: [a.run],
			counts: { success: 1, running: 0, failed: 0, cancelled: 0 },
		});
		expect(await listed(OTHER)).toMatchObject({ ids: [b.run], counts: { success: 1 } });

		expect((await getRunViewInProject(db, DEFAULT_PROJECT, a.run))?.id).toBe(a.run);
		expect(await getRunViewInProject(db, DEFAULT_PROJECT, b.run)).toBeUndefined();
		expect((await getRunViewInProject(db, OTHER, b.run))?.id).toBe(b.run);
		expect(await getRunViewInProject(db, OTHER, a.run)).toBeUndefined();
		// 按场景筛选也不会越过项目。
		expect(
			(await listAllRuns(db, DEFAULT_PROJECT, { limit: 50, orchestrationId: b.scenario })).runs,
		).toEqual([]);
	});

	it("运行：库里不让运行的项目和它的场景的项目不一致（直接插入被组合外键拒绝），按项目的查询不会读到错位的运行", async () => {
		const insert = (scenario: string, project: ProjectId) =>
			database.pool.query(
				`insert into runs (id, orchestration_id, orchestration_version_id, project_id, triggered_by, params, status, started_at)
				values ($1, $2, (select id from orchestration_versions where orchestration_id = $2), $3, '测试', '{}', 'success', $4)`,
				[crypto.randomUUID(), scenario, project, AT],
			);
		// 项目甲的场景、项目乙的运行，反过来也一样。
		await expect(insert(a.scenario, OTHER)).rejects.toThrow(/runs_orchestration_project_fk/);
		await expect(insert(b.scenario, DEFAULT_PROJECT)).rejects.toThrow(
			/runs_orchestration_project_fk/,
		);
		// 两边各自的运行数没变（拒绝之后没有留下半条）。
		const count = async (project: ProjectId) =>
			Number(
				(await database.pool.query("select count(*) from runs where project_id = $1", [project]))
					.rows[0].count,
			);
		expect(await count(DEFAULT_PROJECT)).toBe(1);
		expect(await count(OTHER)).toBe(1);
	});

	it("Agent：列表只有本项目的，按名字取别的项目的 Agent 得到「不存在」", async () => {
		const names = async (project: ProjectId) => (await hub.list(project)).map((x) => x.name);
		expect(await names(DEFAULT_PROJECT)).toEqual(["agent-a"]);
		expect(await names(OTHER)).toEqual(["agent-b"]);

		expect((await hub.find(DEFAULT_PROJECT, a.agent))?.name).toBe("agent-a");
		expect(await hub.find(DEFAULT_PROJECT, b.agent)).toBeUndefined();
		expect((await hub.find(OTHER, b.agent))?.name).toBe("agent-b");
		expect(await hub.find(OTHER, a.agent)).toBeUndefined();
		// 返回的视图符合接口契约。
		agentsApi.list.response.shape.agents.element.parse({
			...(await hub.find(DEFAULT_PROJECT, a.agent)),
			referencing_orchestrations: 0,
		});
	});

	it("节点包：列表只有本项目的和公共项目的，别的项目的包按名字、按版本、取归档都得到「不存在」", async () => {
		const names = async (project: ProjectId) => (await packages.list(project)).map((p) => p.name);
		expect(await names(DEFAULT_PROJECT)).toEqual(["pkg-a", "sfly-std"]);
		expect(await names(OTHER)).toEqual(["pkg-b", "sfly-std"]);
		expect(await names(PUBLIC_PROJECT)).toEqual(["sfly-std"]);

		expect((await packages.get(DEFAULT_PROJECT, a.pkg))?.name).toBe("pkg-a");
		expect(await packages.get(DEFAULT_PROJECT, b.pkg)).toBeUndefined();
		expect((await packages.getVersion(DEFAULT_PROJECT, a.pkg, "1.0.0"))?.name).toBe("pkg-a");
		expect(await packages.getVersion(DEFAULT_PROJECT, b.pkg, "1.0.0")).toBeUndefined();
		expect(await packages.archive(DEFAULT_PROJECT, a.pkg, "1.0.0")).toBeDefined();
		expect(await packages.archive(DEFAULT_PROJECT, b.pkg, "1.0.0")).toBeUndefined();
		expect(await packages.archive(OTHER, b.pkg, "1.0.0")).toBeDefined();
		expect(await packages.archive(OTHER, a.pkg, "1.0.0")).toBeUndefined();
		// 公共项目里的标准节点包，每个项目都读得到（ADR 0029：任何凭据都能读公共项目）；公共项目自己读不到别的项目的包。
		for (const project of [DEFAULT_PROJECT, OTHER, PUBLIC_PROJECT]) {
			expect((await packages.get(project, "sfly-std"))?.name, project).toBe("sfly-std");
			expect((await packages.getVersion(project, "sfly-std", "0.1.0"))?.name, project).toBe(
				"sfly-std",
			);
			expect(await packages.archive(project, "sfly-std", "0.1.0"), project).toBeDefined();
		}
		expect(await packages.get(PUBLIC_PROJECT, a.pkg)).toBeUndefined();
		expect(await packages.archive(PUBLIC_PROJECT, b.pkg, "1.0.0")).toBeUndefined();
	});

	it("飞书机器人：列表只有本项目的，按名字取、改、删别的项目的机器人得到「不存在」", async () => {
		const names = async (project: ProjectId) => (await bots.list(project)).map((x) => x.name);
		expect(await names(DEFAULT_PROJECT)).toEqual(["bot-a"]);
		expect(await names(OTHER)).toEqual(["bot-b"]);

		expect((await bots.get(DEFAULT_PROJECT, a.bot))?.name).toBe("bot-a");
		expect(await bots.get(DEFAULT_PROJECT, b.bot)).toBeUndefined();
		expect(
			await bots.replaceWebhookUrl(DEFAULT_PROJECT, b.bot, "https://open.feishu.cn/hook/x"),
		).toBeUndefined();
		expect(await bots.remove(DEFAULT_PROJECT, b.bot)).toBe(false);
		// 项目乙的机器人没有被改、没有被删。
		expect((await bots.get(OTHER, b.bot))?.webhookUrl).toBe("https://open.feishu.cn/hook/b");
	});

	it("引用机器人的场景只列本项目的：项目乙的场景引用了项目甲的机器人名字，不出现在项目甲的列表里", async () => {
		const { db } = database;
		await database.pool.query(
			"update orchestrations set run_notify_bot = 'bot-a' where id = any($1)",
			[[a.scenario, b.scenario]],
		);
		const referencing = async (project: ProjectId) =>
			(await scenariosReferencingBot(db, project, "bot-a")).map((s) => s.orchestration_id);
		expect(await referencing(DEFAULT_PROJECT)).toEqual([a.scenario]);
		expect(await referencing(OTHER)).toEqual([b.scenario]);
	});

	it("控制台「开始使用」的汇总只看本项目", async () => {
		const { db } = database;
		const summary = await setupSummary(db, DEFAULT_PROJECT);
		expect(summary.agent).toMatchObject({ online: 1, name: "agent-a" });
		// 节点包算上公共项目里的 sfly-std。
		expect(summary.package.count).toBe(2);
		expect(summary.scenario.count).toBe(1);
		const other = await setupSummary(db, OTHER);
		expect(other.package.count).toBe(2);
		expect(other.agent).toMatchObject({ name: "agent-b" });
	});

	it("名字的唯一约束没变（第二步在 #502）：在另一个项目里重名被拒绝", async () => {
		expect(await bots.create(OTHER, "bot-a", "https://open.feishu.cn/hook/dup")).toEqual({
			kind: "name_taken",
		});
		await expect(
			packages.publish(OTHER, packageArchive(packageMetadata({ name: "pkg-a", version: "1.0.0" }))),
		).rejects.toBeInstanceOf(PackageError);
	});

	it("Agent 重连只更新信息，不改它所属的项目", async () => {
		await hub.attach(OTHER, "agent-a", AGENT_INFO, new AsyncQueue());
		const { rows } = await database.pool.query<{ project_id: string }>(
			"select project_id from agents where name = 'agent-a'",
		);
		expect(rows).toEqual([{ project_id: DEFAULT_PROJECT }]);
	});
});

describe("默认项目的列表和按名字定位的接口看不到项目乙的任何东西", () => {
	let cp: TestControlPlane;
	let api: ApiClient;

	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		// 项目乙的资源直接写库：一个在线的 Agent、一个节点包、一个飞书机器人、一个场景和它的运行。
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			const scenario = "00000000-0000-4000-8000-0000000000b1";
			const version = "00000000-0000-4000-8000-0000000000b2";
			await client.query(
				"insert into projects (id, display_name, created_at) values ($1, '项目乙', $2)",
				[OTHER, AT],
			);
			await client.query(
				"insert into agents (name, project_id, info, status, registered_at, last_seen_at) values ('agent-b', $1, $2, 'online', $3, $3)",
				[OTHER, JSON.stringify(AGENT_INFO), AT],
			);
			await client.query(
				"insert into feishu_bots (name, project_id, webhook_url, created_at) values ('bot-b', $1, 'https://open.feishu.cn/hook/b', $2)",
				[OTHER, AT],
			);
			await client.query(
				`insert into node_packages (name, version, project_id, metadata, file_path, sha256, size, published_at)
				values ('pkg-b', '1.0.0', $1, $2, 'packages/pkg-b/1.0.0.sflypkg', 'aa', 1, $3)`,
				[
					OTHER,
					JSON.stringify({ name: "pkg-b", version: "1.0.0", requires_python: ">=3.10", nodes: [] }),
					AT,
				],
			);
			await client.query(
				"insert into orchestrations (id, name, project_id, head_version, created_at) values ($1, '场景乙', $2, 1, $3)",
				[scenario, OTHER, AT],
			);
			await client.query(
				"insert into orchestration_versions (id, orchestration_id, number, document, author, created_at) values ($1, $2, 1, $3, '测试', $4)",
				[version, scenario, JSON.stringify(DOCUMENT), AT],
			);
			await client.query(
				`insert into runs (id, orchestration_id, orchestration_version_id, project_id, triggered_by, params, status, started_at)
				values ('00000000-0000-4000-8000-0000000000b3', $1, $2, $3, '测试', '{}', 'running', now())`,
				[scenario, version, OTHER],
			);
		} finally {
			await client.end();
		}
	});
	afterAll(async () => {
		await cp.close();
	});

	const json = async (path: string) => {
		const res = await api.get(path);
		expect(res.status, path).toBe(200);
		return (await res.json()) as Record<string, unknown>;
	};

	it("列表（Agent、场景、运行、节点包、飞书机器人、控制台统计）里没有项目乙的行", async () => {
		expect((await json("/agents")).agents).toEqual([]);
		expect((await json("/orchestrations")).orchestrations).toEqual([]);
		expect(await json("/runs")).toMatchObject({
			runs: [],
			counts: { running: 0, success: 0, failed: 0, cancelled: 0 },
		});
		expect((await json("/packages")).packages).toEqual([]);
		expect((await json("/feishu-bots")).bots).toEqual([]);
		expect(await json("/dashboard")).toMatchObject({
			runs: { running: 0 },
			running_runs: [],
			agents: { online: 0, offline: 0 },
			setup: {
				agent: { done: false },
				package: { done: false },
				scenario: { done: false },
				run: { done: false },
			},
		});
	});

	it("按名字取项目乙的 Agent、节点包、飞书机器人，都是 404", async () => {
		const notFound = async (res: Response | Promise<Response>, what: string) => {
			const response = await res;
			expect(response.status, what).toBe(404);
		};
		await notFound(api.postEmpty("/agents/agent-b/update-now"), "agent update-now");
		await notFound(api.get("/packages/pkg-b"), "package");
		await notFound(api.get("/packages/pkg-b/versions/1.0.0"), "package version");
		await notFound(api.get("/packages/pkg-b/versions/1.0.0/nodes/x"), "package node");
		await notFound(api.get("/packages/pkg-b/versions/1.0.0/archive"), "package archive");
		await notFound(api.get("/feishu-bots/bot-b/references"), "bot references");
		await notFound(
			api.patch("/feishu-bots/bot-b", { webhook_url: "https://open.feishu.cn/hook/x" }),
			"bot replace",
		);
		await notFound(api.postEmpty("/feishu-bots/bot-b/test"), "bot test");
		await notFound(api.delete("/feishu-bots/bot-b"), "bot remove");
	});

	it("在默认项目里新建的东西属于默认项目：登记机器人、新建场景，库里的 project_id 是 default", async () => {
		await api.createFeishuBot("bot-a", "https://open.feishu.cn/hook/a");
		const scenario = await api.createOrchestration("场景甲");
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			const bot = await client.query("select project_id from feishu_bots where name = 'bot-a'");
			const created = await client.query("select project_id from orchestrations where id = $1", [
				scenario,
			]);
			expect([bot.rows[0], created.rows[0]]).toEqual([
				{ project_id: "default" },
				{ project_id: "default" },
			]);
		} finally {
			await client.end();
		}
		expect(((await json("/feishu-bots")).bots as { name: string }[]).map((x) => x.name)).toEqual([
			"bot-a",
		]);
	});
});

describe("标准节点包升级后在公共项目里：默认项目的接口照常看得到、下载得到", () => {
	let cp: TestControlPlane;
	beforeAll(async () => {
		cp = await startTestControlPlane();
	});
	afterAll(async () => {
		await cp.close();
	});

	it("包列表、详情、归档下载（Agent 装包走这一条）和控制台的「开始使用」都和升级前一样", async () => {
		const api = new ApiClient(cp);
		await publishPackage(cp, "sfly-std", "0.1.0", { shell: ["stdout"] });
		const before = await (await api.get("/packages/sfly-std/versions/0.1.0/archive")).arrayBuffer();
		expect(before.byteLength).toBeGreaterThan(0);

		// 升级：迁移把 sfly-std 的已发布版本放进公共项目（0032）。
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			await client.query("update node_packages set project_id = 'public' where name = 'sfly-std'");
		} finally {
			await client.end();
		}

		const list = await api.getJson<{ packages: { name: string }[] }>("/packages");
		expect(list.packages.map((p) => p.name)).toEqual(["sfly-std"]);
		await api.getJson("/packages/sfly-std");
		await api.getJson("/packages/sfly-std/versions/0.1.0");
		const archive = await api.get("/packages/sfly-std/versions/0.1.0/archive");
		expect(archive.status).toBe(200);
		expect(await archive.arrayBuffer()).toEqual(before);
		expect(
			(await api.getJson<{ setup: { package: { done: boolean; count: number } } }>("/dashboard"))
				.setup.package,
		).toMatchObject({ done: true, count: 1 });
	});
});

/**
 * 编译期的检查，不会被执行：存储层的列表、按名字取、新建、改、删，签名里项目是必填参数，漏传就过不了类型检查。
 * 这里每一行都是一处漏传（或传了不是项目标识的字符串）：`@ts-expect-error` 在这一行其实能通过编译时本身会报错，
 * 所以哪天有人把项目改成可选参数，`pnpm typecheck` 就会失败。
 */
function omittedProjectDoesNotCompile(deps: {
	scenarios: OrchestrationStore;
	hub: AgentHub;
	packages: ReturnType<typeof createPackageRepository>;
	bots: FeishuBots;
	engine: Engine;
	db: Database["db"];
}) {
	// @ts-expect-error 漏传项目
	void deps.scenarios.create("场景");
	// @ts-expect-error 漏传项目
	void deps.scenarios.rawHeadDocuments();
	// @ts-expect-error 漏传项目
	void deps.scenarios.getInProject("id");
	// @ts-expect-error 漏传项目
	void listOrchestrationSummaries(deps.db, {});
	// @ts-expect-error 漏传项目
	void listAllRuns(deps.db, { limit: 10 });
	// @ts-expect-error 漏传项目
	void getRunViewInProject(deps.db, "run-id");
	// @ts-expect-error 漏传项目
	void deps.hub.list();
	// @ts-expect-error 漏传项目
	void deps.hub.find("agent-a");
	// @ts-expect-error 漏传项目
	void deps.packages.list();
	// @ts-expect-error 漏传项目
	void deps.packages.get("pkg");
	// @ts-expect-error 漏传项目
	void deps.packages.getVersion("pkg", "1.0.0");
	// @ts-expect-error 漏传项目
	void deps.packages.archive("pkg", "1.0.0");
	// @ts-expect-error 漏传项目
	void deps.bots.list();
	// @ts-expect-error 漏传项目
	void deps.bots.get("bot");
	// @ts-expect-error 漏传项目
	void deps.bots.create("bot", "https://example.com");
	// @ts-expect-error 漏传项目
	void deps.bots.remove("bot");
	// @ts-expect-error 漏传项目
	void deps.packages.publish(new Uint8Array(), null);
	// @ts-expect-error 漏传项目
	void deps.hub.attach("agent-a", {} as never, {} as never);
	// @ts-expect-error 漏传项目
	void deps.bots.replaceWebhookUrl("bot", "https://example.com");
	// @ts-expect-error 漏传项目
	void deps.engine.updateNow("agent-a");
	// @ts-expect-error 漏传项目
	void dashboardView({} as never);
	// @ts-expect-error 漏传项目
	void scenariosReferencingBot(deps.db, "bot");
	// @ts-expect-error 项目不是任意字符串：要用 DEFAULT_PROJECT 或解析过的项目标识
	void deps.bots.list("default");
}

describe("项目是必填参数", () => {
	it("漏传项目的调用过不了类型检查：`pnpm typecheck` 检查 omittedProjectDoesNotCompile 里的每一行", () => {
		expect(omittedProjectDoesNotCompile).toBeTypeOf("function");
	});
});
