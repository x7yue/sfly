// 场景版本里 secret 参数的默认值（#467）：读取接口给它打码（和运行参数、运行预设同一个掩码 ******），
// 保存时不把占位符当成新的默认值，引擎派发时仍然拿到原值。HTTP API + 假 Agent + 真实 PostgreSQL。
//
// 测试里的 secret 值都是明显的假值；断言「没有泄露」都是看响应的文本里没有它，不只看某个字段。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import {
	ACTION_LIMITS,
	httpContract,
	type OrchestrationDocument,
	orchestrationsApi,
	runsApi,
	SECRET_MASK,
} from "@sfly/schema";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fullThenClipped, straddling, writeActions } from "./support/action-texts.js";
import { ApiClient } from "./support/api-client.js";
import { echo, orchestration, param, spawn } from "./support/chains.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { createPresetOk, listPresets, presetScenario } from "./support/presets.js";
import { allForms, BEYOND_I64 } from "./support/secret-forms.js";
import { persistedBodies, seedSession } from "./support/sessions.js";
import { SseClient } from "./support/sse-client.js";
import { paramsOf, storedDocument } from "./support/stored-document.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const MASK = "******";
const SECRET = "test-secret-value";
const SECRET_JSON = "test-secret-json";
const PIN = 7345921;

/** 入口参数：字符串、数字、json 三种 secret 参数都带默认值，另有一个带默认值的普通参数。 */
const PARAMS = () => [
	{ name: "token", type: "string", secret: true, default: SECRET },
	{ name: "region", type: "string", default: "cn-east" },
	{ name: "pin", type: "number", secret: true, default: PIN },
	{ name: "opts", type: "json", secret: true, default: { key: SECRET_JSON } },
];

/** 读出来应该是这样：secret 参数的默认值换成占位符，其余原样（补上了 schema 的默认值）。 */
const MASKED = [
	{ name: "token", type: "string", required: false, secret: true, default: MASK },
	{ name: "region", type: "string", required: false, secret: false, default: "cn-east" },
	{ name: "pin", type: "number", required: false, secret: true, default: MASK },
	{ name: "opts", type: "json", required: false, secret: true, default: MASK },
];

/**
 * 「节点把 secret 值写成各种写法」的测试用的：四种 secret 参数（字符串、数字、对象——有短叶子、布尔叶子、嵌套、非 ASCII，
 * 多行的字符串）。叶子的挑选：不会碰巧出现在时间戳、ID、固定文案里。
 */
const WRITE_PARAMS = [
	{ name: "token", type: "string", secret: true },
	{ name: "pin", type: "number", secret: true },
	{ name: "opts", type: "json", secret: true },
	{ name: "numbers", type: "json", secret: true },
	{ name: "tiny", type: "json", secret: true },
	{ name: "pem", type: "string", secret: true },
];
const WRITE_VALUES = {
	token: SECRET,
	pin: PIN,
	opts: {
		env: "test-env-leaf",
		user: SECRET_JSON,
		port: 8260413,
		region: "a",
		tls: true,
		zhShort: "好",
		nested: { list: ["test-leaf-deep", "x"], zh: "口令一二三" },
	},
	// 节点（Python）打印数字的写法和控制面写的不一样的两类：小数（0.00001 打印成 1e-05）和超出 64 位的整数。
	numbers: { rateLeaf: 0.00001, idLeaf: BEYOND_I64, tag: "12" },
	// 区间 [1e-6, 1e-5) 的小数：控制面写 0.000001，Python 写 1e-06，Agent 写进 task.json 的是 1e-6
	tiny: { rate: 0.000001, pin: "12", region: "a" },
	pem: "-----BEGIN TEST KEY-----\ntest-pem-line-one\n-----END TEST KEY-----",
};
/** 任何出口的文本里都不能出现的：字符串和数字叶子，PEM 的每一行，非 ASCII 叶子的 `\uXXXX` 写法，整段打印时的短叶子。 */
const WRITE_LEAKS = [
	SECRET,
	String(PIN),
	SECRET_JSON,
	"test-env-leaf",
	"8260413",
	"test-leaf-deep",
	"口令一二三",
	"\\u53e3\\u4ee4\\u4e00\\u4e8c\\u4e09",
	"BEGIN TEST KEY",
	"test-pem-line-one",
	"END TEST KEY",
	// 整个对象被原样打印时盖在整段里的短叶子：整段没盖住的话，这几处键值对会原样留在输出里（紧凑写法、json.dumps 默认写法、
	// ensure_ascii 的写法）。
	'"region": "a"',
	'"region":"a"',
	'"tls": true',
	'"tls":true',
	'"zhShort": "好"',
	'"zhShort":"好"',
	'"zhShort": "\\u597d"',
	// 数字的两种写法（控制面写的和节点打印的），以及整段里的数字叶子和短叶子 "12"
	"1e-05",
	"9.876543210987654e+19",
	"98765432109876540000",
	'"rateLeaf": 1e-05',
	'"idLeaf": 9.876543210987654e+19',
	'"tag": "12"',
	// 节点原样打印 task.json 里的文本（serde 的写法：同一个对象里小数在 serde 里的写法和控制面相同，整数是科学计数法）
	'"idLeaf":9.876543210987654e+19',
	'"rateLeaf":0.00001',
	'"tag":"12"',
	'"rate":1e-6',
];

interface VersionBody {
	number: number;
	document: OrchestrationDocument;
}
interface ErrorBody {
	error: { code: string; message: string; details?: unknown };
}

