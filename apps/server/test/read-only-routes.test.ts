// 切入点 A：契约里声明为 `effect: "read"` 的接口真的只读（#448）。
//
// 真实控制面 + 真实数据库：场景（有版本的、没有版本的、已归档的）、运行预设、节点包、飞书机器人，
// 运行有已结束的、失败的、还在跑的（Agent 在线、任务占着槽位），日志、指标、动作、产物都有。
// 对每个声明为只读的接口，用真实存在的 id 调用（走到成功的路径，404 不算数）；定位到场景、运行、任务的接口，
// 每种状态的数据各调用一遍。请求前后各取一份控制面留下的全部痕迹（support/write-footprint.ts：
// 每张表每一行连同 xmin、序列、数据目录里的文件），有任何差别就是写了。同时把响应拿去和随 SDK 打包的
// 路由清单里的响应 JSON Schema 对照。
//
// 方法不是 GET 的只读接口（登记在 NON_GET_READS，例如检查场景文档）也在其中：它们最多只能写内存里的状态，
// 所以库和数据目录同样要求没有变化。
//
// 没有用「只有 SELECT 权限的数据库角色」：控制面启动时要迁移，运行时后台有周期扫描和清理，用只读角色它起不来、
// 也没法区分是哪个请求出的错；请求前后比较的办法不改控制面，还看得见「写回同样的值」「取了序列号」和「写了文件」。
// 覆盖范围和做不到的见 PR 说明。
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { httpContract, NICKNAME_HEADER, NON_GET_READS, type RouteDef } from "@sfly/schema";
import Ajv2020 from "ajv/dist/2020.js";
import { strToU8 } from "fflate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { repoRoot } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { ArrayCoverage } from "./support/array-coverage.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent, LogLevel, LogSource } from "./support/fake-agent.js";
import { putFocusItemsOk } from "./support/focus-items.js";
import { packageArchive, packageMetadata, publishInit } from "./support/package-archive.js";
import { createPresetOk } from "./support/presets.js";
import { persistedBodies, seedSession } from "./support/sessions.js";
import { SseClient, type SseEvent } from "./support/sse-client.js";
import { publishIntoPublicProject } from "./support/std-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";
import {
	diffFootprints,
	type Footprint,
	settledFootprint,
	takeFootprint,
} from "./support/write-footprint.js";

const VERSION = packageJson.version;
const WHEEL = `sfly-${VERSION}-py3-none-any.whl`;
const TARBALL = `sfly-client-${VERSION}.tgz`;
/** 公共项目里的 sfly-std（种数据时发布），包索引里它的 wheel（#556）。 */
const STD_WHEEL = "sfly_std-0.0.1-py3-none-any.whl";
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
	queued: "排队中的运行（Agent 的槽位被占满）",
	empty: "没有版本的场景",
	archived: "已归档的场景",
	rich: "有子流程、说明和失效预设的场景",
	diffed: "两个版本之间节点、连线、注释框都有增删改的场景",
} as const;
type FixtureKey = keyof typeof FIXTURES;

/** 一个要调用的只读接口：名字（报错里用）、契约里的定义、真实存在的请求地址。 */
interface Case {
	name: string;
	def: RouteDef;
	url: string;
}

/** 找「响应之后才写」的是哪个接口时，往回看最近几个用例；单独重跑一个用例时，响应之后等多久（毫秒）。 */
const RECENT_CASES = 4;
const LATE_PROBE_MS = 1500;

/** 一组真实存在的 id。 */
interface Fixture {
	scenarioId: string;
	/** 最新版本号：对比两个版本时和第 1 版比。 */
	latestVersion: number;
	runId?: string;
	taskId?: string;
	chainInstanceId?: string;
}

interface Seeded {
	fixtures: Record<FixtureKey, Fixture>;
	/** 有每种持久事件的会话。 */
	sessionId: string;
	presetId: string;
	botName: string;
	docSlug: string;
}

/** 每次运行的任务都上传了一个产物。 */
const ARTIFACT = "报告/结果 1.json";

/**
 * 全部用例跑完，这些数组字段还是每次都是空的：它们的元素没有被响应 schema 对照过。键是「方法 路径 response（SSE 是事件名） 数组路径」，
 * 值是为什么做不到。新的数组字段出现时先在 seed 里补数据，补不了再来这里写。
 */
