// 模型的就绪状态（#548）：助手服务的 `/health` 里的 `model`（没有配置、连不上）进就绪状态；建会话、空闲的会话说话在写任何东西之前
// 503 `model_unavailable` 并写明原因；排队的会话在模型有问题时留在队里。真实控制面 + 真实数据库 + 进程内的假助手服务。
import type {
	AssistantHealth,
	Readiness,
	SessionDetailResponse,
	SessionListResponse,
} from "@sfly/schema";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { modelProblem } from "../src/sessions/session-service.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { FakeAssistant } from "./support/fake-assistant.js";
import type { ManualClock } from "./support/manual-clock.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const WORKBENCH = "workbench-a";
const MINUTE = 60_000;

describe("模型的就绪状态", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let assistant: FakeAssistant;
	let workbench: FakeAgent;
	const clock = () => cp.clock as ManualClock;

	/** 助手服务的 `/health` 里模型的状态；缓存 5 秒，改完推过去。 */
	const setModel = (model: Partial<AssistantHealth["model"]>) => {
		assistant.health = () => {
			const healthy = assistant.healthy();
			return { ...healthy, model: { ...healthy.model, ...model } };
		};
		clock().advance(6_000);
	};
	const agoIso = (ms: number) => new Date(clock().now().getTime() - ms).toISOString();

	beforeAll(async () => {
		assistant = await FakeAssistant.start();
		cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 20, max: 100 },
		});
		api = new ApiClient(cp);
		workbench = await FakeAgent.connect(
			cp.grpcUrl,
			{ name: WORKBENCH, peer: { port: 7001, publicAddress: "10.0.0.5" } },
			{ clock: cp.clock },
		);
		await assistant.connected();
	}, 60_000);

	afterAll(async () => {
		await workbench?.disconnect();
		await cp?.close();
		await assistant?.close();
	});

	beforeEach(async () => {
		// 每个用例从没有会话（上一个用例留下在做的会话会让这一个排队）、助手服务没有收到过命令开始。
		await cp.current.sessionService.idle();
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			await client.query("delete from sessions");
		} finally {
			await client.end();
		}
		assistant.prompts.length = 0;
		assistant.promptReply = () => undefined;
		assistant.strictTurns = true;
		setModel({});
	});

	const readiness = async (): Promise<Readiness> =>
		(await json<SessionListResponse>(await api.get("/projects/default/sessions"))).readiness;
	const create = (text = "给 http_check 加一个超时参数") =>
		api.post("/projects/default/sessions", { text }, "alice");
	const sessionCount = async () =>
		(await json<SessionListResponse>(await api.get("/projects/default/sessions"))).sessions.length;

	it("模型好：就绪，没有模型的问题", async () => {
		expect(await readiness()).toEqual({ ready: true, problems: [], workbench: WORKBENCH });
	});

	it("没有配置：就绪状态写明缺什么（原因来自助手服务的 /health）；建会话 503 model_unavailable，不留会话、不交给助手服务", async () => {
		setModel({
			configured: false,
			reachable: null,
			reason: "模型文件引用了环境变量 ACME_KEY，助手服务的环境里没有值",
		});
		const now = await readiness();
		expect(now.ready).toBe(false);
		expect(now.problems).toEqual([
			{
				kind: "model_not_configured",
				message: "没有配置模型：模型文件引用了环境变量 ACME_KEY，助手服务的环境里没有值",
			},
		]);
		const before = await sessionCount();
		const res = await create();
		expect(res.status).toBe(503);
		const { error } = await json<{ error: { code: string; message: string } }>(res);
		expect(error).toEqual({
			code: "model_unavailable",
			message: "没有配置模型：模型文件引用了环境变量 ACME_KEY，助手服务的环境里没有值",
		});
		expect(await sessionCount()).toBe(before);
		expect(assistant.prompts).toHaveLength(0);
	});

	it("连不上：就绪状态写「连不上模型端点…（上次检查：N 分钟前）」；说话时 503 model_unavailable，历史里没有这句话", async () => {
		const view = await json<{ id: string }>(await create());
		assistant.emit(view.id, 1, {
			type: "turn_end",
			turn: 1,
			outcome: "completed",
			reason: "助手已完成",
			steps: 0,
			model_calls: 1,
			duration_ms: 10,
		});
		await eventually(async () =>
			expect((await api.getJson<SessionDetailResponse>(`/sessions/${view.id}`)).status).toBe(
				"idle",
			),
		);
		const eventsBefore = (await api.getJson<SessionDetailResponse>(`/sessions/${view.id}`)).events;
		assistant.prompts.length = 0;
		setModel({
			reachable: false,
			endpoint: { host: "llm.internal", port: 8177 },
			checked_at: agoIso(3 * MINUTE + 20_000),
			reason: "连不上模型端点 llm.internal:8177：连接被拒绝",
			error_class: "unreachable",
		});
		expect((await readiness()).problems).toEqual([
			{
				kind: "model_unreachable",
				message: "连不上模型端点 llm.internal:8177：连接被拒绝（上次检查：3 分钟前）",
			},
		]);
		const res = await api.post(`/sessions/${view.id}/messages`, { text: "再来一次" });
		expect(res.status).toBe(503);
		expect(await json(res)).toMatchObject({
			error: {
				code: "model_unavailable",
				message: "连不上模型端点 llm.internal:8177：连接被拒绝（上次检查：3 分钟前）",
			},
		});
		const detail = await api.getJson<SessionDetailResponse>(`/sessions/${view.id}`);
		expect(detail.events).toEqual(eventsBefore);
		expect(detail.status).toBe("idle");
		expect(assistant.prompts).toHaveLength(0);
	});

	it("两个问题一起：都列出来；模型好了之后（缓存 5 秒过去）就绪、建会话照常", async () => {
		setModel({ configured: false, reachable: null, reason: "没有模型文件 /config/models.json" });
		await workbench.disconnect();
		try {
			const kinds = (await readiness()).problems.map((p) => p.kind);
			expect(kinds.sort()).toEqual(["model_not_configured", "workbench_offline"]);
		} finally {
			workbench = await FakeAgent.connect(
				cp.grpcUrl,
				{ name: WORKBENCH, peer: { port: 7001, publicAddress: "10.0.0.5" } },
				{ clock: cp.clock },
			);
		}
		setModel({});
		expect((await readiness()).ready).toBe(true);
		expect((await create()).status).toBe(201);
	});

	it("助手服务的 /health 没有 model 的问题、可 prompt 回 503 model_not_configured（检查和请求之间变了）：照旧 503 model_unavailable，这一轮补一条模型不可用的结局", async () => {
		const view = await json<{ id: string }>(await create());
		assistant.emit(view.id, 1, {
			type: "turn_end",
			turn: 1,
			outcome: "completed",
			reason: "助手已完成",
			steps: 0,
			model_calls: 1,
			duration_ms: 10,
		});
		await eventually(async () =>
			expect((await api.getJson<SessionDetailResponse>(`/sessions/${view.id}`)).status).toBe(
				"idle",
			),
		);
		assistant.promptReply = () => ({
			status: 503,
			code: "model_not_configured",
			message: "没有模型文件 /srv/config/models.json",
		});
		const res = await api.post(`/sessions/${view.id}/messages`, { text: "再来一次" });
		expect(res.status).toBe(503);
		expect((await json<{ error: { code: string } }>(res)).error.code).toBe("model_unavailable");
		const detail = await api.getJson<SessionDetailResponse>(`/sessions/${view.id}`);
		expect(detail.events.at(-1)).toMatchObject({
			type: "turn_end",
			outcome: "model_unavailable",
			steps: 0,
		});
		expect(detail.status).toBe("idle");
	});

	it("排队的会话在模型有问题时留在队里（不被一个个失败掉）；模型好了之后兜底的扫描开始它", async () => {
		const first = await json<{ id: string }>(await create("第一个"));
		const queued = await json<{ id: string; status: string }>(await create("第二个"));
		expect(queued.status).toBe("queued");
		setModel({
			reachable: false,
			checked_at: agoIso(0),
			reason: "连不上模型端点 llm.internal:8177：连接超时",
		});
		assistant.prompts.length = 0;
		assistant.emit(first.id, 1, {
			type: "turn_end",
			turn: 1,
			outcome: "completed",
			reason: "助手已完成",
			steps: 0,
			model_calls: 1,
			duration_ms: 10,
		});
		await eventually(async () =>
			expect((await api.getJson<SessionDetailResponse>(`/sessions/${first.id}`)).status).toBe(
				"idle",
			),
		);
		await cp.current.sessionService.idle();
		expect((await api.getJson<SessionDetailResponse>(`/sessions/${queued.id}`)).status).toBe(
			"queued",
		);
		expect(assistant.prompts).toHaveLength(0);
		setModel({});
		await cp.current.sessionService.startWaiting();
		await cp.current.sessionService.idle();
		await eventually(() => expect(assistant.prompts).toHaveLength(1));
		expect((await api.getJson<SessionDetailResponse>(`/sessions/${queued.id}`)).status).toBe(
			"running",
		);
	});

	it("缓存里的 /health 说模型好、其实刚坏了：排队的队首也不白失败一次（开始之前用刚问的 /health 再看）", async () => {
		const first = await json<{ id: string }>(await create("第一个"));
		const queued = await json<{ id: string; status: string }>(await create("第二个"));
		expect(queued.status).toBe("queued");
		// 缓存是新的、说模型好；之后助手服务的 /health 才说连不上（不拨时钟：缓存还有效）。
		expect((await readiness()).ready).toBe(true);
		assistant.health = () => {
			const healthy = assistant.healthy();
			return {
				...healthy,
				model: {
					...healthy.model,
					reachable: false,
					checked_at: agoIso(0),
					reason: "连不上模型端点 llm.internal:8177：连接被拒绝",
				},
			};
		};
		assistant.prompts.length = 0;
		assistant.emit(first.id, 1, {
			type: "turn_end",
			turn: 1,
			outcome: "completed",
			reason: "助手已完成",
			steps: 0,
			model_calls: 1,
			duration_ms: 10,
		});
		await eventually(async () =>
			expect((await api.getJson<SessionDetailResponse>(`/sessions/${first.id}`)).status).toBe(
				"idle",
			),
		);
		await cp.current.sessionService.idle();
		expect((await api.getJson<SessionDetailResponse>(`/sessions/${queued.id}`)).status).toBe(
			"queued",
		);
		expect(assistant.prompts).toHaveLength(0);
	});
});

