// 切入点 A：契约里声明为 `effect: "read"` 的接口真的只读（#448）。
//
// 真实控制面 + 真实数据库：场景（有版本的、没有版本的、已归档的）、运行预设、节点包、飞书机器人，
// 运行有已结束的、失败的、还在跑的（Agent 在线、任务占着槽位），日志、指标、动作、产物都有。
// 对每个声明为只读的接口，用真实存在的 id 调用（走到成功的路径，404 不算数）；定位到场景、运行、任务的接口，
// 每种状态的数据各调用一遍。请求前后各取一份控制面留下的全部痕迹（support/write-footprint.ts：
// 每张表每一行连同 xmin、序列、数据目录里的文件），有任何差别就是写了。同时把响应拿去和随 SDK 打包的
// 路由清单里的响应 JSON Schema 对照。
//
// 没有用「只有 SELECT 权限的数据库角色」：控制面启动时要迁移，运行时后台有周期扫描和清理，用只读角色它起不来、
// 也没法区分是哪个请求出的错；请求前后比较的办法不改控制面，还看得见「写回同样的值」「取了序列号」和「写了文件」。
// 覆盖范围和做不到的见 PR 说明。
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { httpContract, type RouteDef } from "@sfly/schema";
import Ajv2020 from "ajv/dist/2020.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { repoRoot } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent, LogLevel, LogSource } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { createPresetOk } from "./support/presets.js";
import { SseClient, type SseEvent } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";
import { diffFootprints, settledFootprint, takeFootprint } from "./support/write-footprint.js";

const VERSION = packageJson.version;
const WHEEL = `sfly-${VERSION}-py3-none-any.whl`;
const TARBALL = `sfly-client-${VERSION}.tgz`;
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

interface Manifest {
	routes: Array<{
		method: string;
		path: string;
		response?: Record<string, unknown>;
		events?: Record<string, Record<string, unknown>>;
	}>;
}
const manifest = JSON.parse(
	readFileSync(join(repoRoot, "sdk/python/src/sfly/schemas/routes.json"), "utf8"),
) as Manifest;
const ajv = new Ajv2020({ strict: false, validateFormats: false });

/** 同一个接口要在哪些状态的数据上各调用一遍（名字在收集测试时就要用，数据在 beforeAll 里种）。 */
const FIXTURES = {
	done: "已结束的运行",
	failed: "失败的运行",
	live: "还在跑的运行",
	empty: "没有版本的场景",
	archived: "已归档的场景",
} as const;
type FixtureKey = keyof typeof FIXTURES;

/** 一组真实存在的 id。 */
interface Fixture {
	scenarioId: string;
	runId?: string;
	taskId?: string;
	chainInstanceId?: string;
}

interface Seeded {
	fixtures: Record<FixtureKey, Fixture>;
	presetId: string;
	botName: string;
	docSlug: string;
}

/** 每次运行的任务都上传了一个产物。 */
const ARTIFACT = "报告/结果 1.json";

/** 接口用哪些数据调用：定位到场景、运行、任务的，每种状态各一遍；其余（列表、系统）一遍。 */
function fixtureKeys(def: RouteDef): Array<FixtureKey | undefined> {
	const { kind, target } = def.resource;
	if (typeof target === "string") return [undefined];
	// 没有版本的场景没有第 1 版：读版本只在有版本的场景上走得到成功的路径。
	if (kind === "scenario") {
		return def.path.includes(":number")
			? ["done", "live", "archived"]
			: ["done", "live", "empty", "archived"];
	}
	if (kind === "run" || kind === "task") return ["done", "failed", "live"];
	return [undefined];
}