const UNVERIFIED_ARRAYS: Record<string, string> = {
	"GET /dashboard response recent_ended[].focus[].series[]":
		"控制台汇总只要关注项的最新值：读数用 points=0，序列按设计就是空的（序列的元素由 GET /runs/:id/focus 对照）",
	"GET /dashboard response recent_ended[].focus[].series[].points[]":
		"同上：控制台汇总的关注项读数不带序列",
};

/** 接口用哪些数据调用：定位到场景、运行、任务的，每种状态各一遍；其余（列表、系统）一遍。 */
function fixtureKeys(def: RouteDef): Array<FixtureKey | undefined> {
	const { kind, target } = def.resource;
	if (typeof target === "string") return [undefined];
	// 没有版本的场景没有第 1 版：读版本只在有版本的场景上走得到成功的路径。
	if (kind === "scenario") {
		return def.path.includes("/versions/:")
			? ["done", "live", "archived", "rich", "diffed"]
			: ["done", "live", "empty", "archived", "rich", "diffed"];
	}
	if (kind === "task") return ["done", "failed", "live"];
	// 排队中的运行：运行视图里排队中的尝试带 queue_wait（占着槽位的任务）。
	if (kind === "run") return ["done", "failed", "live", "queued"];
	return [undefined];
}

describe("声明为只读的接口真的不写库", () => {
	let cp: TestControlPlane;
	let dir: string;
	let seeded: Seeded;
	let agent: FakeAgent;
	/** 验证过的 SSE 事件（`方法 路径 事件名`）：证明对照响应 schema 不是空转。 */
	const validatedEvents = new Set<string>();
	/** 响应里的数组字段有没有非空过：每次都是空的，它的元素 schema 就没有对过任何数据。 */
	const arrays = new ArrayCoverage();

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "sfly-readonly-"));
		await writeFile(join(dir, WHEEL), "wheel");
		await writeFile(join(dir, TARBALL), "tarball");
		await writeFile(join(dir, "agent-x86"), "x86");
		await writeFile(join(dir, "agent-arm"), "arm");
		cp = await startTestControlPlane({
			// 一个任务的日志超过这个字节数就截断：失败的那次运行故意写得比它多
			logLimitBytes: 1500,
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

	/**
	 * 响应之后才发生的写（延迟的写、后台的写）可能晚于「连着两次一样」，不能记到碰巧正在跑的那个接口头上：
	 *
	 * - 每个用例开始时取的那份，和上一个用例结束时取的那份比较一次，不一样就是之前某个接口在响应之后还写了东西；
	 * - 一个用例自己的前后不一样时，同一个请求再来一遍：它自己写的话还会写，没有了就是之前某个接口的延迟写落在了这次调用的时间里；
	 * - 是之前某个接口的延迟写时，把最近几个用例各自单独再跑一遍、响应之后多等一会儿，哪个又写了就是哪个，报错写出它的名字；
	 * - 全部跑完之后多等一会儿再取一次，和最后一个用例结束时的比较。
	 */
	const finished: Case[] = [];
	let lastAfter: Footprint | undefined;

	/** 单独把一个用例再跑一遍，响应之后多等一会儿，返回这期间的变化。 */
	const probe = async (c: Case): Promise<string[]> => {
		const before = await settled();
		await call(c.def, c.url);
		await new Promise((resolve) => setTimeout(resolve, LATE_PROBE_MS));
		return diffFootprints(before, await settled());
	};

	/**
	 * 找出是最近哪个用例的接口在响应之后才写了东西；找不到时列出候选。重跑用例本身会留下写入的痕迹，
	 * 所以结束时以现在的样子为新的基线：一次失败不会让后面的用例跟着失败。
	 */
	const explainLateWrite = async (changes: string[], candidates: Case[]): Promise<string> => {
		try {
			for (const c of [...candidates].reverse()) {
				const again = await probe(c);
				if (again.length > 0) {
					return `是「${c.name}」：它在响应之后才写了东西（单独再跑一遍、响应后等 ${LATE_PROBE_MS} 毫秒，又看到了）：\n${again.join("\n")}`;
				}
			}
			const names = candidates.map((c) => `「${c.name}」`).join("、") || "（还没有）";
			return `没有找到是哪个接口（最近的用例单独重跑都没有再看到）。候选：${names}\n本次看到的变化：\n${changes.join("\n")}`;
		} finally {
			lastAfter = await settled();
		}
	};

	it("有足够多的只读接口被核对", () => {
		expect(readRoutes.length).toBeGreaterThan(50);
	});

	// 测试在收集阶段就要列出来，数据到 beforeAll 里才种好：这里只登记名字，运行时再取数据。
	for (const def of readRoutes) {
		for (const key of fixtureKeys(def)) {
			const name = `${def.method} ${def.path}${key ? ` · ${FIXTURES[key]}` : ""}`;
			it(`${name}：响应与清单里的 schema 一致，没有写任何东西`, async () => {
				const c: Case = {
					name,
					def,
					url: requestUrl(def, seeded, key ? seeded.fixtures[key] : undefined),
				};
				const before = await settled();
				const early = lastAfter ? diffFootprints(lastAfter, before) : [];
				if (early.length > 0) {
					throw new Error(
						`之前某个只读接口在响应之后还写了东西（当前这个接口 ${name} 还没有调用）。${await explainLateWrite(early, finished.slice(-RECENT_CASES))}`,
					);
				}
				const events = await call(def, c.url);
				const after = await settled();
				const candidates = finished.slice(-RECENT_CASES);
				finished.push(c);
				lastAfter = after;

				const changes = diffFootprints(before, after);
				if (changes.length > 0) {
					const again = await probe(c);
					lastAfter = await settled();
					if (again.length > 0) {
						throw new Error(
							`${name} 声明为只读，调用后却留下了写入的痕迹：\n${changes.join("\n")}`,
						);
					}
					throw new Error(
						`${name} 第一次调用之后出现了写入，再调用一遍就没有了：要么是它第一次调用才写（例如缓存），` +
							`要么是之前某个接口的延迟写落在了这次调用的时间里。${await explainLateWrite(changes, candidates)}`,
					);
				}
				for (const event of events) {
					const schema = manifestEntry(def)?.events?.[event.event];
					expect(schema, `${def.path} 的事件 ${event.event} 不在清单里`).toBeDefined();
					expectValid(`${name} 事件 ${event.event}`, schema, event.data);
					arrays.record(
						`${def.method} ${def.path} ${event.event}`,
						schema as Record<string, unknown>,
						event.data,
					);
					validatedEvents.add(`${def.method} ${def.path} ${event.event}`);
				}
			});
		}
	}

	it("方法不是 GET 的只读接口（NON_GET_READS）也被核对了", () => {
		const tested = readRoutes
			.filter((def) => def.method !== "GET")
			.map((def) => `${def.method} ${def.path}`);
		expect(tested.sort()).toEqual(Object.keys(NON_GET_READS).sort());
	});

	it("事件流的事件都和清单里的 schema 对过一遍（不是空转）", () => {
		for (const expected of [
			"GET /runs/:id/events run",
			"GET /tasks/:id/actions/events summary",
			"GET /sessions/:id/events user_message",
			"GET /sessions/:id/events platform",
			"GET /sessions/:id/events turn_end",
		]) {
			expect(validatedEvents, expected).toContain(expected);
		}
	});

	it("响应 schema 里的数组字段都至少有一次非空（除了下面写明没对照的）", () => {
		const unseen = arrays.unseen();
		const unlisted = unseen.filter((key) => !(key in UNVERIFIED_ARRAYS));
		expect(
			unlisted,
			`这些数组字段在全部用例里每次都是空的，元素的 schema 没有对过数据：在 seed 里补上能让它们非空的数据，` +
				`确实做不到的写进 UNVERIFIED_ARRAYS 并写明原因：\n${unlisted.join("\n")}`,
		).toEqual([]);
		const stale = Object.keys(UNVERIFIED_ARRAYS).filter((key) => !unseen.includes(key));
		expect(
			stale,
			`UNVERIFIED_ARRAYS 里这些已经被对照过了（或接口改了），删掉：\n${stale.join("\n")}`,
		).toEqual([]);
	});

	it("全部用例跑完之后，最后几个接口也没有在响应之后还写东西", async () => {
		// 最后一个用例之后再等一会儿：延迟的写不会因为没有下一个用例而漏掉。
		await new Promise((resolve) => setTimeout(resolve, LATE_PROBE_MS));
		const now = await settled();
		const late = lastAfter ? diffFootprints(lastAfter, now) : [];
		expect(
			late,
			late.length > 0 ? await explainLateWrite(late, finished.slice(-RECENT_CASES)) : "",
		).toEqual([]);
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
		const body = sampleBody(def);
		const res = await cp.fetch(url, {
			method: def.method,
			...(body !== undefined && {
				headers: {
					"content-type": "application/json",
					[NICKNAME_HEADER]: encodeURIComponent("tester"),
				},
				body: JSON.stringify(body),
			}),
		});
		if ("kind" in def && def.kind === "download") {
			const body = await res.arrayBuffer();
			expect(res.status, `${where}：${Buffer.from(body).toString().slice(0, 200)}`).toBe(200);
			expect(res.headers.get("content-type")).toContain(def.contentType.split(";")[0]);
			return [];
		}
		const text = await res.text();
		if (manifestEntry(def)?.response === undefined) {
			// 清单里没有 response：没有响应体（204）。
			expect(res.status, `${where}：${text.slice(0, 200)}`).toBe(204);
			expect(text).toBe("");
			return [];
		}
		expect(res.status, `${where}：${text.slice(0, 200)}`).toBe(200);
		const json: unknown = JSON.parse(text);
		const schema = manifestEntry(def)?.response;
		expectValid(where, schema, json);
		arrays.record(`${def.method} ${def.path} response`, schema as Record<string, unknown>, json);
		// 清单里的 schema 不能比 zod 更严：zod 认的响应，它也要认（上一行已经对过一遍，这行保证两边说的是同一件事）。
		expect(() =>
			(def as { response: { parse(v: unknown): unknown } }).response.parse(json),
		).not.toThrow();
		return [];
	}
});

// ---- 请求用的样本值

/** 路径参数的样本：按参数名和接口作用的资源类别给真实存在的值；认不出的报错，让新接口的作者补上。 */
function sampleParam(def: RouteDef, name: string, s: Seeded, fixture?: Fixture): string {
	const kind = def.resource.kind;
	const samples: Record<string, string | undefined> = {
		id: {
			scenario: fixture?.scenarioId,
			run: fixture?.runId,
			task: fixture?.taskId,
			session: s.sessionId,
		}[kind as string],
		presetId: s.presetId,
		number: "1",
		a: "1",
		b: String(fixture?.latestVersion ?? 1),
		node: "check",
		"*": ARTIFACT,
		name: { package: "probe", feishu_bot: s.botName, agent: "agent-a" }[kind as string],
		version: kind === "system" ? VERSION : "1.0.0",
		arch: "x86_64",
		filename: def.path.startsWith("/sdk/")
			? WHEEL
			: def.path.startsWith("/simple/")
				? STD_WHEEL
				: TARBALL,
		page: s.docSlug,
		skill: "sfly-platform",
		file: "SKILL.md",
		package: "sfly-std",
		// 会话的列表在 `/projects/:project/sessions`，项目是真实存在的默认项目；PEP 503 索引的包名参数是 `:package`。
		project: "default",
	};
	const value = samples[name];
	if (value === undefined) {
		throw new Error(
			`${def.method} ${def.path}：没有路径参数 ${name} 的样本值，在 read-only-routes.test.ts 的 sampleParam 里补上`,
		);
	}
	return value;
}

/** 方法不是 GET 的只读接口的请求体样本：没有样本就报错，让新接口的作者在这里补上。 */
function sampleBody(def: RouteDef): unknown {
	if (!("body" in def) || !def.body) return undefined;
	// 检查：第 1 版的「增删改」文档，再加一个没有这种节点类型的节点（有警告）；和各个场景的最新版本比都有差异
	if (def.path === "/orchestrations/:id/check") {
		const document = diffedDocument(1);
		document.nodes.push({
			id: "ghost",
			kind: "package",
			package: "probe",
			node: "nope",
			inputs: {},
		});
		return { document };
	}
	throw new Error(
		`${def.method} ${def.path}：没有请求体的样本值，在 read-only-routes.test.ts 的 sampleBody 里补上`,
	);
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
		{
			id: "check",
			kind: "package",
			package: "probe",
			node: "check",
			inputs: { url: "http://probe.test" },
		},
	],
	edges: [{ from: "entry", to: "check", kind: "chain" }],
	packages: { probe: "1.0.0" },
});