describe("modelProblem：助手服务的 /health 里的 model → 就绪状态的一项", () => {
	const base: AssistantHealth["model"] = {
		configured: true,
		endpoint: { host: "llm.internal", port: 8177 },
		reachable: true,
		checked_at: null,
		reason: null,
		error_class: null,
	};
	const now = Date.parse("2026-11-26T12:00:00.000Z");
	const at = (ms: number) => new Date(now - ms).toISOString();

	it("连得上、还没检查过、不知道端点：没有问题", () => {
		expect(modelProblem(base, now)).toBeUndefined();
		expect(modelProblem({ ...base, reachable: null }, now)).toBeUndefined();
		expect(modelProblem({ ...base, endpoint: null, reachable: null }, now)).toBeUndefined();
	});

	it("没有配置：写明缺什么；助手服务没给原因时写「原因不明」；原因太长时截断", () => {
		expect(modelProblem({ ...base, configured: false, reason: "缺 X" }, now)).toEqual({
			kind: "model_not_configured",
			message: "没有配置模型：缺 X",
		});
		expect(modelProblem({ ...base, configured: false }, now)?.message).toBe(
			"没有配置模型：原因不明",
		);
		const long = modelProblem({ ...base, configured: false, reason: "长".repeat(1000) }, now);
		expect(long?.message.length).toBeLessThan(400);
	});

	it("连不上：上次检查「刚才」、N 分钟前、N 小时前；没有检查时间时不写括号", () => {
		const down = { ...base, reachable: false, reason: "连不上模型端点 a:1：连接被拒绝" };
		const text = (ms: number | null) =>
			modelProblem({ ...down, checked_at: ms === null ? null : at(ms) }, now)?.message;
		expect(text(5_000)).toBe("连不上模型端点 a:1：连接被拒绝（上次检查：刚才）");
		expect(text(59_000)).toBe("连不上模型端点 a:1：连接被拒绝（上次检查：刚才）");
		expect(text(60_000)).toBe("连不上模型端点 a:1：连接被拒绝（上次检查：1 分钟前）");
		expect(text(14 * MINUTE)).toBe("连不上模型端点 a:1：连接被拒绝（上次检查：14 分钟前）");
		expect(text(125 * MINUTE)).toBe("连不上模型端点 a:1：连接被拒绝（上次检查：2 小时前）");
		expect(text(null)).toBe("连不上模型端点 a:1：连接被拒绝");
		expect(modelProblem({ ...down, reason: null, checked_at: null }, now)?.message).toBe(
			"连不上模型端点",
		);
	});
});
