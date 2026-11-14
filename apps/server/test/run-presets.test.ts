// 运行预设（#322，ADR 0023）：新建预设的检查、按预设触发、触发前检查与运行详情里的预设。
// HTTP API + 假 Agent + 真实 PostgreSQL。
import { randomUUID } from "node:crypto";
import { runsApi } from "@sfly/schema";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import {
	createPreset,
	createPresetOk,
	errorOf,
	invalidPresetFields,
	listPresets,
	presetScenario as scenario,
	triggerWithPreset,
} from "./support/presets.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("运行预设", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	const connect = async (name: string) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name });
		agents.push(agent);
		return agent;
	};

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		// 触发前的预检只要求 Agent 已注册。
		await (await connect("agent-a")).disconnect();
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	describe("新建", () => {
		it("按最新版本的入口参数新建：预设参数按声明顺序，记下最后修改人和时间，列表按名称排序", async () => {
			const id = await api.orchestrationWith(scenario());
			const b = await createPresetOk(
				api,
				id,
				{
					name: "  压测 B 集群 ",
					description: "B 集群，端口 9000",
					params: [
						{ name: "options", value: { mode: "fast" } },
						{ name: "host", value: "b.example" },
						{ name: "port", value: 9000 },
					],
				},
				"小红",
			);
			expect(b).toEqual({
				id: expect.any(String),
				name: "压测 B 集群",
				description: "B 集群，端口 9000",
				params: [
					{ name: "host", secret: false, value: "b.example" },
					{ name: "port", secret: false, value: 9000 },
					{ name: "options", secret: false, value: { mode: "fast" } },
				],
				status: "ok",
				problems: [],
				updated_by: "小红",
				updated_at: "2026-01-01T00:00:00.000Z",
			});
			const a = await createPresetOk(api, id, {
				name: "压测 A 集群",
				params: [{ name: "verbose", value: true }],
			});
			expect(a.description).toBe("");

			expect((await listPresets(api, id)).map((p) => p.name)).toEqual([
				"压测 A 集群",
				"压测 B 集群",
			]);
			expect(await listPresets(api, id)).toContainEqual(b);
			// 预设是场景的设置：不产生新版本。
			expect(await api.headVersion(id)).toBe(1);
		});

		it("名称去掉首尾空格后 1–40 个字符，说明不超过 200 个字符", async () => {
			const id = await api.orchestrationWith(scenario());
			const params = [{ name: "host", value: "h" }];
			expect(
				await invalidPresetFields(await createPreset(api, id, { name: "   ", params })),
			).toEqual(["body.name"]);
			expect(
				await invalidPresetFields(await createPreset(api, id, { name: "名".repeat(41), params })),
			).toEqual(["body.name"]);
			expect(
				await invalidPresetFields(
					await createPreset(api, id, { name: "p", description: "说".repeat(201), params }),
				),
			).toEqual(["body.description"]);

			await createPresetOk(api, id, { name: ` ${"名".repeat(40)} `, params });
			await createPresetOk(api, id, { name: "q", description: "说".repeat(200), params });
		});

		it("名称在场景内唯一、区分大小写：重复时 409 preset_name_taken，别的场景可以同名", async () => {
			const id = await api.orchestrationWith(scenario());
			const other = await api.orchestrationWith(scenario(), "other");
			const params = [{ name: "host", value: "h" }];
			await createPresetOk(api, id, { name: "Smoke", params });

			const taken = await createPreset(api, id, { name: " Smoke ", params });
			expect(taken.status).toBe(409);
			expect((await errorOf(taken)).code).toBe("preset_name_taken");

			await createPresetOk(api, id, { name: "smoke", params });
			await createPresetOk(api, other, { name: "Smoke", params });
			expect((await listPresets(api, id)).map((p) => p.name).sort()).toEqual(["Smoke", "smoke"]);
		});

		it("预设参数必须已声明、有值、符合类型、字符串不为空，不能重复，不通过时 400 invalid_preset 并指出参数", async () => {
			const id = await api.orchestrationWith(scenario());
			const fields = async (params: Array<{ name: string; value?: unknown }>) =>
				invalidPresetFields(await createPreset(api, id, { name: "p", params }));

			expect(await fields([{ name: "hots", value: "h" }])).toEqual(["body.params.0.name"]);
			expect(await fields([{ name: "host" }])).toEqual(["body.params.0.value"]);
			expect(await fields([{ name: "host", value: null }])).toEqual(["body.params.0.value"]);
			expect(
				await fields([
					{ name: "host", value: "h" },
					{ name: "port", value: "9000" },
					{ name: "verbose", value: "true" },
				]),
			).toEqual(["body.params.1.value", "body.params.2.value"]);
			expect(await fields([{ name: "host", value: 1 }])).toEqual(["body.params.0.value"]);
			expect(await fields([{ name: "host", value: "  " }])).toEqual(["body.params.0.value"]);
			expect(
				await fields([
					{ name: "host", value: "a" },
					{ name: "host", value: "b" },
				]),
			).toEqual(["body.params.1.name"]);
			expect(await fields([])).toEqual(["body.params"]);

			// json 接受任何值，不做类型转换。
			const json = await createPresetOk(api, id, {
				name: "json",
				params: [{ name: "options", value: "[1, 2]" }],
			});
			expect(json.params).toEqual([{ name: "options", secret: false, value: "[1, 2]" }]);
			expect(await listPresets(api, id)).toHaveLength(1);
		});

		it("入口节点没有声明参数时不能新建，包括还没有保存过版本的场景", async () => {
			const empty = await api.orchestrationWith(scenario([]));
			const unsaved = await api.createOrchestration("unsaved");
			for (const id of [empty, unsaved]) {
				expect(
					await invalidPresetFields(
						await createPreset(api, id, { name: "p", params: [{ name: "host", value: "h" }] }),
					),
				).toEqual(["body.params"]);
			}
		});

		it("写接口需要昵称请求头；场景不存在时 404", async () => {
			const id = await api.orchestrationWith(scenario());
			const anonymous = await cp.fetch(`/orchestrations/${id}/presets`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "p", params: [{ name: "host", value: "h" }] }),
			});
			expect(anonymous.status).toBe(400);
			expect((await errorOf(anonymous)).code).toBe("nickname_required");

			const missing = randomUUID();
			const created = await createPreset(api, missing, {
				name: "p",
				params: [{ name: "host", value: "h" }],
			});
			expect(created.status).toBe(404);
			expect((await api.get(`/orchestrations/${missing}/presets`)).status).toBe(404);
			expect((await api.get("/orchestrations/not-a-uuid/presets")).status).toBe(404);
		});
	});

	describe("按预设触发", () => {
		it("预设参数取预设的值，其余参数照常填写；运行详情记下预设", async () => {
			const id = await api.orchestrationWith(scenario());
			const preset = await createPresetOk(api, id, {
				name: "压测 A 集群",
				params: [
					{ name: "port", value: 9000 },
					{ name: "host", value: "a.example" },
				],
			});

			const res = await triggerWithPreset(api, id, preset.id, { verbose: true, token: "tok" });
			expect(res.status, await res.clone().text()).toBe(201);
			const triggered = runsApi.trigger.response.parse(await res.json());
			expect(triggered.preset).toEqual({
				id: preset.id,
				name: "压测 A 集群",
				params: ["host", "port"],
			});
			const run = await api.run(triggered.id);
			expect(run.params).toMatchObject({ host: "a.example", port: 9000, verbose: true });
			expect(runsApi.get.response.parse(await api.getJson(`/runs/${triggered.id}`)).preset).toEqual(
				triggered.preset,
			);

			const agent = await connect("agent-a");
			expect((await agent.nextAssign()).inputs).toEqual({
				host: "a.example",
				port: 9000,
				verbose: true,
				options: null,
				token: "tok",
			});

			// 不用预设的运行没有预设。
			const plain = await api.triggerOk(id, { host: "h" });
			expect(runsApi.get.response.parse(await api.getJson(`/runs/${plain}`)).preset).toBeNull();
		});

		it("params 给预设参数传了不同的值时 400 preset_param_locked、不创建运行，传相同的值照常触发", async () => {
			const id = await api.orchestrationWith(scenario());
			const preset = await createPresetOk(api, id, {
				name: "压测 A 集群",
				params: [
					{ name: "host", value: "a.example" },
					{ name: "options", value: { rounds: [1, 2], mode: "fast" } },
				],
			});

			const locked = await triggerWithPreset(api, id, preset.id, { host: "b.example" });
			expect(locked.status).toBe(400);
			expect(await errorOf(locked)).toMatchObject({
				code: "preset_param_locked",
				details: { param: "host", preset: "压测 A 集群" },
			});
			const lockedJson = await triggerWithPreset(api, id, preset.id, {
				options: { rounds: [2, 1], mode: "fast" },
			});
			expect((await errorOf(lockedJson)).code).toBe("preset_param_locked");
			expect((await api.getJson<{ runs: unknown[] }>(`/orchestrations/${id}/runs`)).runs).toEqual(
				[],
			);

			// 按 JSON 深比较：键的顺序不同也是相同的值。
			const same = await triggerWithPreset(api, id, preset.id, {
				host: "a.example",
				options: { mode: "fast", rounds: [1, 2] },
				port: 81,
			});
			expect(same.status, await same.clone().text()).toBe(201);
			const run = await api.run(((await same.json()) as { id: string }).id);
			expect(run.params).toMatchObject({
				host: "a.example",
				port: 81,
				options: { rounds: [1, 2], mode: "fast" },
			});
		});

		it("预设不存在或不属于这个场景时 404 preset_not_found", async () => {
			const id = await api.orchestrationWith(scenario());
			const other = await api.orchestrationWith(scenario(), "other");
			const elsewhere = await createPresetOk(api, other, {
				name: "p",
				params: [{ name: "host", value: "h" }],
			});

			for (const preset of [randomUUID(), "not-a-uuid", elsewhere.id]) {
				const res = await triggerWithPreset(api, id, preset, { host: "h" });
				expect(res.status, preset).toBe(404);
				expect((await errorOf(res)).code).toBe("preset_not_found");
			}
		});

		it("预设在触发时读取：之后再改预设表里的值和名称，已经开始的运行不受影响", async () => {
			const id = await api.orchestrationWith(scenario());
			const preset = await createPresetOk(api, id, {
				name: "压测 A 集群",
				params: [{ name: "host", value: "a.example" }],
			});
			const res = await triggerWithPreset(api, id, preset.id);
			expect(res.status, await res.clone().text()).toBe(201);
			const runId = ((await res.json()) as { id: string }).id;

			const client = new pg.Client({ connectionString: cp.database.url });
			await client.connect();
			try {
				await client.query(
					`UPDATE run_presets SET values = '{"host": "changed.example"}', name = '改过的名字' WHERE id = $1`,
					[preset.id],
				);
			} finally {
				await client.end();
			}

			const agent = await connect("agent-a");
			expect((await agent.nextAssign()).inputs).toMatchObject({ host: "a.example" });
			const run = runsApi.get.response.parse(await api.getJson(`/runs/${runId}`));
			expect(run.params).toMatchObject({ host: "a.example" });
			expect(run.preset).toEqual({ id: preset.id, name: "压测 A 集群", params: ["host"] });
		});
	});

	it("触发前检查返回场景的运行预设，和预设列表相同", async () => {
		const id = await api.orchestrationWith(scenario());
		const empty = runsApi.preflight.response.parse(
			await api.getJson(`/orchestrations/${id}/preflight`),
		);
		expect(empty.presets).toEqual([]);

		await createPresetOk(api, id, { name: "B", params: [{ name: "host", value: "b" }] });
		await createPresetOk(api, id, { name: "A", params: [{ name: "port", value: 1 }] });
		const preflight = runsApi.preflight.response.parse(
			await api.getJson(`/orchestrations/${id}/preflight`),
		);
		expect(preflight.presets.map((p) => p.name)).toEqual(["A", "B"]);
		expect(preflight.presets).toEqual(await listPresets(api, id));
	});
});