/**
 * 有子流程（入口声明了参数、异步任务节点没传而子流程里用到了它：预检警告）、注释框、飞书通知节点的场景。
 * 入口参数用 `param` 命名：第二个版本改掉它，让第一个版本上建的运行预设失效。
 */
const richDocument = (param: string) => ({
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [{ name: param, type: "string", default: "staging" }] },
		{
			id: "check",
			kind: "package",
			package: "probe",
			node: "check",
			inputs: { url: "http://probe.test" },
		},
		{ id: "spawn", kind: "async", params: {} },
		{
			id: "notify",
			kind: "package",
			package: "probe",
			node: "check",
			inputs: { url: "http://probe.test/notify" },
		},
		{
			id: "report",
			kind: "subflow_entry",
			name: "report",
			params: [{ name: "who", type: "string" }],
		},
		{
			id: "send",
			kind: "package",
			package: "probe",
			node: "check",
			inputs: { url: "${{ params.who }}" },
		},
	],
	edges: [
		{ from: "entry", to: "check", kind: "chain" },
		{ from: "check", to: "spawn", kind: "chain" },
		{ from: "spawn", to: "notify", kind: "chain" },
		{ from: "spawn", to: "report", kind: "dispatch" },
		{ from: "report", to: "send", kind: "chain" },
	],
	packages: { probe: "1.0.0" },
	annotations: [
		{
			id: "annotation_1",
			title: "汇报",
			note: "跑完后异步汇报",
			nodes: ["notify"],
			subflows: ["report"],
		},
	],
});

