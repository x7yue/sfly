import { randomUUID } from "node:crypto";
import { ApiError, type ClientOptions, type OrchestrationDocumentInput } from "@sfly/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type FinishedRun,
	observedClient,
	seedFinishedRun,
	startClientControlPlane,
} from "./support/client.js";
import { eventually } from "./support/eventually.js";
import { startFakeFeishu } from "./support/fake-feishu.js";
import { type RecordingProxy, startRecordingProxy } from "./support/recording-proxy.js";
import type { TestControlPlane } from "./support/test-control-plane.js";

const NICKNAME = "小明";

const document = (env: string): OrchestrationDocumentInput => ({
	nodes: [{ id: "entry", kind: "entry", params: [{ name: "env", type: "string", default: env }] }],
});

const rejection = (promise: Promise<unknown>) =>
	promise.then(
		() => {
			throw new Error("调用没有失败");
		},
		(error: unknown) => error,
	);

describe("API 客户端的写操作", () => {
	let cp: TestControlPlane;
	let seeded: FinishedRun;
	const proxies: RecordingProxy[] = [];

	beforeAll(async () => {
		({ cp } = await startClientControlPlane());
		seeded = await seedFinishedRun(cp);
	});
	afterAll(async () => {
		await Promise.all(proxies.map((proxy) => proxy.close()));
		await cp.close();
	});

	async function through(options: Omit<ClientOptions, "baseUrl"> = {}) {
		const proxy = await startRecordingProxy(cp.httpUrl);
		proxies.push(proxy);
		return { proxy, ...observedClient({ baseUrl: proxy.url, ...options }) };
	}

	describe("运行", () => {
		it("带参数触发场景并拿到运行 id，运行记录里的触发人是配置的昵称", async () => {
			const { client } = await through({ nickname: NICKNAME });
			const run = await client.runs.trigger({
				params: { id: seeded.scenarioId },
				body: { params: { env: "prod" } },
			});
			expect(run).toMatchObject({
				orchestration_id: seeded.scenarioId,
				status: "running",
				triggered_by: NICKNAME,
				triggered_via: null,
				params: { env: "prod" },
			});

			const { runs } = await client.runs.listForOrchestration({
				params: { id: seeded.scenarioId },
			});
			expect(runs.find((r) => r.id === run.id)).toMatchObject({ triggered_by: NICKNAME });
			expect((await client.runs.get({ params: { id: run.id } })).triggered_by).toBe(NICKNAME);
		});

		it("不带请求体触发等于没有参数", async () => {
			const { client } = await through({ nickname: NICKNAME });
			const run = await client.runs.trigger({ params: { id: seeded.scenarioId } });
			expect(run.triggered_by).toBe(NICKNAME);
			expect(run.params).toEqual({ env: "staging" });
		});

		it("取消运行：返回取消后的视图，取消人是配置的昵称，运行最终 cancelled", async () => {
			const { client } = await through({ nickname: NICKNAME });
			const run = await client.runs.trigger({ params: { id: seeded.scenarioId } });

			const cancelled = await client.runs.cancel({ params: { id: run.id } });
			expect(cancelled.cancel).toMatchObject({ requested_by: NICKNAME });
			await eventually(async () => {
				expect((await client.runs.get({ params: { id: run.id } })).status).toBe("cancelled");
			});

			const again = await rejection(client.runs.cancel({ params: { id: run.id } }));
			expect(again).toBeInstanceOf(ApiError);
			expect(again).toMatchObject({ status: 409, code: "run_not_running", method: "POST" });
		});

		it("控制面拒绝写操作时抛出带控制面错误码的 ApiError", async () => {
			const { client } = await through({ nickname: NICKNAME });
			const missing = await rejection(client.runs.trigger({ params: { id: randomUUID() } }));
			expect(missing).toBeInstanceOf(ApiError);
			expect(missing).toMatchObject({ status: 404, method: "POST" });

			const offline = await rejection(client.agents.updateNow({ params: { name: "agent-a" } }));
			expect(offline).toMatchObject({ status: 409, code: "agent_offline" });
		});
	});

	describe("场景", () => {
		it("创建、改名、复制、归档和恢复场景", async () => {
			const { client } = await through({ nickname: NICKNAME });
			const created = await client.orchestrations.create({
				body: { name: "看板场景", description: "自建页面用" },
			});
			expect(created).toMatchObject({
				name: "看板场景",
				description: "自建页面用",
				head_version: 0,
				archived_at: null,
			});
			const params = { id: created.id };

			const renamed = await client.orchestrations.update({ params, body: { name: "改名后" } });
			expect(renamed).toMatchObject({ id: created.id, name: "改名后", description: "自建页面用" });

			await client.orchestrations.saveVersion({
				params,
				body: { base_version: 0, document: document("staging") },
			});
			const copy = await client.orchestrations.copy({ params, body: { name: "副本" } });
			expect(copy).toMatchObject({ name: "副本", head_version: 1 });
			expect(copy.id).not.toBe(created.id);

			const archived = await client.orchestrations.archive({ params });
			expect(archived.archived_at).not.toBeNull();
			const visible = async (archivedOnly: boolean) =>
				(await client.orchestrations.list({ query: { archived: archivedOnly ? "true" : "false" } }))
					.orchestrations;
			expect((await visible(false)).map((o) => o.id)).not.toContain(created.id);
			expect((await visible(true)).map((o) => o.id)).toContain(created.id);

			const restored = await client.orchestrations.unarchive({ params });
			expect(restored.archived_at).toBeNull();
			expect((await visible(false)).map((o) => o.id)).toContain(created.id);
		});

		it("保存场景版本，再恢复旧版本：恢复追加一个新版本，作者是配置的昵称", async () => {
			const { client } = await through({ nickname: NICKNAME });
			const { id } = await client.orchestrations.create({ body: { name: "版本场景" } });
			const params = { id };

			const first = await client.orchestrations.saveVersion({
				params,
				body: { base_version: 0, document: document("staging") },
			});
			const second = await client.orchestrations.saveVersion({
				params,
				body: { base_version: first.number, document: document("prod") },
			});
			expect([first.number, second.number]).toEqual([1, 2]);
			expect([first.author, second.author]).toEqual([NICKNAME, NICKNAME]);

			const restored = await client.orchestrations.restoreVersion({
				params: { id, number: "1" },
			});
			expect(restored.number).toBe(3);
			expect(restored.document).toEqual(first.document);
			const { versions } = await client.orchestrations.versions({ params });
			expect(versions.map((v) => [v.number, v.author])).toEqual([
				[3, NICKNAME],
				[2, NICKNAME],
				[1, NICKNAME],
			]);

			const stale = await rejection(
				client.orchestrations.saveVersion({
					params,
					body: { base_version: 1, document: document("dev") },
				}),
			);
			expect(stale).toBeInstanceOf(ApiError);
			expect(stale).toMatchObject({ status: 409, code: "version_conflict" });
		});
	});

	describe("飞书机器人", () => {
		it("新建、修改、发送测试消息、删除", async () => {
			const feishu = await startFakeFeishu();
			try {
				const { client } = await through({ nickname: NICKNAME });
				const created = await client.feishuBots.create({
					body: { name: "看板群", webhook_url: feishu.webhookUrl("a") },
				});
				expect(created.name).toBe("看板群");
				expect((await client.feishuBots.list()).bots.map((b) => b.name)).toEqual(["看板群"]);

				const params = { name: "看板群" };
				const replaced = await client.feishuBots.replaceWebhook({
					params,
					body: { webhook_url: feishu.webhookUrl("b") },
				});
				expect(replaced.name).toBe("看板群");

				const sent = await client.feishuBots.test({ params });
				expect(sent).toMatchObject({ ok: true, next_step: null });
				expect(feishu.requests.map((r) => r.path)).toEqual(["/open-apis/bot/v2/hook/b"]);
				expect(await client.feishuBots.references({ params })).toEqual({ scenarios: [] });

				expect(await client.feishuBots.remove({ params })).toBeUndefined();
				expect((await client.feishuBots.list()).bots).toEqual([]);
				const gone = await rejection(client.feishuBots.remove({ params }));
				expect(gone).toBeInstanceOf(ApiError);
				expect(gone).toMatchObject({ status: 404, code: "not_found", method: "DELETE" });
			} finally {
				await feishu.close();
			}
		});
	});

	describe("昵称", () => {
		it("中文昵称按 URL 编码放进 x-sfly-nickname，控制面记录到的昵称和配置的一致", async () => {
			const { client, proxy } = await through({ nickname: NICKNAME });
			const run = await client.runs.trigger({ params: { id: seeded.scenarioId } });
			expect(run.triggered_by).toBe("小明");

			const writes = proxy.requests.filter((r) => r.method === "POST");
			expect(writes).toHaveLength(1);
			expect(writes[0]?.headers["x-sfly-nickname"]).toBe("%E5%B0%8F%E6%98%8E");
		});

		it("昵称是函数时每次请求都重新取值", async () => {
			let current: string | null | undefined = "甲";
			const { client, proxy } = await through({ nickname: () => current });
			const params = { id: seeded.scenarioId };
			const byFirst = await client.runs.trigger({ params });
			current = "乙";
			const bySecond = await client.runs.trigger({ params });
			expect([byFirst.triggered_by, bySecond.triggered_by]).toEqual(["甲", "乙"]);

			current = undefined;
			const failure = await rejection(client.runs.trigger({ params }));
			expect(failure).toMatchObject({ code: "nickname_required" });
			expect(proxy.requests.filter((r) => r.method === "POST")).toHaveLength(2);
		});

		it.each([
			["没有给昵称", undefined],
			["昵称是空字符串", ""],
			["昵称只有空白", "  "],
			["昵称函数返回 null", () => null],
			["昵称函数返回 undefined", () => undefined],
			["昵称函数返回空白", () => " "],
		])("%s：每个写操作都在发请求之前抛出 nickname_required，控制面没有收到请求", async (_, nickname) => {
			const { client, proxy } = await through({ nickname });
			const params = { id: seeded.scenarioId };
			const writes = {
				"POST /orchestrations": () => client.orchestrations.create({ body: { name: "不会创建" } }),
				"PATCH /orchestrations/:id": () =>
					client.orchestrations.update({ params, body: { name: "不会改名" } }),
				"POST /orchestrations/:id/runs": () => client.runs.trigger({ params }),
				"POST /runs/:id/cancel": () => client.runs.cancel({ params: { id: seeded.runId } }),
				"DELETE /feishu-bots/:name": () => client.feishuBots.remove({ params: { name: "群" } }),
				"POST /agents/:name/update-now": () =>
					client.agents.updateNow({ params: { name: "agent-a" } }),
			};
			for (const [route, attempt] of Object.entries(writes)) {
				const failure = await rejection(attempt());
				expect(failure, route).toBeInstanceOf(ApiError);
				expect(failure, route).toMatchObject({ status: 400, code: "nickname_required" });
			}
			expect(proxy.requests).toEqual([]);
		});

		it("没有昵称时读操作不受影响，请求里也没有昵称", async () => {
			const { client, proxy } = await through();
			const { orchestrations } = await client.orchestrations.list();
			expect(orchestrations.map((o) => o.id)).toContain(seeded.scenarioId);
			expect(await client.runs.get({ params: { id: seeded.runId } })).toMatchObject({
				id: seeded.runId,
			});
			expect(proxy.requests.map((r) => r.method)).toEqual(["GET", "GET"]);
			for (const request of proxy.requests) {
				expect(request.headers["x-sfly-nickname"]).toBeUndefined();
			}
		});
	});
});