describe("场景版本里 secret 参数的默认值", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	const connect = async () => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		agents.push(agent);
		return agent;
	};
	/** 库里的一个会话，带每种持久事件：按会话 ID 定位的接口读它。 */
	const session = () => seedSession(cp.database.url, { events: persistedBodies() });
	/** 起一个控制面：发布 stub 包，注册 agent-a（触发前的预检只要求 Agent 已注册）。 */
	const start = async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		await (await connect()).disconnect();
	};
	const stop = async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp?.close();
	};
	/** 只读写文档的测试共用一个控制面；要触发运行的测试每个用例一个（假 Agent 重连会重新分配上一个用例留下的任务）。 */
	const sharedControlPlane = () => {
		beforeAll(start, 120_000);
		afterAll(stop);
	};
	const controlPlanePerTest = () => {
		beforeEach(start, 120_000);
		afterEach(stop);
	};

	const head = (id: string) => api.getJson<VersionBody>(`/orchestrations/${id}/head`);
	/** 以场景最新版本为编辑起点保存（和 `sfly scenario push` 一样带着 base_version）。 */
	const saveOn = (id: string, base: number, document: unknown) =>
		api.post(`/orchestrations/${id}/versions`, { base_version: base, document });
	/** 读出最新版本（占位符）、改一改、再存回去：「下载、修改、再上传」。 */
	async function roundTrip(id: string, edit: (document: OrchestrationDocument) => void = () => {}) {
		const { number, document } = await head(id);
		const edited = structuredClone(document);
		edit(edited);
		return saveOn(id, number, edited);
	}
	/** 文档里入口节点的第 index 个参数（可以直接改）。 */
	const paramAt = (document: OrchestrationDocument, index: number, nodeId = "entry") => {
		const found = paramsOf(document, nodeId)[index];
		if (!found) throw new Error(`${nodeId} 没有第 ${index} 个参数`);
		return found;
	};
	const withoutFirstParam = (document: OrchestrationDocument) => {
		const entry = document.nodes[0];
		if (entry?.kind === "entry") entry.params = entry.params.slice(1);
	};
	const errorOf = async (res: Response): Promise<ErrorBody["error"]> =>
		((await res.json()) as ErrorBody).error;
	/** 响应文本里不能出现的原值：字符串、json 里的字符串、数字。 */
	const RAW = [SECRET, SECRET_JSON, String(PIN), "test-secret-replaced"];
	/** 断言一个响应的全部文本（成功的、失败的、message 和 details）里没有任何 secret 原值。 */
	const expectNoRaw = (what: string, text: string) => {
		for (const raw of RAW) expect(text, `${what}：不能出现 ${raw}`).not.toContain(raw);
	};
	const headVersionOf = async (id: string) =>
		(await api.getJson<{ head_version: number }>(`/orchestrations/${id}`)).head_version;
	/** 一个场景：入口参数 PARAMS。 */
	const scenario = (params: Array<Record<string, unknown>> = PARAMS(), name = "保密默认值") =>
		api.orchestrationWith(presetScenario(params), name);

	describe("读取：secret 参数的默认值是占位符", () => {
		sharedControlPlane();

		it("最新版本（head）：secret 参数的默认值是 ******，普通参数和其余内容不变", async () => {
			const id = await scenario();
			const res = await api.get(`/orchestrations/${id}/head`);
			const text = await res.text();
			expect(text).not.toContain(SECRET);
			expect(text).not.toContain(SECRET_JSON);
			const view = orchestrationsApi.head.response.parse(JSON.parse(text));
			expect(paramsOf(view.document)).toEqual(MASKED);
			// 库里存的还是原值，其余节点没有变化。
			const stored = await storedDocument(cp, id);
			expect(paramsOf(stored)[0]?.default).toBe(SECRET);
			expect(view.document.nodes[1]).toEqual(stored.nodes[1]);
			expect(view.document.edges).toEqual(stored.edges);
		});

		it("某个历史版本：同样打码，每个版本按自己的声明（改成 secret 之前的版本仍是明文）", async () => {
			const id = await scenario([{ name: "token", type: "string", default: "test-plain-value" }]);
			await saveOn(
				id,
				1,
				presetScenario([{ name: "token", type: "string", secret: true, default: SECRET }]),
			);
			const v1 = await api.getJson<VersionBody>(`/orchestrations/${id}/versions/1`);
			const v2 = await api.getJson<VersionBody>(`/orchestrations/${id}/versions/2`);
			expect(paramsOf(v1.document)[0]?.default).toBe("test-plain-value");
			expect(paramsOf(v2.document)[0]?.default).toBe(MASK);
			expect(JSON.stringify([v1, v2])).not.toContain(SECRET);
		});

		it("没有默认值、默认值是 null 的 secret 参数不会凭空多出默认值，必填参数照常检查", async () => {
			const id = await scenario([
				{ name: "a", type: "string", secret: true },
				{ name: "b", type: "string", secret: true, default: null },
				{ name: "c", type: "string", secret: true, required: true, default: SECRET },
			]);
			const { document } = await head(id);
			expect(paramsOf(document).map((p) => p.default)).toEqual([undefined, null, MASK]);
			// 有默认值的必填参数：预检不要求触发时再给（打码前后「有没有默认值」一致）。
			const preflight = runsApi.preflight.response.parse(
				await api.getJson(`/orchestrations/${id}/preflight`),
			);
			expect(preflight.params.map((p) => p.default)).toEqual([undefined, null, MASK]);
		});

		it("子流程入口节点的 secret 参数同样打码", async () => {
			const id = await api.orchestrationWith(
				orchestration(
					[
						[{ id: "entry", kind: "entry", params: [] }, spawn("s")],
						[
							{
								id: "sub",
								kind: "subflow_entry",
								name: "inner",
								params: [param("key", { secret: true, default: SECRET })],
							},
							echo("e", { key: "${{ params.key }}" }),
						],
					],
					[["s", "sub"]],
				),
			);
			const view = await head(id);
			expect(paramsOf(view.document, "sub")).toMatchObject([{ name: "key", default: MASK }]);
			expect(JSON.stringify(view)).not.toContain(SECRET);
		});
	});

	describe("所有会交出场景文档（或默认值）的出口", () => {
		controlPlanePerTest();

		it("读场景、版本、保存和恢复的响应、版本列表、预检、复制、运行：响应的文本里都没有原值", async () => {
			const id = await scenario();
			const agent = await connect();
			const runId = await api.triggerOk(id);
			await agent.nextAssign();
			await createPresetOk(api, id, {
				name: "预设",
				params: [{ name: "token", value: SECRET }],
			});

			const saved = await roundTrip(id);
			expect(saved.status, await saved.clone().text()).toBe(201);
			const restored = await api.postEmpty(`/orchestrations/${id}/versions/1/restore`);
			expect(restored.status).toBe(201);
			const copied = await api.post(`/orchestrations/${id}/copy`, { name: "副本" });
			expect(copied.status).toBe(201);
			const copyId = ((await copied.clone().json()) as { id: string }).id;

			const responses: Array<[string, Response, { masked: boolean }]> = [
				["读场景", await api.get(`/orchestrations/${id}`), { masked: false }],
				["场景列表", await api.get("/orchestrations"), { masked: false }],
				["编辑起点", await api.get(`/orchestrations/${id}/head`), { masked: true }],
				["版本 1", await api.get(`/orchestrations/${id}/versions/1`), { masked: true }],
				["版本列表", await api.get(`/orchestrations/${id}/versions`), { masked: false }],
				["保存版本", saved, { masked: true }],
				["恢复版本", restored, { masked: true }],
				["触发前预检", await api.get(`/orchestrations/${id}/preflight`), { masked: true }],
				["复制场景", copied, { masked: false }],
				["副本的编辑起点", await api.get(`/orchestrations/${copyId}/head`), { masked: true }],
				["运行视图", await api.get(`/runs/${runId}`), { masked: false }],
				["运行列表", await api.get("/runs"), { masked: false }],
				["场景的运行", await api.get(`/orchestrations/${id}/runs`), { masked: false }],
				["运行预设", await api.get(`/orchestrations/${id}/presets`), { masked: true }],
				["首页", await api.get("/dashboard"), { masked: false }],
			];
			for (const [what, res, { masked }] of responses) {
				expect(res.status, what).toBeLessThan(300);
				const text = await res.text();
				expectNoRaw(what, text);
				if (masked) expect(text, what).toContain(MASK);
			}
			// 非 secret 参数的默认值照常读出来。
			const preflight = runsApi.preflight.response.parse(
				await api.getJson(`/orchestrations/${id}/preflight`),
			);
			expect(preflight.params.find((p) => p.name === "region")?.default).toBe("cn-east");
			expect(preflight.params.filter((p) => p.secret).map((p) => p.default)).toEqual([
				MASK,
				MASK,
				MASK,
			]);
		});

		it("运行的 SSE：第一条运行视图里没有原值", async () => {
			const id = await scenario();
			const agent = await connect();
			const runId = await api.triggerOk(id);
			await agent.nextAssign();
			const sse = await SseClient.open(cp, `/runs/${runId}/events`);
			try {
				const first = await sse.next("run");
				expectNoRaw("运行的 SSE", JSON.stringify(first.data));
				expect(JSON.stringify(first.data)).toContain(MASK);
			} finally {
				sse.close();
			}
		});

		it("契约里的每个 SSE 接口：连上之后收到的消息里都没有原值", async () => {
			const id = await scenario();
			const agent = await connect();
			const runId = await api.triggerOk(id);
			const assign = await agent.nextAssign();
			await sweepStreams(
				{ scenario: id, run: runId, task: assign.taskId, session: await session(), preset: "x" },
				expectNoRaw,
			);
		});

		/**
		 * 契约里的每个 SSE 接口各连一次：连上之后收到的消息交给 `check`（`what`、消息的全部文本）。
		 * 路径随便填的接口返回 404（不是 SSE），这里只看连上的；404 的响应在「所有 GET 接口」里查过。
		 */
		const sweepStreams = async (
			ids: { scenario: string; run: string; task: string; session: string; preset: string },
			check: (what: string, text: string) => void,
			options: { waitFor?: (path: string) => string | undefined } = {},
		) => {
			const streams = httpContract.filter(
				(def) => def.effect === "read" && "kind" in def && def.kind === "stream",
			);
			// 下限只是防「按契约遍历」遍历到空：在线编辑者的 SSE 删掉之后契约里还有 4 条（运行的状态、运行和任务的日志、任务的动作）。
			expect(streams.length).toBeGreaterThanOrEqual(4);
			let opened = 0;
			for (const def of streams) {
				const path = fill(def.path, ids);
				const sse = await SseClient.open(cp, path).catch(() => undefined);
				if (!sse) continue;
				opened += 1;
				try {
					// 每条流连上时先发一条控制面时间，运行和任务的流接着发当前状态。
					await eventually(() => expect(sse.received.length).toBeGreaterThan(0));
					// 带内容的事件（日志的行、动作、运行视图）在第一条之后才到：要检查这些内容时，等到流里出现 `waitFor` 给出的标记
					// （节点写出的、已经打码的文字），不能只看到第一条消息就过。
					const marker = options.waitFor?.(path);
					if (marker) {
						await eventually(() => expect(JSON.stringify(sse.received)).toContain(marker));
					}
					check(`SSE ${path}`, JSON.stringify(sse.received));
				} finally {
					sse.close();
				}
			}
			expect(opened).toBeGreaterThanOrEqual(3);
		};

		/** 路径参数填什么：看路径的前缀和参数名；没见过的组合直接报错，新接口要在这里补上取值。 */
		const fill = (
			path: string,
			ids: { scenario: string; run: string; task: string; session: string; preset: string },
		) =>
			path.replace(/:([A-Za-z]+)|\*$/g, (_, name?: string) => {
				if (name === undefined) return "x";
				if (name === "id") {
					if (path.startsWith("/orchestrations/")) return ids.scenario;
					if (path.startsWith("/runs/")) return ids.run;
					if (path.startsWith("/tasks/")) return ids.task;
					if (path.startsWith("/sessions/")) return ids.session;
				}
				const others: Record<string, string> = {
					presetId: ids.preset,
					number: "1",
					a: "1",
					b: "1",
					version: "1.0.0",
					name: "stub",
					node: "echo",
					arch: "x86_64",
					filename: "x",
					page: "x",
					skill: "x",
					file: "x",
					// 会话的列表在 /projects/:project/sessions，项目是默认项目；其余（PEP 503 索引）的 project 是包名。
					project: path.startsWith("/projects/") ? "default" : "stub",
				};
				const found = others[name];
				if (found === undefined) {
					throw new Error(`${path} 的路径参数 :${name} 没有取值：到「所有 GET 接口」的测试里补上`);
				}
				return found;
			});

		/**
		 * 按契约声明的 effect 遍历，不自己维护清单（#464）：GET 一定是只读；非 GET 的只读接口（登记在 NON_GET_READS）要请求体，
		 * 不在这里（下面的写接口用例会要求请求过它们）。每个 GET 接口（SSE 除外）读一遍，响应交给 `check`（`what`、响应文本）。
		 */
		const sweepReads = async (
			ids: { scenario: string; run: string; task: string; session: string; preset: string },
			check: (what: string, text: string) => void,
		) => {
			const reads = httpContract.filter(
				(def) =>
					def.effect === "read" &&
					def.method === "GET" &&
					!("kind" in def && def.kind === "stream"),
			);
			expect(reads.length).toBeGreaterThan(30);
			let read = 0;
			for (const def of reads) {
				const path = fill(def.path, ids);
				const res = await api.get(path);
				check(`GET ${path}`, await res.text());
				if (res.status === 200) read += 1;
			}
			// 大部分接口读得到（读不到的是路径随便填的、只验证没有泄露）。
			expect(read).toBeGreaterThan(20);
		};

		it("契约里每个声明为只读的 GET 接口（SSE 除外）：读一遍，响应里都没有原值——新增的出口默认也是打码的", async () => {
			const id = await scenario();
			const agent = await connect();
			const runId = await api.triggerOk(id);
			const assign = await agent.nextAssign();
			const preset = await createPresetOk(api, id, {
				name: "预设",
				params: [{ name: "token", value: SECRET }],
			});
			await sweepReads(
				{
					scenario: id,
					run: runId,
					task: assign.taskId,
					session: await session(),
					preset: preset.id,
				},
				expectNoRaw,
			);
		});

		it("节点把 secret 值用各种写法写进日志、进度、动作、输出和错误：契约里每个 GET 和 SSE 接口读到的都已打码（运行中、结束后各读一遍）", async () => {
			const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" }, { clock: cp.clock });
			agents.push(agent);
			const id = await api.orchestrationWith({
				default_agent: "agent-a",
				nodes: [
					{ id: "entry", kind: "entry", params: WRITE_PARAMS },
					...["a", "b"].map((nodeId) => ({
						id: nodeId,
						kind: "package",
						package: "stub",
						node: "echo",
						inputs: Object.fromEntries(
							WRITE_PARAMS.map((p) => [p.name, `\${{ params.${p.name} }}`]),
						),
					})),
				],
				edges: [
					{ from: "entry", to: "a", kind: "chain" },
					{ from: "a", to: "b", kind: "chain" },
				],
				packages: { stub: "1.0.0" },
			});
			const runId = await api.triggerOk(id, WRITE_VALUES);
			const a = await agent.nextAssign();
			expect(a.inputs).toMatchObject(WRITE_VALUES);

			// 节点能写出来的各种写法（用节点收到的值：键的顺序是库里的）。
			const forms = allForms(a.inputs);
			const everyForm = forms.join("\n");
			for (const leak of WRITE_LEAKS) {
				expect(everyForm, `测试要写出 ${leak}，写法清单里得有它`).toContain(leak);
			}
			const logLines = [...new Set(forms.flatMap((form) => form.split("\n")))];
			const T0 = Date.parse("2026-01-01T00:00:00.000Z");

			// 运行中：日志、进度、动作、动作摘要。
			agent.logs(
				a,
				logLines.map((text, i) => [i + 1, `form: ${text}`]),
			);
			agent.progress(a, 1, 2, `progress ${forms.slice(0, 12).join(" | ")}`);
			const actionEvents = [];
			for (let at = 0; at * 8 < Math.min(forms.length, 24); at++) {
				const chunk = forms.slice(at * 8, at * 8 + 8);
				const fields = Object.fromEntries(chunk.map((form, i) => [`k${i}`, form]));
				actionEvents.push(
					agent.actionStart(at + 1, `act ${chunk[0]}`, T0 + (at + 1) * 1_000, { fields }),
				);
			}
			actionEvents.push(
				agent.actionEnd(3, "failed", T0 + 5_000, {
					reason: forms.join("; "),
					fields: { note: forms[0] ?? "" },
				}),
			);
			agent.actions(a, actionEvents);
			const running = {
				id: 1,
				parent: null,
				depth: 0,
				name: `act ${forms[0]}`,
				fields: { k0: forms[1] ?? "" },
				...agent.stamp(T0 + 1_000),
			};
			const end = agent.stamp(T0 + 5_000);
			const failed = {
				...running,
				id: 3,
				name: `act ${forms[2]}`,
				end_ts: end.ts,
				end_mono: end.mono,
				result: "failed" as const,
				reason: forms.join("; "),
			};
			agent.actionSummary(a, {
				total: 3,
				reported: 3,
				names: [
					{
						name: running.name,
						total: 1,
						failed: 0,
						reported: 1,
						capped_ts: null,
						capped_mono: null,
					},
				],
				running: [running],
				recent: [failed],
				recent_failed: [failed],
			});
			await agent.sync();
			await eventually(async () => {
				const page = await api.getJson<{ last_seq: number }>(`/tasks/${a.taskId}/logs`);
				expect(page.last_seq).toBe(logLines.length);
			});

			const ids = {
				scenario: id,
				run: runId,
				task: a.taskId,
				session: await session(),
				preset: "x",
			};
			const noLeaks = (when: string) => (what: string, text: string) => {
				for (const leak of WRITE_LEAKS) {
					// 响应、事件、日志文件里的文字是 JSON 编码过的：带引号的片段在里面是 `\"` 的写法，两种都要查。
					for (const variant of new Set([leak, JSON.stringify(leak).slice(1, -1)])) {
						expect(text, `${when}：${what} 里不能出现 ${variant}`).not.toContain(variant);
					}
				}
			};
			await sweepReads(ids, noLeaks("运行中"));
			// 流里带内容的事件：任务日志和运行日志的行（`form: ******`）、动作（`act ******`）、运行视图（掩码）。
			const waitFor = (path: string) => {
				if (path.includes("/logs/events")) return `form: ${MASK}`;
				if (path.includes("/actions/events")) return `act ${MASK}`;
				if (/^\/runs\/[^/]+\/events/.test(path)) return MASK;
				return undefined;
			};
			await sweepStreams(ids, noLeaks("运行中"), { waitFor });
			// 读到的不是空的：运行视图里有掩码，日志里每一行都在（打码之后）。
			const during = await (await api.get(`/runs/${runId}`)).text();
			expect(during).toContain(MASK);
			expect(await (await api.get(`/tasks/${a.taskId}/logs`)).text()).toContain(`form: ${MASK}`);

			// 结束后：整个输出（原样的值、整段文字）、错误。
			await agent.succeed(a, {
				forms,
				whole: a.inputs,
				text: forms.join("\n"),
				pin: a.inputs.pin,
				flag: a.inputs.flag,
			});
			const b = await agent.nextAssign();
			agent.logs(
				b,
				forms.slice(0, 20).map((text, i) => [i + 1, text]),
			);
			// 出错位置（节点代码里的那一行）也是用户内容，可能带着值。
			await agent.fail(
				b,
				forms.join("; "),
				undefined,
				undefined,
				`load_config 第 3 行 ${forms.join(" ")}`,
			);
			await eventually(async () => expect((await api.run(runId)).status).toBe("failed"));
			const after = { ...ids, task: b.taskId };
			await sweepReads(after, noLeaks("结束后"));
			// 流连上的是任务 a（动作和日志在它上面），结束后重放的内容同样已经打码。
			await sweepStreams(ids, noLeaks("结束后"), { waitFor });
			const finished = await (await api.get(`/runs/${runId}`)).text();
			expect(finished).toContain(MASK);
			runsApi.get.response.parse(JSON.parse(finished));

			// 日志文件里也不保存明文。
			const { readdir, readFile } = await import("node:fs/promises");
			const { join } = await import("node:path");
			const entries = await readdir(join(cp.dataDir, "logs"), {
				recursive: true,
				withFileTypes: true,
			});
			const files = entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
			const stored = (await Promise.all(files.map((f) => readFile(f, "utf8")))).join("\n");
			noLeaks("结束后")("日志文件", stored);
		}, 90_000);

		/**
		 * 保密值要等后面的子流程创建时才带进来（#517）：user 不是 secret，x2 把它传给 subB 的 secret 参数 k，subB 创建之后它才是
		 * secret 值。`write` 在子流程创建之前往 sa 里写东西（日志、动作），返回之后等子流程创建，再让 b 结束。
		 */
		const lateRun = async (
			late: string,
			write: (agent: FakeAgent, sa: AssignedTask) => Promise<void>,
		) => {
			const id = await api.orchestrationWith({
				default_agent: "agent-a",
				nodes: [
					{ id: "entry", kind: "entry", params: [{ name: "user", type: "string" }] },
					{ id: "x1", kind: "async", params: {} },
					{ id: "subA", kind: "subflow_entry", name: "A", params: [] },
					{ id: "sa", kind: "package", package: "stub", node: "echo" },
					{ id: "b", kind: "package", package: "stub", node: "echo" },
					{ id: "x2", kind: "async", params: { k: "${{ params.user }}" } },
					{
						id: "subB",
						kind: "subflow_entry",
						name: "B",
						params: [{ name: "k", type: "string", secret: true }],
					},
				],
				edges: [
					{ from: "entry", to: "x1", kind: "chain" },
					{ from: "x1", to: "b", kind: "chain" },
					{ from: "b", to: "x2", kind: "chain" },
					{ from: "x1", to: "subA", kind: "dispatch" },
					{ from: "subA", to: "sa", kind: "chain" },
					{ from: "x2", to: "subB", kind: "dispatch" },
				],
				packages: { stub: "1.0.0" },
			});
			// 动作的时间折算要用时钟（FakeAgent.stamp）。
			const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" }, { clock: cp.clock });
			agents.push(agent);
			const runId = await api.triggerOk(id, { user: late });
			const first = await agent.nextAssign();
			const second = await agent.nextAssign();
			const [sa, b] = first.nodeId === "sa" ? [first, second] : [second, first];
			await write(agent, sa);
			await agent.succeed(b);
			await eventually(async () =>
				expect((await api.run(runId)).chains.map((c) => c.chain_id)).toContain("subB"),
			);
			return { agent, ids: { scenario: id, run: runId, task: sa.taskId, preset: "x" } };
		};

		/** 日志里已经写了 `count` 行（日志是异步写入的）。 */
		const logsWritten = (taskId: string, count: number) =>
			eventually(async () =>
				expect(
					(await api.getJson<{ lines: unknown[] }>(`/tasks/${taskId}/logs`)).lines,
				).toHaveLength(count),
			);

		it("后来才成为 secret 的值（出现在早于子流程创建写下的日志行和动作里，#517）：每个只读的 GET 和 SSE 接口读出来都没有原值", async () => {
			const LATE = "test-late-value";
			const { ids } = await lateRun(LATE, async (agent, sa) => {
				agent.logs(sa, [[1, `user ${LATE} logged in`]]);
				await logsWritten(sa.taskId, 1);
				// 动作的名称、字段（键和值）、失败原因、摘要里也有它。
				await writeActions(agent, sa, {
					name: `load ${LATE}`,
					key: `k-${LATE}`,
					value: `/x/${LATE}`,
					reason: `bad ${LATE}`,
				});
			});

			// 契约里每个只读的 GET 和 SSE 接口：读出来都没有原值；读日志的出口确实读到了这一行，只是已经是掩码。
			let logsRead = 0;
			let actionsRead = 0;
			await sweepReads(ids, (what, text) => {
				expect(text, `${what}：不能出现 ${LATE}`).not.toContain(LATE);
				if (what.includes("/logs") && text.includes("logged in")) logsRead += 1;
				if (what.includes("/actions") && text.includes("child")) actionsRead += 1;
			});
			// 按任务和按运行，分页和下载；动作的摘要和明细两个接口。
			expect(logsRead).toBeGreaterThanOrEqual(4);
			expect(actionsRead).toBeGreaterThanOrEqual(2);
			await sweepStreams(
				ids,
				(what, text) => expect(text, `${what}：不能出现 ${LATE}`).not.toContain(LATE),
				{
					waitFor: (path) =>
						path.includes("/logs/events")
							? "logged in"
							: path.includes("/actions/events")
								? "child"
								: undefined,
				},
			);
		});

		it("后来才成为 secret 的值正好跨在动作的名称、字段、失败原因的截断处（#517）：读出来也没有留下它的前几个字符", async () => {
			const LATE = "zebra-late-value";
			const PREFIX = LATE.slice(0, 4);
			const { nameChars, valueChars, reasonChars } = ACTION_LIMITS;
			// 值的前 8 个字符留在上限以内、后面的被截掉：写入时这个值还不是 secret，整个值打码认不出这半截。
			const { ids } = await lateRun(LATE, async (agent, sa) => {
				await writeActions(agent, sa, {
					name: straddling("n", nameChars, LATE, 8),
					key: straddling("k", nameChars, LATE, 8),
					value: straddling("v", valueChars, LATE, 8),
					// 失败原因超过上限时留前 reasonChars - 1 个字符、末尾加「…」。
					reason: straddling("r", reasonChars - 1, LATE, 8),
				});
			});
			await sweepReads(ids, (what, text) =>
				expect(text, `${what}：不能留下 ${PREFIX}`).not.toContain(PREFIX),
			);
			await sweepStreams(
				ids,
				(what, text) => expect(text, `${what}：不能留下 ${PREFIX}`).not.toContain(PREFIX),
				{ waitFor: (path) => (path.includes("/actions/events") ? "child" : undefined) },
			);
		});

		it("后来才成为 secret 的值：前面完整出现过一次、结尾又被截在值中间（#517）：读出来前面的完整出现和结尾的半截都盖住，没有留下它的前几个字符", async () => {
			const LATE = "zebra-late-value";
			const PREFIX = LATE.slice(0, 4);
			const { nameChars, valueChars, reasonChars } = ACTION_LIMITS;
			// 前面完整的一次换成掩码后文字变短、到不了上限：按打码之后的长度判断就会放过结尾那半截。
			const { ids } = await lateRun(LATE, async (agent, sa) => {
				await writeActions(agent, sa, {
					name: fullThenClipped("n", nameChars, LATE, 8),
					key: fullThenClipped("k", nameChars, LATE, 8),
					value: fullThenClipped("v", valueChars, LATE, 8),
					// SDK 截断失败原因：留前 reasonChars - 1 个字符，末尾加「…」。
					reason: `${fullThenClipped("r", reasonChars - 1, LATE, 8)}…`,
				});
			});
			let actionsRead = 0;
			await sweepReads(ids, (what, text) => {
				expect(text, `${what}：不能留下 ${PREFIX}`).not.toContain(PREFIX);
				if (what.includes("/actions") && text.includes("child")) actionsRead += 1;
			});
			expect(actionsRead).toBeGreaterThanOrEqual(2);
			await sweepStreams(
				ids,
				(what, text) => expect(text, `${what}：不能留下 ${PREFIX}`).not.toContain(PREFIX),
				{ waitFor: (path) => (path.includes("/actions/events") ? "child" : undefined) },
			);
			// 名称：前面的完整出现和结尾的半截各是一个掩码，中间的填充原样
			const summary = await api.getJson<{ running: Array<{ name: string }> }>(
				`/tasks/${ids.task}/actions/summary`,
			);
			expect(summary.running[0]?.name).toBe(
				`n${MASK}${"n".repeat(nameChars - 1 - LATE.length - 8)}${MASK}`,
			);
		});
	});

	describe("写接口的成功和失败响应", () => {
		controlPlanePerTest();

		/**
		 * 契约里声明为写的接口，这个测试不造请求的：和 secret 参数的默认值、值没有关系的，原因写在这里。
		 * 其余的写接口必须在下面的用例里被请求过（成功的和失败的），新增的写接口两边都不在时测试失败。
		 */
		const NOT_EXERCISED: Record<string, string> = {
			"POST /agents/:name/update-now": "只让 Agent 自更新，响应是被终止的任务数",
			"PUT /tasks/:id/artifacts/*": "上传产物的字节，不带场景和参数",
			"POST /feishu-bots": "登记 Webhook 地址（地址里的令牌另有打码，ADR 0020）",
			"PATCH /feishu-bots/:name": "同上",
			"DELETE /feishu-bots/:name": "同上",
			"POST /feishu-bots/:name/test": "同上",
			"POST /packages": "发布节点包，不带场景和参数",
		};
		/** 一个请求（方法 + 路径）对上契约里的哪个接口（路径模板）。 */
		const templateOf = (method: string, path: string): string | undefined => {
			const bare = path.split("?")[0] ?? path;
			return httpContract
				.filter((def) => def.method === method)
				.find((def) =>
					new RegExp(`^${def.path.replace(/:[A-Za-z]+/g, "[^/]+").replace(/\*$/, ".+")}$`).test(
						bare,
					),
				)?.path;
		};

		it("触发、保存、恢复、复制、预设、归档、取消：成功的和失败的响应（message 和 details 都算）里都没有原值；每个写接口都被请求过", async () => {
			const id = await scenario();
			const agent = await connect();
			const requested = new Set<string>();
			// 记下这个测试发出的每个请求（方法 + 路径模板），最后和契约里的写接口对照。
			const tracked = new ApiClient({
				fetch: (path, init) => {
					const template = templateOf(init?.method ?? "GET", path);
					if (template) requested.add(`${init?.method ?? "GET"} ${template}`);
					return cp.fetch(path, init);
				},
			});
			const responses: Array<[string, Response]> = [];
			const record = async (what: string, res: Promise<Response>) => {
				responses.push([what, await res]);
			};

			// 新建场景：成功、名称缺失（400）。
			await record("新建场景", tracked.post("/orchestrations", { name: "另一个" }));
			await record("新建场景：缺名称", tracked.post("/orchestrations", {}));
			// 触发：成功；把占位符当成值传回来（400）；传了没有声明的参数（400）；类型不对（400）；场景不存在（404）。
			const triggered = await tracked.trigger(id);
			responses.push(["触发", triggered]);
			const runId = ((await triggered.clone().json()) as { id: string }).id;
			await agent.nextAssign();
			await record("触发：占位符", tracked.trigger(id, { token: MASK }));
			await record("触发：未声明的参数", tracked.trigger(id, { unknown_param: SECRET }));
			await record("触发：类型不对", tracked.trigger(id, { pin: SECRET }));
			await record("触发：场景不存在", tracked.trigger("00000000-0000-4000-8000-000000000000"));
			// 保存：原样存回去（201）、编辑起点过期（409）、文档不合法（400）、占位符沿用不了（400）、缺 base_version（400）。
			const { number, document } = await head(id);
			await record(
				"保存",
				tracked.post(`/orchestrations/${id}/versions`, { base_version: number, document }),
			);
			await record(
				"保存：冲突",
				tracked.post(`/orchestrations/${id}/versions`, { base_version: number, document }),
			);
			await record(
				"保存：文档不合法",
				tracked.post(`/orchestrations/${id}/versions`, {
					base_version: number + 1,
					document: { ...document, nodes: SECRET },
				}),
			);
			const renamed = structuredClone(document);
			paramAt(renamed, 0).name = "renamed_token";
			await record(
				"保存：占位符沿用不了",
				tracked.post(`/orchestrations/${id}/versions`, {
					base_version: number + 1,
					document: renamed,
				}),
			);
			await record(
				"保存：缺 base_version",
				tracked.post(`/orchestrations/${id}/versions`, { document }),
			);
			// 检查（不保存，#424）：和保存同样的成功与失败；新的默认值写的是原值（含 SECRET），响应里的差异也是打码的。
			const changed = structuredClone(document);
			paramAt(changed, 0).default = `${SECRET}-new`;
			await record("检查", tracked.post(`/orchestrations/${id}/check`, { document: changed }));
			await record(
				"检查：冲突",
				tracked.post(`/orchestrations/${id}/check`, { base_version: number, document }),
			);
			await record(
				"检查：文档不合法",
				tracked.post(`/orchestrations/${id}/check`, { document: { ...document, nodes: SECRET } }),
			);
			await record(
				"检查：占位符沿用不了",
				tracked.post(`/orchestrations/${id}/check`, { document: renamed }),
			);
			// 恢复、复制。
			await record("恢复", tracked.postEmpty(`/orchestrations/${id}/versions/1/restore`));
			await record(
				"恢复：版本不存在",
				tracked.postEmpty(`/orchestrations/${id}/versions/99/restore`),
			);
			await record("复制", tracked.post(`/orchestrations/${id}/copy`, { name: "副本" }));
			await record("复制：缺名称", tracked.post(`/orchestrations/${id}/copy`, {}));
			// 预设：新建、重名、占位符、类型不对、触发时给固定参数传值、修改、复制、删除。
			const body = { name: "预设", params: [{ name: "token", value: SECRET }] };
			await record("预设：新建", tracked.post(`/orchestrations/${id}/presets`, body));
			await record("预设：重名", tracked.post(`/orchestrations/${id}/presets`, body));
			await record(
				"预设：占位符",
				tracked.post(`/orchestrations/${id}/presets`, {
					name: "占位符",
					params: [{ name: "token", value: MASK }],
				}),
			);
			await record(
				"预设：类型不对",
				tracked.post(`/orchestrations/${id}/presets`, {
					name: "类型",
					params: [{ name: "pin", value: SECRET }],
				}),
			);
			const [preset] = await listPresets(api, id);
			await record(
				"触发：预设参数不能传值",
				tracked.post(`/orchestrations/${id}/runs`, {
					preset: preset?.id,
					params: { token: SECRET },
				}),
			);
			await record(
				"预设：修改",
				tracked.patch(`/orchestrations/${id}/presets/${preset?.id}`, {
					params: [{ name: "pin", value: PIN }],
				}),
			);
			await record(
				"预设：复制",
				tracked.post(`/orchestrations/${id}/presets/${preset?.id}/copy`, { name: "预设的副本" }),
			);
			await record("预设：删除", tracked.delete(`/orchestrations/${id}/presets/${preset?.id}`));
			// 改场景设置、取消运行、归档、恢复归档。
			await record("改场景设置", tracked.patch(`/orchestrations/${id}`, { description: "说明" }));
			await record("取消运行", tracked.cancel(runId));
			await record("归档", tracked.postEmpty(`/orchestrations/${id}/archive`));
			await record("触发：已归档", tracked.trigger(id));
			await record("恢复归档", tracked.postEmpty(`/orchestrations/${id}/unarchive`));
			// 会话的写（助手没有配置：503）：响应里的错误说明也不能带原值。
			const sessionId = await session();
			await record("会话：新建", tracked.post("/projects/default/sessions", { text: "你好" }));
			await record("会话：发话", tracked.post(`/sessions/${sessionId}/messages`, { text: "你好" }));
			await record("会话：停止", tracked.postEmpty(`/sessions/${sessionId}/stop`));

			const statuses = new Set<number>();
			for (const [what, res] of responses) {
				statuses.add(res.status);
				expectNoRaw(what, await res.text());
			}
			// 成功、400、404、409 都出现过：测的确实是失败的响应。
			for (const status of [200, 201, 400, 404, 409]) expect([...statuses]).toContain(status);

			// 契约里声明为写的接口，以及声明为只读而方法不是 GET 的接口（按 GET 遍历的测试够不着它们）：
			// 要么在上面被请求过，要么登记在 NOT_EXERCISED 里写明为什么不需要。
			const writes = httpContract.filter(
				(def) => def.effect === "write" || (def.effect === "read" && def.method !== "GET"),
			);
			const key = (def: { method: string; path: string }) => `${def.method} ${def.path}`;
			expect(
				writes.map(key).filter((k) => !requested.has(k) && !(k in NOT_EXERCISED)),
				"契约里有声明为写的接口（或声明为只读而方法不是 GET 的接口），这个测试没有请求过它：在上面造它的成功和失败请求，或者登记到 NOT_EXERCISED 并写明为什么不需要",
			).toEqual([]);
			expect(
				Object.keys(NOT_EXERCISED).filter((k) => requested.has(k) || !writes.map(key).includes(k)),
				"NOT_EXERCISED 里有已经请求过的、或者契约里已经没有的接口：把它从清单里去掉",
			).toEqual([]);
		});
	});

	describe("引擎：用默认值触发的运行，节点收到的是原值", () => {
		controlPlanePerTest();

		it("主链：默认值原样派发给节点（字符串、数字、json），运行视图和日志里仍是打码的", async () => {
			const id = await scenario();
			const agent = await connect();
			const runId = await api.triggerOk(id);
			const assign = await agent.nextAssign();
			expect(assign.inputs).toMatchObject({
				token: SECRET,
				region: "cn-east",
				pin: PIN,
				opts: { key: SECRET_JSON },
			});
			const run = await api.run(runId);
			expect(run.params).toMatchObject({ token: MASK, pin: MASK });
			expect(JSON.stringify(run)).not.toContain(SECRET);
		});

		it("子流程入口参数的默认值：节点收到原值，读场景时是占位符", async () => {
			const id = await api.orchestrationWith(
				orchestration(
					[
						[{ id: "entry", kind: "entry", params: [] }, spawn("s")],
						[
							{
								id: "sub",
								kind: "subflow_entry",
								name: "inner",
								params: [param("key", { secret: true, default: SECRET })],
							},
							echo("e", { key: "${{ params.key }}" }),
						],
					],
					[["s", "sub"]],
				),
			);
			const agent = await connect();
			await api.triggerOk(id);
			expect((await agent.nextAssign()).inputs).toMatchObject({ key: SECRET });
			expect(JSON.stringify(await head(id))).not.toContain(SECRET);
		});

		it("读出来再原样保存的新版本（占位符沿用原值）：用它触发，节点收到的仍是原值", async () => {
			const id = await scenario();
			const saved = await roundTrip(id);
			expect(saved.status, await saved.clone().text()).toBe(201);
			const agent = await connect();
			await api.triggerOk(id);
			expect((await agent.nextAssign()).inputs).toMatchObject({
				token: SECRET,
				pin: PIN,
				opts: { key: SECRET_JSON },
			});
		});
	});

	describe("保存：下载、修改、再上传不把占位符存成默认值", () => {
		sharedControlPlane();

		it("读出来原样保存：新版本里的默认值仍是原值（库里的文档逐项相同）", async () => {
			const id = await scenario();
			const res = await roundTrip(id);
			expect(res.status, await res.clone().text()).toBe(201);
			const text = await res.text();
			expect(text).not.toContain(SECRET);
			expect(paramsOf(JSON.parse(text).document)).toEqual(MASKED);
			const v1 = await storedDocument(cp, id, 1);
			const v2 = await storedDocument(cp, id, 2);
			expect(paramsOf(v2)).toEqual(paramsOf(v1));
			expect(paramsOf(v2)[0]?.default).toBe(SECRET);
			expect(paramsOf(v2)[3]?.default).toEqual({ key: SECRET_JSON });
		});

		it("改了别的字段（默认 Agent、别的节点、参数说明）再保存：secret 默认值不变", async () => {
			const id = await scenario();
			const res = await roundTrip(id, (document) => {
				document.default_agent = "agent-b";
				paramAt(document, 1).description = "区域";
				paramAt(document, 0).description = "访问令牌";
			});
			expect(res.status, await res.clone().text()).toBe(201);
			const v2 = await storedDocument(cp, id, 2);
			expect(v2.default_agent).toBe("agent-b");
			expect(paramsOf(v2)[0]).toMatchObject({ default: SECRET, description: "访问令牌" });
		});

		it("改成新的值再保存：存的是新值；读出来仍是占位符", async () => {
			const id = await scenario();
			const res = await roundTrip(id, (document) => {
				paramAt(document, 0).default = "test-secret-replaced";
				paramAt(document, 2).default = 42;
			});
			expect(res.status, await res.clone().text()).toBe(201);
			expect(await res.text()).not.toContain("test-secret-replaced");
			const v2 = await storedDocument(cp, id, 2);
			expect(paramsOf(v2).map((p) => p.default)).toEqual([
				"test-secret-replaced",
				"cn-east",
				42,
				{ key: SECRET_JSON },
			]);
			expect(paramsOf((await head(id)).document)[0]?.default).toBe(MASK);
		});

		it("去掉默认值再保存：新版本没有默认值", async () => {
			const id = await scenario();
			const res = await roundTrip(id, (document) => {
				delete paramAt(document, 0).default;
			});
			expect(res.status).toBe(201);
			const v2 = await storedDocument(cp, id, 2);
			expect(paramsOf(v2)[0]).not.toHaveProperty("default");
			expect(paramsOf(v2)[2]?.default).toBe(PIN);
		});

		it("子流程入口、主链入口各自按节点沿用：同名参数互不串", async () => {
			const document = orchestration(
				[
					[
						{
							id: "entry",
							kind: "entry",
							params: [param("key", { secret: true, default: "test-secret-main" })],
						},
						spawn("s"),
					],
					[
						{
							id: "sub",
							kind: "subflow_entry",
							name: "inner",
							params: [param("key", { secret: true, default: "test-secret-sub" })],
						},
						echo("e"),
					],
				],
				[["s", "sub"]],
			);
			const id = await api.orchestrationWith(document);
			const res = await roundTrip(id);
			expect(res.status, await res.clone().text()).toBe(201);
			const v2 = await storedDocument(cp, id, 2);
			expect(paramsOf(v2, "entry")[0]?.default).toBe("test-secret-main");
			expect(paramsOf(v2, "sub")[0]?.default).toBe("test-secret-sub");
		});

		it("恢复历史版本：用那个版本的原值追加新版本，不经过占位符", async () => {
			const id = await scenario([{ name: "token", type: "string", secret: true, default: SECRET }]);
			await saveOn(
				id,
				1,
				presetScenario([
					{ name: "token", type: "string", secret: true, default: "test-secret-v2" },
				]),
			);
			const res = await api.postEmpty(`/orchestrations/${id}/versions/1/restore`);
			expect(res.status).toBe(201);
			expect(paramsOf(await storedDocument(cp, id, 3))[0]?.default).toBe(SECRET);
		});

		it("编辑起点过期：照常报版本冲突，不保存，也不因为占位符改成别的错误", async () => {
			const id = await scenario();
			const { number, document } = await head(id);
			await roundTrip(id, (d) => {
				d.default_agent = "agent-b";
			});
			const res = await saveOn(id, number, document);
			expect(res.status).toBe(409);
			expect((await errorOf(res)).code).toBe("version_conflict");
			expect(await headVersionOf(id)).toBe(2);
		});

		it("参数改了名：占位符没有同名的原值可以沿用，拒绝保存并指出是哪个参数", async () => {
			const id = await scenario();
			const res = await roundTrip(id, (document) => {
				paramAt(document, 0).name = "access_token";
			});
			expect(res.status).toBe(400);
			const error = await errorOf(res);
			expect(error.code).toBe("secret_default_placeholder");
			expect(error.message).toContain("access_token");
			expect(error.details).toEqual([
				{ node_id: "entry", param: "access_token", reason: "no_previous_value" },
			]);
			expect(JSON.stringify(error)).not.toContain(SECRET);
			expect(await headVersionOf(id)).toBe(1);
		});

		it("参数删了再加回来：加回来的参数不带占位符就是一个新参数，原来的默认值不会回来", async () => {
			const id = await scenario();
			const removed = await roundTrip(id, withoutFirstParam);
			expect(removed.status).toBe(201);
			const again = await roundTrip(id, (document) => {
				const entry = document.nodes[0];
				if (entry?.kind === "entry") {
					entry.params = [
						{ name: "token", type: "string", required: false, secret: true },
						...entry.params,
					];
				}
			});
			expect(again.status).toBe(201);
			expect(paramsOf(await storedDocument(cp, id, 3))[0]).not.toHaveProperty("default");
		});

		it("参数删了再加回来、默认值还是占位符：上一个版本里没有这个参数，拒绝", async () => {
			const id = await scenario();
			await roundTrip(id, withoutFirstParam);
			const { number, document } = await head(id);
			const withToken = structuredClone(document);
			const entry = withToken.nodes[0];
			if (entry?.kind === "entry") {
				entry.params = [
					{ name: "token", type: "string", required: false, secret: true, default: MASK },
					...entry.params,
				];
			}
			const res = await saveOn(id, number, withToken);
			expect(res.status).toBe(400);
			expect((await errorOf(res)).code).toBe("secret_default_placeholder");
		});

		it("改了类型、占位符还在：原来的默认值不再适用，拒绝", async () => {
			const id = await scenario();
			const res = await roundTrip(id, (document) => {
				paramAt(document, 0).type = "number";
			});
			expect(res.status).toBe(400);
			const error = await errorOf(res);
			expect(error.details).toEqual([{ node_id: "entry", param: "token", reason: "type_changed" }]);
		});

		it("从 secret 改成普通参数、占位符还在：不存成默认值、也不透出原值，拒绝并要求重新给", async () => {
			const id = await scenario();
			const res = await roundTrip(id, (document) => {
				paramAt(document, 0).secret = false;
			});
			expect(res.status).toBe(400);
			const error = await errorOf(res);
			expect(error.code).toBe("secret_default_placeholder");
			expect(error.details).toEqual([{ node_id: "entry", param: "token", reason: "unsecured" }]);
			expect(JSON.stringify(error)).not.toContain(SECRET);
			// 什么都没有保存。
			expect(await headVersionOf(id)).toBe(1);
		});

		it("从 secret 改成普通参数：重新给一个默认值，或者去掉默认值，都可以；原值不会被带过去", async () => {
			const id = await scenario();
			const given = await roundTrip(id, (document) => {
				const token = paramAt(document, 0);
				token.secret = false;
				token.default = "test-plain-new";
			});
			expect(given.status, await given.clone().text()).toBe(201);
			const removed = await roundTrip(id, (document) => {
				delete paramAt(document, 0).default;
			});
			expect(removed.status).toBe(201);
			const v2 = await storedDocument(cp, id, 2);
			expect(paramsOf(v2)[0]).toMatchObject({ secret: false, default: "test-plain-new" });
			const v3 = await storedDocument(cp, id, 3);
			expect(paramsOf(v3)[0]).not.toHaveProperty("default");
			expect(JSON.stringify([v2, v3])).not.toContain(SECRET);
		});

		it("从普通参数改成 secret：原来明文的默认值留在新版本里，读出来变成占位符", async () => {
			const id = await scenario([{ name: "token", type: "string", default: "test-plain-value" }]);
			const res = await roundTrip(id, (document) => {
				paramAt(document, 0).secret = true;
			});
			expect(res.status).toBe(201);
			expect(paramsOf(await storedDocument(cp, id, 2))[0]).toMatchObject({
				secret: true,
				default: "test-plain-value",
			});
			expect(paramsOf((await head(id)).document)[0]?.default).toBe(MASK);
		});

		it("新建场景的第一个版本带着占位符：没有上一个版本可以沿用，拒绝，不产生版本", async () => {
			const id = await api.createOrchestration("新场景");
			const res = await saveOn(id, 0, presetScenario(MASKED));
			expect(res.status).toBe(400);
			const error = await errorOf(res);
			expect(error.code).toBe("secret_default_placeholder");
			expect(error.details).toEqual([
				{ node_id: "entry", param: "token", reason: "no_previous_value" },
				{ node_id: "entry", param: "pin", reason: "no_previous_value" },
				{ node_id: "entry", param: "opts", reason: "no_previous_value" },
			]);
			expect(await headVersionOf(id)).toBe(0);
		});

		it("占位符碰撞：普通参数的默认值可以恰好是 ******；secret 参数的默认值写 ****** 一律是占位符", async () => {
			const plain = await scenario([{ name: "mask", type: "string", default: MASK }]);
			expect(paramsOf((await head(plain)).document)[0]?.default).toBe(MASK);
			expect((await roundTrip(plain)).status).toBe(201);
			expect(paramsOf(await storedDocument(cp, plain, 2))[0]?.default).toBe(MASK);

			// secret 参数想把默认值设成 ******：上一个版本有值就沿用上一个版本的，没有就拒绝；字面量存不进去。
			const id = await scenario([{ name: "token", type: "string", secret: true, default: SECRET }]);
			const res = await roundTrip(id, (document) => {
				paramAt(document, 0).default = MASK;
			});
			expect(res.status).toBe(201);
			expect(paramsOf(await storedDocument(cp, id, 2))[0]?.default).toBe(SECRET);
			const fresh = await api.createOrchestration("直接写占位符");
			const rejected = await saveOn(
				fresh,
				0,
				presetScenario([{ name: "token", type: "string", secret: true, default: MASK }]),
			);
			expect(rejected.status).toBe(400);
		});
	});

	describe("复制场景", () => {
		controlPlanePerTest();

		it("secret 默认值跟着复制：副本的第 1 版是原值（和运行预设的 secret 值一样），读副本仍是占位符", async () => {
			const id = await scenario();
			const res = await api.post(`/orchestrations/${id}/copy`, { name: "联调副本" });
			expect(res.status).toBe(201);
			const { id: copyId } = (await res.json()) as { id: string };
			expect(paramsOf(await storedDocument(cp, copyId, 1))).toEqual(
				paramsOf(await storedDocument(cp, id, 1)),
			);
			expect(paramsOf((await head(copyId)).document)).toEqual(MASKED);
			const agent = await connect();
			await api.triggerOk(copyId);
			expect((await agent.nextAssign()).inputs).toMatchObject({ token: SECRET });
		});
	});

	describe("保存时的警告", () => {
		sharedControlPlane();

		it("新保存的版本给 secret 参数写了默认值：警告里说明默认值会留在这个版本里，建议改用运行预设或触发时给出", async () => {
			const id = await api.createOrchestration("警告");
			const res = await saveOn(id, 0, presetScenario(PARAMS()));
			expect(res.status).toBe(201);
			const { warnings } = orchestrationsApi.saveVersion.response.parse(await res.json());
			const found = warnings.filter((w) => w.code === "secret_param_default");
			expect(found.map((w) => w.node_id)).toEqual(["entry", "entry", "entry"]);
			expect(found[0]?.message).toContain("token");
			expect(found[0]?.message).toContain("运行预设");
			expect(JSON.stringify(found)).not.toContain(SECRET);
			// 预检的警告不重复；普通参数的默认值没有这条警告。
			expect(found.some((w) => w.message.includes("region"))).toBe(false);
		});

		it("原样保存沿用下来的默认值也提示（它仍留在新版本里）；去掉默认值之后不再提示", async () => {
			const id = await scenario([{ name: "token", type: "string", secret: true, default: SECRET }]);
			const kept = await roundTrip(id);
			const keptWarnings = orchestrationsApi.saveVersion.response.parse(await kept.json()).warnings;
			expect(keptWarnings.some((w) => w.code === "secret_param_default")).toBe(true);
			const removed = await roundTrip(id, (document) => {
				delete paramAt(document, 0).default;
			});
			const removedWarnings = orchestrationsApi.saveVersion.response.parse(
				await removed.json(),
			).warnings;
			expect(removedWarnings.some((w) => w.code === "secret_param_default")).toBe(false);
		});
	});
});

// 常量和契约：读取方靠它认出占位符。
describe("占位符", () => {
	it("和运行、运行预设用同一个掩码", () => {
		expect(SECRET_MASK).toBe(MASK);
	});
});