/**
 * 两个版本之间什么都改了的场景（对比两个版本的响应里每个数组都有内容）：第 2 版删掉 notify、加上 extra，改了 check 的输入和位置，
 * 换了连线，注释框有增、删、改，多锁定了一个开发版本的包。
 */
function diffedDocument(version: 1 | 2) {
	const doc = richDocument("env") as ReturnType<typeof richDocument> & {
		nodes: Array<Record<string, unknown>>;
		packages: Record<string, string>;
	};
	if (version === 1) {
		doc.annotations.push({
			id: "annotation_gone",
			title: "要删的",
			note: "",
			nodes: ["check"],
			subflows: [],
		});
		return doc;
	}
	doc.nodes = doc.nodes.filter((n) => n.id !== "notify");
	doc.nodes.push({
		id: "extra",
		kind: "package",
		package: "probe",
		node: "check",
		display_name: "额外的检查",
		inputs: { url: "http://probe.test/extra" },
	});
	const check = doc.nodes.find((n) => n.id === "check") as Record<string, unknown>;
	check.inputs = { url: "http://probe.test/v2" };
	check.position = { x: 900, y: 900 };
	doc.edges = doc.edges.map((e) => (e.to === "notify" ? { ...e, to: "extra" } : e));
	doc.packages = { ...doc.packages, "dev-probe": "dev" };
	doc.annotations = [
		{
			id: "annotation_1",
			title: "汇报（改过）",
			note: "跑完后异步汇报",
			nodes: ["extra"],
			subflows: ["report"],
		},
		{ id: "annotation_2", title: "新的", note: "", nodes: ["check"], subflows: [] },
	];
	return doc;
}