describe("声明为只读的接口真的不写库", () => {
	let cp: TestControlPlane;
	let dir: string;
	let seeded: Seeded;
	let agent: FakeAgent;
	/** 验证过的 SSE 事件（`方法 路径 事件名`）：证明对照响应 schema 不是空转。 */
	const validatedEvents = new Set<string>();

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "sfly-readonly-"));
		await writeFile(join(dir, WHEEL), "wheel");
		await writeFile(join(dir, TARBALL), "tarball");
		await writeFile(join(dir, "agent-x86"), "x86");
		await writeFile(join(dir, "agent-arm"), "arm");
		cp = await startTestControlPlane({
			sdkWheelDir: dir,
			clientPackageDir: dir,
			docsDir: join(repoRoot, "docs/guide"),
			agentBinaries: { x86_64: join(dir, "agent-x86"), aarch64: join(dir, "agent-arm") },
		});
		({ seeded, agent } = await seed(cp));
	}, 120_000);

	afterAll(async () => {
		await agent?.disconnect();
		await cp?.close();
		await rm(dir, { recursive: true, force: true });
	});

	const footprint = () => takeFootprint(cp.database.url, cp.dataDir);
	const settled = () => settledFootprint(cp.database.url, cp.dataDir);

	describe("检测器自己看得见写", () => {
		it("有副作用的请求：新建场景", async () => {
			const before = await settled();
			await new ApiClient(cp).createOrchestration("多出来的场景");
			const changes = diffFootprints(before, await settled());
			expect(changes.join("\n")).toContain("表 orchestrations");
		});

		it("写回同样的值也看得见", async () => {
			const before = await settled();
			const client = new pg.Client({ connectionString: cp.database.url });
			await client.connect();
			try {
				await client.query("UPDATE orchestrations SET name = name");
			} finally {
				await client.end();
			}
			const changes = diffFootprints(before, await settled());
			expect(changes.join("\n")).toContain("表 orchestrations");
		});

		it("数据目录里多了、改了、少了文件也看得见", async () => {
			const before = await settled();
			const file = join(cp.dataDir, "stray.txt");
			await writeFile(file, "a");
			const withFile = await footprint();
			expect(diffFootprints(before, withFile)).toEqual(["数据目录新增文件 stray.txt"]);
			await writeFile(file, "abc");
			expect(diffFootprints(withFile, await footprint())).toEqual([
				"数据目录的文件 stray.txt 被改过",
			]);
			await rm(file);
			expect(diffFootprints(withFile, await footprint())).toEqual([
				"数据目录的文件 stray.txt 被删了",
			]);
			expect(diffFootprints(before, await footprint())).toEqual([]);
		});

		it("什么都不做，前后一样", async () => {
			const before = await settled();
			expect(diffFootprints(before, await settled())).toEqual([]);
		});
	});

	const readRoutes = httpContract.filter((def) => def.effect === "read");

	it("有足够多的只读接口被核对", () => {
		expect(readRoutes.length).toBeGreaterThan(50);
	});

	// 测试在收集阶段就要列出来，数据到 beforeAll 里才种好：这里只登记名字，运行时再取数据。
	for (const def of readRoutes) {
		for (const key of fixtureKeys(def)) {
			const name = `${def.method} ${def.path}${key ? ` · ${FIXTURES[key]}` : ""}`;
			it(`${name}：响应与清单里的 schema 一致，没有写任何东西`, async () => {
				const url = requestUrl(def, seeded, key ? seeded.fixtures[key] : undefined);
				const before = await settled();
				const events = await call(def, url);
				const after = await settled();

				const changes = diffFootprints(before, after);
				expect(
					changes,
					`${name} 声明为只读，调用后却留下了写入的痕迹：\n${changes.join("\n")}`,
				).toEqual([]);
				for (const event of events) {
					const schema = manifestEntry(def)?.events?.[event.event];
					expect(schema, `${def.path} 的事件 ${event.event} 不在清单里`).toBeDefined();
					expectValid(`${name} 事件 ${event.event}`, schema, event.data);
					validatedEvents.add(`${def.method} ${def.path} ${event.event}`);
				}
			});
		}
	}

	it("事件流的事件都和清单里的 schema 对过一遍（不是空转）", () => {
		for (const expected of [
			"GET /runs/:id/events run",
			"GET /tasks/:id/actions/events summary",
			"GET /orchestrations/:id/presence/events editors",
		]) {
			expect(validatedEvents, expected).toContain(expected);
		}
	});

	// ---- 调用

	const manifestEntry = (def: RouteDef) =>
		manifest.routes.find((r) => r.method === def.method && r.path === def.path);

	function expectValid(where: string, schema: unknown, data: unknown) {
		const validate = ajv.compile(schema as object);
		expect(
			validate(data),
			`${where} 不符合清单里的 JSON Schema：${ajv.errorsText(validate.errors)}`,
		).toBe(true);
	}

	/** 调用一个只读接口，断言走到了成功的路径；SSE 返回收到的（契约里声明的）事件。 */
	async function call(def: RouteDef, url: string): Promise<SseEvent[]> {
		const where = `${def.method} ${url}`;
		if ("kind" in def && def.kind === "stream") {
			const sse = await SseClient.open(cp, url);
			try {
				await sse.next("time");
				// 控制面时间之外，等第一批数据（有的流连上就推一份，有的要等新数据，后者什么都不会收到）。
				await settled();
				return sse.received.filter((e) => e.event !== "time");
			} finally {
				sse.close();
			}
		}
		const res = await cp.fetch(url, { method: def.method });
		if ("kind" in def && def.kind === "download") {
			const body = await res.arrayBuffer();
			expect(res.status, `${where}：${Buffer.from(body).toString().slice(0, 200)}`).toBe(200);
			expect(res.headers.get("content-type")).toContain(def.contentType.split(";")[0]);
			return [];
		}
		const text = await res.text();
		expect(res.status, `${where}：${text.slice(0, 200)}`).toBe(200);
		const body: unknown = JSON.parse(text);
		expectValid(where, manifestEntry(def)?.response, body);
		// 清单里的 schema 不能比 zod 更严：zod 认的响应，它也要认（上一行已经对过一遍，这行保证两边说的是同一件事）。
		expect(() =>
			(def as { response: { parse(v: unknown): unknown } }).response.parse(body),
		).not.toThrow();
		return [];
	}
});

