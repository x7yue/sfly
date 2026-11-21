// 场景版本里 secret 参数的默认值（#467）：读取接口给它打码（和运行参数、运行预设同一个掩码 ******），
// 保存时不把占位符当成新的默认值，引擎派发时仍然拿到原值。HTTP API + 假 Agent + 真实 PostgreSQL。
//
// 测试里的 secret 值都是明显的假值；断言「没有泄露」都是看响应的文本里没有它，不只看某个字段。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import {
	httpContract,
	type OrchestrationDocument,
	orchestrationsApi,
	runsApi,
	SECRET_MASK,
} from "@sfly/schema";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { echo, orchestration, param, spawn } from "./support/chains.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { createPresetOk, listPresets, presetScenario } from "./support/presets.js";
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

/**
 * 要触发运行的测试用的参数：去掉 json 类型。json 类型的 secret 参数的值是对象时，运行视图里不打码（#479），
 * 那是运行参数的打码的问题，不是场景版本默认值的；这里不把它带进运行里，#479 修好后可以加回来。
 */
const RUN_PARAMS = () => PARAMS().filter((p) => p.type !== "json");

/** 读出来应该是这样：secret 参数的默认值换成占位符，其余原样（补上了 schema 的默认值）。 */
const MASKED = [
	{ name: "token", type: "string", required: false, secret: true, default: MASK },
	{ name: "region", type: "string", required: false, secret: false, default: "cn-east" },
	{ name: "pin", type: "number", required: false, secret: true, default: MASK },
	{ name: "opts", type: "json", required: false, secret: true, default: MASK },
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
			const id = await scenario(RUN_PARAMS());
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
			expect(preflight.params.filter((p) => p.secret).map((p) => p.default)).toEqual([MASK, MASK]);
		});

		it("运行的 SSE：第一条运行视图里没有原值", async () => {
			const id = await scenario(RUN_PARAMS());
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
			const id = await scenario(RUN_PARAMS());
			const agent = await connect();
			const runId = await api.triggerOk(id);
			const assign = await agent.nextAssign();
			const ids = { scenario: id, run: runId, task: assign.taskId, preset: "x" };
			const streams = httpContract.filter(
				(def) => def.effect === "read" && "kind" in def && def.kind === "stream",
			);
			// 下限只是防「按契约遍历」遍历到空：在线编辑者的 SSE 删掉之后契约里还有 4 条（运行的状态、运行和任务的日志、任务的动作）。
			expect(streams.length).toBeGreaterThanOrEqual(4);
			let opened = 0;
			for (const def of streams) {
				const path = fill(def.path, ids);
				// 路径随便填的接口返回 404（不是 SSE），这里只看连上的；404 的响应在「所有 GET 接口」里查过。
				const sse = await SseClient.open(cp, path).catch(() => undefined);
				if (!sse) continue;
				opened += 1;
				try {
					// 每条流连上时先发一条控制面时间，运行和任务的流接着发当前状态。
					await eventually(() => expect(sse.received.length).toBeGreaterThan(0));
					expectNoRaw(`SSE ${path}`, JSON.stringify(sse.received));
				} finally {
					sse.close();
				}
			}
			expect(opened).toBeGreaterThanOrEqual(3);
		});

		/** 路径参数填什么：看路径的前缀和参数名；没见过的组合直接报错，新接口要在这里补上取值。 */
		const fill = (
			path: string,
			ids: { scenario: string; run: string; task: string; preset: string },
		) =>
			path.replace(/:([A-Za-z]+)|\*$/g, (_, name?: string) => {
				if (name === undefined) return "x";
				if (name === "id") {
					if (path.startsWith("/orchestrations/")) return ids.scenario;
					if (path.startsWith("/runs/")) return ids.run;
					if (path.startsWith("/tasks/")) return ids.task;
				}
				const others: Record<string, string> = {
					presetId: ids.preset,
					number: "1",
					version: "1.0.0",
					name: "stub",
					node: "echo",
					arch: "x86_64",
					filename: "x",
					page: "x",
					skill: "x",
					file: "x",
					project: "stub",
				};
				const found = others[name];
				if (found === undefined) {
					throw new Error(`${path} 的路径参数 :${name} 没有取值：到「所有 GET 接口」的测试里补上`);
				}
				return found;
			});

		it("契约里每个声明为只读的 GET 接口（SSE 除外）：读一遍，响应里都没有原值——新增的出口默认也是打码的", async () => {
			const id = await scenario(RUN_PARAMS());
			const agent = await connect();
			const runId = await api.triggerOk(id);
			const assign = await agent.nextAssign();
			const preset = await createPresetOk(api, id, {
				name: "预设",
				params: [{ name: "token", value: SECRET }],
			});
			const ids = { scenario: id, run: runId, task: assign.taskId, preset: preset.id };

			// 按契约声明的 effect 遍历，不自己维护清单（#464）：GET 一定是只读；非 GET 的只读接口（登记在 READS_WITH_TRACES）要请求体，不在这里；下面的写接口用例会要求请求过它们。
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
				expectNoRaw(`GET ${path}`, await res.text());
				if (res.status === 200) read += 1;
			}
			// 大部分接口读得到（读不到的是路径随便填的、只验证没有泄露）。
			expect(read).toBeGreaterThan(20);
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
			const id = await scenario(RUN_PARAMS());
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