/** 节点包 `probe`：入口和出口有必填与顺序，指标有带标签的，图表引用它们（让包的、运行的响应里的数组都有内容）。 */
async function publishProbe(cp: TestControlPlane): Promise<void> {
	const archive = packageArchive(
		packageMetadata({
			name: "probe",
			version: "1.0.0",
			nodes: [
				{
					name: "check",
					title: "检查",
					entry: "probe.nodes:check",
					inputs: {
						type: "object",
						properties: { url: { type: "string" }, retries: { type: "integer", default: 3 } },
						required: ["url"],
						order: ["url", "retries"],
					},
					outputs: {
						type: "object",
						properties: { ok: {} },
						required: ["ok"],
						order: ["ok"],
					},
					metrics: [
						{ name: "tps", unit: "req/s", kind: "gauge" },
						{ name: "conn", unit: "个", kind: "gauge", labels: ["host"] },
					],
					charts: [
						{ title: "TPS", type: "line", metrics: ["tps"] },
						{ title: "连接", type: "line", metrics: ["conn"] },
					],
				},
			],
		}),
		{ "probe-1.0.0-py3-none-any.whl": new TextEncoder().encode("wheel") },
	);
	const res = await cp.fetch("/packages", publishInit(archive));
	if (res.status !== 201) throw new Error(`publish probe: ${await res.text()}`);
}