// ---- 请求用的样本值

/** 路径参数的样本：按参数名和接口作用的资源类别给真实存在的值；认不出的报错，让新接口的作者补上。 */
function sampleParam(def: RouteDef, name: string, s: Seeded, fixture?: Fixture): string {
	const kind = def.resource.kind;
	const samples: Record<string, string | undefined> = {
		id: { scenario: fixture?.scenarioId, run: fixture?.runId, task: fixture?.taskId }[
			kind as string
		],
		presetId: s.presetId,
		number: "1",
		node: "check",
		"*": ARTIFACT,
		name: { package: "probe", feishu_bot: s.botName, agent: "agent-a" }[kind as string],
		version: kind === "system" ? VERSION : "1.0.0",
		arch: "x86_64",
		filename: def.path.startsWith("/sdk/") ? WHEEL : TARBALL,
		page: s.docSlug,
		skill: "sfly-platform",
		file: "SKILL.md",
		project: "sfly",
	};
	const value = samples[name];
	if (value === undefined) {
		throw new Error(
			`${def.method} ${def.path}：没有路径参数 ${name} 的样本值，在 read-only-routes.test.ts 的 sampleParam 里补上`,
		);
	}
	return value;
}

/** 个别接口的查询参数样本：不带就走不到成功的路径。 */
function sampleQuery(def: RouteDef, fixture?: Fixture): Record<string, string> {
	if (def.path === "/runs/:id/metrics/series" && fixture?.chainInstanceId) {
		return { chain_instance_id: fixture.chainInstanceId, node_id: "check" };
	}
	return {};
}

function requestUrl(def: RouteDef, s: Seeded, fixture?: Fixture): string {
	const path = def.path.replace(
		/:([A-Za-z_][A-Za-z0-9_]*)|\*$/g,
		(_all, name: string | undefined) => {
			const value = sampleParam(def, name ?? "*", s, fixture);
			return name === undefined
				? value.split("/").map(encodeURIComponent).join("/")
				: encodeURIComponent(value);
		},
	);
	const query = new URLSearchParams(sampleQuery(def, fixture)).toString();
	return query ? `${path}?${query}` : path;
}

// ---- 种数据

const documentFor = () => ({
	default_agent: "agent-a",
	nodes: [
		{
			id: "entry",
			kind: "entry",
			params: [{ name: "env", type: "string", default: "staging" }],
		},
		{ id: "check", kind: "package", package: "probe", node: "check" },
	],
	edges: [{ from: "entry", to: "check", kind: "chain" }],
	packages: { probe: "1.0.0" },
});