async function seed(cp: TestControlPlane): Promise<{ seeded: Seeded; agent: FakeAgent }> {
	const api = new ApiClient(cp);
	await publishProbe(cp);
	// 包索引里的 sfly-std：公共项目里发布的版本（索引的项目页和 wheel 下载读到真实的内容）。
	await publishIntoPublicProject(
		cp,
		packageArchive(packageMetadata({ name: "sfly-std", version: "0.0.1" }), {
			[STD_WHEEL]: strToU8("wheel"),
		}),
		{ name: "sfly-std", version: "0.0.1" },
	);
	const scenario = (name: string) => api.orchestrationWith(documentFor(), name);
	const checked = await scenario("巡检");
	const pressure = await scenario("压测");
	const archived = await scenario("旧巡检");
	const empty = await api.createOrchestration("空场景");
	const rich = await api.orchestrationWith(richDocument("env"), "有子流程");
	expect((await api.postEmpty(`/orchestrations/${archived}/archive`)).status).toBe(200);

	// 关注项（场景和运行的读数里有内容）、预设（运行用它触发）、飞书机器人和引用它的场景
	await putFocusItemsOk(api, checked, [
		{ node_id: "check", chart: "TPS" },
		{ node_id: "check", chart: "连接" },
	]);
	const preset = await createPresetOk(api, checked, {
		name: "生产",
		params: [{ name: "env", value: "prod" }],
	});
	const bot = await api.createFeishuBot("运维群", "https://feishu.test/hook/ops");
	await createPresetOk(api, rich, { name: "旧预设", params: [{ name: "env", value: "prod" }] });
	expect(
		(await api.patch(`/orchestrations/${rich}`, { run_notification: { bot: "运维群" } })).status,
	).toBe(200);
	// 第二个版本改掉入口参数：第一个版本上建的预设失效
	await api.saveVersion(rich, richDocument("stage"));
	const diffed = await api.orchestrationWith(diffedDocument(1), "增删改");
	await api.saveVersion(diffed, diffedDocument(2));

	// Agent：一个槽位（还在跑的运行占着它，下一次运行就排队）、有能力、装了节点包、加载了开发版本
	const agent = await FakeAgent.connect(
		cp.grpcUrl,
		{
			name: "agent-a",
			slots: 1,
			capabilities: [{ name: "files", version: 1 }],
			installedPackages: [{ name: "probe", version: "1.0.0" }],
			devPackages: [
				{
					name: "dev-probe",
					source: "/home/dev/probe",
					metadataJson: JSON.stringify(packageMetadata({ name: "dev-probe", version: "dev" })),
				},
			],
		},
		{ clock: cp.clock },
	);

	/** 触发一次运行，Agent 领到它的任务，上报日志、指标、动作摘要和一个产物；返回运行与任务。 */
	const start = async (
		scenarioId: string,
		level: LogLevel,
		text: string,
		{
			presetId,
			bulkLogs = false,
			running = false,
		}: { presetId?: string; bulkLogs?: boolean; running?: boolean } = {},
	) => {
		const runId = presetId
			? await (async () => {
					const res = await api.post(`/orchestrations/${scenarioId}/runs`, { preset: presetId });
					expect(res.status, await res.clone().text()).toBe(201);
					return ((await res.json()) as { id: string }).id;
				})()
			: await api.triggerOk(scenarioId, { env: "prod" });
		const task = await agent.nextAssign();
		await agent.started(task);
		const line = (seq: number, body: string) => ({
			seq: BigInt(seq),
			timeUnixMs: BigInt(T0),
			source: level === LogLevel.ERROR ? LogSource.STDERR : LogSource.STDOUT,
			level,
			text: body,
		});
		// 日志超过上限的任务：运行日志里「被截断的任务」不是空的
		agent.logs(
			task,
			bulkLogs
				? Array.from({ length: 40 }, (_, i) => line(i + 1, `${text}${"x".repeat(80)}`))
				: [line(1, text)],
		);
		const second = Math.floor(cp.clock.now().getTime() / 1000);
		agent.metrics(task, [
			["tps", second, 10],
			["tps", second + 1, 20],
			{
				name: "conn",
				timeUnixS: BigInt(second),
				value: 3,
				min: 3,
				max: 3,
				labels: { host: "a" },
			},
		]);
		agent.progress(task, 1, 2, "一半");
		const failedRun = level === LogLevel.ERROR;
		const stamp = agent.stamp(T0 + 1_000);
		const action = (id: number, result: "success" | "failed") => ({
			id,
			parent: null,
			depth: 0,
			name: "巡检",
			fields: {},
			...stamp,
			end_ts: stamp.ts + 500,
			end_mono: stamp.mono + 500,
			result,
			reason: result === "failed" ? "连接被拒绝" : null,
		});
		agent.actions(task, [
			agent.actionStart(1, "巡检", T0 + 1_000),
			agent.actionEnd(1, failedRun ? "failed" : "success", T0 + 1_500),
		]);
		agent.actionSummary(task, {
			total: 502,
			reported: 102,
			names: [
				{
					name: "巡检",
					total: 2,
					failed: failedRun ? 1 : 0,
					reported: 2,
					capped_ts: null,
					capped_mono: null,
				},
				// 超过明细上限，只计数
				{
					name: "心跳",
					total: 500,
					failed: 0,
					reported: 100,
					capped_ts: stamp.ts + 10,
					capped_mono: stamp.mono + 10,
				},
			],
			running: running
				? [{ id: 3, parent: null, depth: 0, name: "压测", fields: { 并发: "100" }, ...stamp }]
				: [],
			recent: [action(1, "success")],
			recent_failed: failedRun ? [action(2, "failed")] : [],
		});
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

	// 已结束的：用预设触发
	const done = await start(checked, LogLevel.INFO, "巡检通过", { presetId: preset.id });
	await agent.succeed(done.task, { ok: true });
	await settle(done.runId, "success");

	// 失败的：日志超过上限
	const failed = await start(checked, LogLevel.ERROR, "连接被拒绝", { bulkLogs: true });
	await agent.fail(failed.task, "连接被拒绝");
	await settle(failed.runId, "failed");

	// 还在跑的：Agent 在线、任务占着槽位，直到测试结束
	const live = await start(pressure, LogLevel.INFO, "压测中", { running: true });
	await settle(live.runId, "running");
	// 再来一次运行：Agent 的槽位满了，任务排队
	const queuedRunId = await api.triggerOk(pressure, { env: "prod" });
	await eventually(async () => {
		const { agents } = await api.getJson<{ agents: Array<{ queued_tasks: unknown[] }> }>("/agents");
		expect(agents[0]?.queued_tasks).toHaveLength(1);
	});

	// 会话：有每种持久事件，上一轮结束了；再来一个在做的、一个空闲没有事件的（列表里状态不同的几种）。
	const sessionId = await seedSession(cp.database.url, { events: persistedBodies() });
	await seedSession(cp.database.url, { title: "没有事件的会话", status: "idle" });
	const docs = await api.getJson<{ pages: Array<{ slug: string }> }>("/docs");
	const fixture = async (
		scenarioId: string,
		run?: { runId: string; task: AssignedTask },
	): Promise<Fixture> => ({
		scenarioId,
		latestVersion: await api.headVersion(scenarioId),
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
				queued: {
					scenarioId: pressure,
					latestVersion: await api.headVersion(pressure),
					runId: queuedRunId,
					chainInstanceId: (await api.run(queuedRunId)).chains[0]?.id as string,
				},
				empty: await fixture(empty),
				archived: await fixture(archived),
				rich: await fixture(rich),
				diffed: await fixture(diffed),
			},
			sessionId,
			presetId: preset.id,
			botName: bot.name,
			docSlug: docs.pages[0]?.slug as string,
		},
	};
}