async function seed(cp: TestControlPlane): Promise<{ seeded: Seeded; agent: FakeAgent }> {
	const api = new ApiClient(cp);
	await publishPackage(cp, "probe", "1.0.0", {
		check: {
			outputs: ["ok"],
			metrics: [{ name: "tps", unit: "req/s", kind: "gauge" }],
			charts: [{ title: "TPS", type: "line", metrics: ["tps"] }],
		},
	});
	const scenario = (name: string) => api.orchestrationWith(documentFor(), name);
	const checked = await scenario("巡检");
	const pressure = await scenario("压测");
	const archived = await scenario("旧巡检");
	const empty = await api.createOrchestration("空场景");
	expect((await api.postEmpty(`/orchestrations/${archived}/archive`)).status).toBe(200);

	const preset = await createPresetOk(api, checked, {
		name: "生产",
		params: [{ name: "env", value: "prod" }],
	});
	const bot = await api.createFeishuBot(
		"运维群",
		"https://open.feishu.cn/open-apis/bot/v2/hook/abc",
	);

	const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" }, { clock: cp.clock });

	/** 触发一次运行，Agent 领到它的任务，上报日志、指标、动作和一个产物；返回运行与任务。 */
	const start = async (scenarioId: string, level: LogLevel, text: string) => {
		const runId = await api.triggerOk(scenarioId, { env: "prod" });
		const task = await agent.nextAssign();
		await agent.started(task);
		agent.logs(task, [
			{
				seq: 1n,
				timeUnixMs: BigInt(T0),
				source: level === LogLevel.ERROR ? LogSource.STDERR : LogSource.STDOUT,
				level,
				text,
			},
		]);
		const second = Math.floor(cp.clock.now().getTime() / 1000);
		agent.metrics(task, [
			["tps", second, 10],
			["tps", second + 1, 20],
		]);
		agent.progress(task, 1, 2, "一半");
		agent.actions(task, [
			agent.actionStart(1, "巡检", T0 + 1_000),
			agent.actionEnd(1, level === LogLevel.ERROR ? "failed" : "success", T0 + 1_500),
		]);
		agent.actionSummary(task, { total: 1, reported: 1 });
		await agent.sync();
		const put = await fetch(
			`${task.artifactUploadUrl}${ARTIFACT.split("/").map(encodeURIComponent).join("/")}`,
			{
				method: "PUT",
				headers: { "content-type": "application/octet-stream" },
				body: JSON.stringify({ ok: true }),
			},
		);
		if (put.status !== 201) throw new Error(`upload artifact: ${await put.text()}`);
		return { runId, task };
	};
	const settle = (runId: string, status: string) =>
		eventually(async () => expect((await api.run(runId)).status).toBe(status));

	// 已结束的
	const done = await start(checked, LogLevel.INFO, "巡检通过");
	await agent.succeed(done.task, { ok: true });
	await settle(done.runId, "success");

	// 失败的
	const failed = await start(checked, LogLevel.ERROR, "连接被拒绝");
	await agent.fail(failed.task, "连接被拒绝");
	await settle(failed.runId, "failed");

	// 还在跑的：Agent 在线、任务占着槽位，直到测试结束
	const live = await start(pressure, LogLevel.INFO, "压测中");
	await settle(live.runId, "running");

	const docs = await api.getJson<{ pages: Array<{ slug: string }> }>("/docs");
	const fixture = async (
		scenarioId: string,
		run?: { runId: string; task: AssignedTask },
	): Promise<Fixture> => ({
		scenarioId,
		...(run && {
			runId: run.runId,
			taskId: run.task.taskId,
			chainInstanceId: (await api.run(run.runId)).chains[0]?.id as string,
		}),
	});
	return {
		agent,
		seeded: {
			fixtures: {
				done: await fixture(checked, done),
				failed: await fixture(checked, failed),
				live: await fixture(pressure, live),
				empty: await fixture(empty),
				archived: await fixture(archived),
			},
			presetId: preset.id,
			botName: bot.name,
			docSlug: docs.pages[0]?.slug as string,
		},
	};
}
