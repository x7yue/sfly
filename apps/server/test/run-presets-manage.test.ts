// 运行预设的维护（#323，ADR 0023）：修改、复制、删除，复制场景时一并复制，归档期间也能维护。
// HTTP API + 假 Agent + 真实 PostgreSQL。
import { randomUUID } from "node:crypto";
import { runsApi } from "@sfly/schema";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent } from "./support/fake-agent.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import {
	copyPreset,
	copyPresetOk,
	createPresetOk,
	deletePreset,
	errorOf,
	invalidPresetFields,
	listPresets,
	PRESET_PARAMS,
	presetScenario as scenario,
	triggerWithPreset,
	updatePreset,
	updatePresetOk,
} from "./support/presets.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("运行预设的维护", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	const connect = async (name: string) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name });
		agents.push(agent);
		return agent;
	};
	const advance = (ms: number) => (cp.clock as ManualClock).advance(ms);

	/** 场景和一个预设（host、port），返回两者的 ID。 */
	async function sceneWithPreset(name = "压测 A 集群") {
		const id = await api.orchestrationWith(scenario());
		const preset = await createPresetOk(
			api,
			id,
			{
				name,
				description: "A 集群",
				params: [
					{ name: "host", value: "a.example" },
					{ name: "port", value: 9000 },
				],
			},
			"小红",
		);
		return { id, preset };
	}

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

	describe("修改", () => {
		it("请求体里没有 params 时只改名称和说明，预设参数不变；记下最后修改人和时间，不产生新版本", async () => {
			const { id, preset } = await sceneWithPreset();
			advance(60_000);

			const renamed = await updatePresetOk(
				api,
				id,
				preset.id,
				{ name: "  压测 A 集群（新）", description: "改过的说明" },
				"小明",
			);
			expect(renamed).toEqual({
				...preset,
				name: "压测 A 集群（新）",
				description: "改过的说明",
				updated_by: "小明",
				updated_at: "2026-01-01T00:01:00.000Z",
			});
			expect(await listPresets(api, id)).toEqual([renamed]);

			// 只改说明：名称不变，说明可以清空。
			const cleared = await updatePresetOk(api, id, preset.id, { description: "" });
			expect(cleared).toMatchObject({
				name: "压测 A 集群（新）",
				description: "",
				params: preset.params,
			});
			expect(await api.headVersion(id)).toBe(1);
		});

		it("给了 params 时它是预设参数的完整清单：没写的参数不再固定，新的值立即用于触发", async () => {
			const { id, preset } = await sceneWithPreset();
			advance(1_000);

			const changed = await updatePresetOk(api, id, preset.id, {
				params: [
					{ name: "verbose", value: true },
					{ name: "host", value: "b.example" },
				],
			});
			expect(changed.params).toEqual([
				{ name: "host", secret: false, value: "b.example" },
				{ name: "verbose", secret: false, value: true },
			]);
			expect(changed).toMatchObject({ name: preset.name, description: preset.description });
			expect(changed.updated_at).toBe("2026-01-01T00:00:01.000Z");
			expect(await listPresets(api, id)).toEqual([changed]);

			const res = await triggerWithPreset(api, id, preset.id, { port: 81 });
			expect(res.status, await res.clone().text()).toBe(201);
			const run = await api.run(((await res.json()) as { id: string }).id);
			expect(run.params).toMatchObject({ host: "b.example", port: 81, verbose: true });
			expect(
				runsApi.get.response.parse(await api.getJson(`/runs/${run.id}`)).preset?.params,
			).toEqual(["host", "verbose"]);
		});

		it("给了 params 时按新建时的规则对照最新版本检查，不通过时 400 invalid_preset、预设不变", async () => {
			const { id, preset } = await sceneWithPreset();
			const fields = async (params: Array<{ name: string; value?: unknown }>) =>
				invalidPresetFields(await updatePreset(api, id, preset.id, { params }));

			expect(await fields([{ name: "hots", value: "h" }])).toEqual(["body.params.0.name"]);
			expect(await fields([{ name: "host" }])).toEqual(["body.params.0.value"]);
			expect(
				await fields([
					{ name: "host", value: "h" },
					{ name: "port", value: "9000" },
				]),
			).toEqual(["body.params.1.value"]);
			expect(await fields([{ name: "host", value: "  " }])).toEqual(["body.params.0.value"]);
			expect(
				await fields([
					{ name: "host", value: "a" },
					{ name: "host", value: "b" },
				]),
			).toEqual(["body.params.1.name"]);
			expect(await fields([])).toEqual(["body.params"]);

			expect(await listPresets(api, id)).toEqual([preset]);
		});

		it("名称和说明的规则同新建；没有要修改的字段时 400 invalid_preset", async () => {
			const { id, preset } = await sceneWithPreset();
			const fields = async (body: Record<string, unknown>) =>
				invalidPresetFields(await updatePreset(api, id, preset.id, body));

			expect(await fields({ name: "   " })).toEqual(["body.name"]);
			expect(await fields({ name: "名".repeat(41) })).toEqual(["body.name"]);
			expect(await fields({ description: "说".repeat(201) })).toEqual(["body.description"]);
			expect(await fields({})).toEqual(["body"]);
			expect(await fields({ name: "新名字", extra: 1 })).toEqual(["body"]);

			await updatePresetOk(api, id, preset.id, { name: "名".repeat(40) });
			await updatePresetOk(api, id, preset.id, { description: "说".repeat(200) });
		});

		it("名称在场景内唯一：改成别的预设的名称时 409 preset_name_taken，改成自己的名称不算重复", async () => {
			const { id, preset } = await sceneWithPreset("A");
			const other = await createPresetOk(api, id, {
				name: "B",
				params: [{ name: "host", value: "b" }],
			});

			const taken = await updatePreset(api, id, other.id, { name: " A " });
			expect(taken.status).toBe(409);
			expect((await errorOf(taken)).code).toBe("preset_name_taken");
			expect((await listPresets(api, id)).map((p) => p.name)).toEqual(["A", "B"]);

			await updatePresetOk(api, id, preset.id, { name: " A ", description: "只改说明" });
			await updatePresetOk(api, id, other.id, { name: "a" });
		});

		it("预设失效以后仍然可以改名称；改好预设参数以后照常用它触发", async () => {
			const { id, preset } = await sceneWithPreset();
			// 新版本删掉了 host：预设失效。
			await api.saveVersion(id, scenario(PRESET_PARAMS.filter((p) => p.name !== "host")));

			const renamed = await updatePresetOk(api, id, preset.id, { name: "旧集群" });
			expect(renamed.name).toBe("旧集群");
			expect(renamed.params).toEqual([
				{ name: "port", secret: false, value: 9000 },
				{ name: "host", secret: false, value: "a.example" },
			]);

			const fixed = await updatePresetOk(api, id, preset.id, {
				params: [{ name: "port", value: 9000 }],
			});
			expect(fixed.params).toEqual([{ name: "port", secret: false, value: 9000 }]);
			const res = await triggerWithPreset(api, id, preset.id, {});
			expect(res.status, await res.clone().text()).toBe(201);
			expect((await api.run(((await res.json()) as { id: string }).id)).params).toMatchObject({
				port: 9000,
			});

			// 改 params 时对照的是最新版本：已删除的参数不能再设为预设参数。
			expect(
				await invalidPresetFields(
					await updatePreset(api, id, preset.id, { params: [{ name: "host", value: "h" }] }),
				),
			).toEqual(["body.params.0.name"]);
		});

		it("预设不存在或不属于这个场景时 404 preset_not_found；写接口需要昵称", async () => {
			const { id, preset } = await sceneWithPreset();
			const other = await api.orchestrationWith(scenario(), "other");

			for (const [scene, presetId] of [
				[id, randomUUID()],
				[id, "not-a-uuid"],
				[other, preset.id],
				[randomUUID(), preset.id],
				["not-a-uuid", preset.id],
			] as const) {
				const res = await updatePreset(api, scene, presetId, { name: "x" });
				expect(res.status, `${scene} ${presetId}`).toBe(404);
				expect((await errorOf(res)).code).toBe("preset_not_found");
			}

			const anonymous = await cp.fetch(`/orchestrations/${id}/presets/${preset.id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "x" }),
			});
			expect(anonymous.status).toBe(400);
			expect((await errorOf(anonymous)).code).toBe("nickname_required");
			expect(await listPresets(api, id)).toEqual([preset]);
		});

		it("两个人先后修改同一个预设：后保存的覆盖先保存的，最后修改人是后保存的人", async () => {
			const { id, preset } = await sceneWithPreset();
			advance(1_000);
			await updatePresetOk(api, id, preset.id, { params: [{ name: "host", value: "甲" }] }, "甲");
			advance(1_000);
			const second = await updatePresetOk(
				api,
				id,
				preset.id,
				{ params: [{ name: "host", value: "乙" }] },
				"乙",
			);
			expect(second).toMatchObject({ updated_by: "乙", updated_at: "2026-01-01T00:00:02.000Z" });
			expect((await listPresets(api, id))[0]?.params).toEqual([
				{ name: "host", secret: false, value: "乙" },
			]);
		});
	});

	describe("复制", () => {
		it("复制成新名称的预设：新的 id，说明和预设参数不变，最后修改人记为复制的人；原预设不变，两者各自独立", async () => {
			const { id, preset } = await sceneWithPreset();
			advance(60_000);

			const copy = await copyPresetOk(api, id, preset.id, "  压测 A 集群 副本 ", "小明");
			expect(copy).toEqual({
				id: expect.any(String),
				name: "压测 A 集群 副本",
				description: "A 集群",
				params: preset.params,
				updated_by: "小明",
				updated_at: "2026-01-01T00:01:00.000Z",
			});
			expect(copy.id).not.toBe(preset.id);
			expect(await listPresets(api, id)).toEqual([preset, copy]);
			expect(await api.headVersion(id)).toBe(1);

			await updatePresetOk(api, id, copy.id, { params: [{ name: "host", value: "b.example" }] });
			expect((await listPresets(api, id))[0]).toEqual(preset);
		});

		it("复制出来的预设可以直接用来触发", async () => {
			const { id, preset } = await sceneWithPreset();
			const copy = await copyPresetOk(api, id, preset.id, "副本");
			const res = await triggerWithPreset(api, id, copy.id, { verbose: true });
			expect(res.status, await res.clone().text()).toBe(201);
			const run = await api.run(((await res.json()) as { id: string }).id);
			expect(run.params).toMatchObject({ host: "a.example", port: 9000, verbose: true });
		});

		it("secret 参数的值也一起复制", async () => {
			const { id, preset } = await sceneWithPreset();
			// 接口这一版还不能设 secret 预设参数（#324），直接在表里写一个。
			const client = new pg.Client({ connectionString: cp.database.url });
			await client.connect();
			try {
				await client.query(
					`UPDATE run_presets SET values = values || '{"token": "tok-secret"}' WHERE id = $1`,
					[preset.id],
				);
			} finally {
				await client.end();
			}

			const copy = await copyPresetOk(api, id, preset.id, "副本");
			const res = await triggerWithPreset(api, id, copy.id, {});
			expect(res.status, await res.clone().text()).toBe(201);
			expect((await (await connect("agent-a")).nextAssign()).inputs).toMatchObject({
				host: "a.example",
				token: "tok-secret",
			});
		});

		it("新名称在场景内已被占用时 409 preset_name_taken；名称规则同新建", async () => {
			const { id, preset } = await sceneWithPreset("A");
			await createPresetOk(api, id, { name: "B", params: [{ name: "host", value: "b" }] });

			for (const name of ["B", " A "]) {
				const taken = await copyPreset(api, id, preset.id, name);
				expect(taken.status, name).toBe(409);
				expect((await errorOf(taken)).code).toBe("preset_name_taken");
			}
			for (const name of ["   ", "名".repeat(41)]) {
				expect(await invalidPresetFields(await copyPreset(api, id, preset.id, name))).toEqual([
					"body.name",
				]);
			}
			expect(await listPresets(api, id)).toHaveLength(2);
		});

		it("预设不存在或不属于这个场景时 404 preset_not_found；写接口需要昵称", async () => {
			const { id, preset } = await sceneWithPreset();
			const other = await api.orchestrationWith(scenario(), "other");

			for (const [scene, presetId] of [
				[id, randomUUID()],
				[id, "not-a-uuid"],
				[other, preset.id],
				[randomUUID(), preset.id],
			] as const) {
				const res = await copyPreset(api, scene, presetId, "副本");
				expect(res.status, `${scene} ${presetId}`).toBe(404);
				expect((await errorOf(res)).code).toBe("preset_not_found");
			}

			const anonymous = await cp.fetch(`/orchestrations/${id}/presets/${preset.id}/copy`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "副本" }),
			});
			expect(anonymous.status).toBe(400);
			expect((await errorOf(anonymous)).code).toBe("nickname_required");
			expect(await listPresets(api, id)).toEqual([preset]);
		});
	});

	describe("删除", () => {
		it("删除后列表里没有它，也不能再用它触发；同名的预设可以重新建", async () => {
			const { id, preset } = await sceneWithPreset();
			const kept = await createPresetOk(api, id, {
				name: "留下的",
				params: [{ name: "host", value: "h" }],
			});

			const res = await deletePreset(api, id, preset.id);
			expect(res.status, await res.clone().text()).toBe(204);
			expect(await listPresets(api, id)).toEqual([kept]);
			const trigger = await triggerWithPreset(api, id, preset.id, {});
			expect(trigger.status).toBe(404);
			expect((await errorOf(trigger)).code).toBe("preset_not_found");
			expect(await api.headVersion(id)).toBe(1);

			await createPresetOk(api, id, {
				name: preset.name,
				params: [{ name: "host", value: "h" }],
			});
		});

		it("用它触发过的运行，在运行详情里仍然是触发时的预设名和预设参数；预设改名后同样", async () => {
			const { id, preset } = await sceneWithPreset();
			const first = await triggerWithPreset(api, id, preset.id, {});
			expect(first.status, await first.clone().text()).toBe(201);
			const firstRun = ((await first.json()) as { id: string }).id;

			await updatePresetOk(api, id, preset.id, { name: "改过的名字" });
			const second = await triggerWithPreset(api, id, preset.id, {});
			const secondRun = ((await second.json()) as { id: string }).id;
			expect((await deletePreset(api, id, preset.id)).status).toBe(204);

			for (const [runId, name] of [
				[firstRun, "压测 A 集群"],
				[secondRun, "改过的名字"],
			] as const) {
				const run = runsApi.get.response.parse(await api.getJson(`/runs/${runId}`));
				expect(run.preset, runId).toEqual({ id: preset.id, name, params: ["host", "port"] });
				expect(run.params).toMatchObject({ host: "a.example", port: 9000 });
			}
		});

		it("预设不存在或不属于这个场景时 404 preset_not_found；写接口需要昵称", async () => {
			const { id, preset } = await sceneWithPreset();
			const other = await api.orchestrationWith(scenario(), "other");

			for (const [scene, presetId] of [
				[id, randomUUID()],
				[id, "not-a-uuid"],
				[other, preset.id],
				[randomUUID(), preset.id],
			] as const) {
				const res = await deletePreset(api, scene, presetId);
				expect(res.status, `${scene} ${presetId}`).toBe(404);
				expect((await errorOf(res)).code).toBe("preset_not_found");
			}
			expect(
				(await cp.fetch(`/orchestrations/${id}/presets/${preset.id}`, { method: "DELETE" })).status,
			).toBe(400);
			expect(await listPresets(api, id)).toEqual([preset]);

			// 删除之后再删除：已经不存在。
			expect((await deletePreset(api, id, preset.id)).status).toBe(204);
			expect((await deletePreset(api, id, preset.id)).status).toBe(404);
		});
	});

	describe("复制场景", () => {
		it("新场景有同样的预设（新的 id，名称、说明和值不变，最后修改人记为复制的人），用其中一个预设能正常触发", async () => {
			const { id, preset } = await sceneWithPreset();
			const second = await createPresetOk(api, id, {
				name: "压测 B 集群",
				params: [
					{ name: "options", value: { mode: "fast" } },
					{ name: "host", value: "b.example" },
				],
			});
			advance(60_000);

			const res = await api.post(`/orchestrations/${id}/copy`, { name: "压测（副本）" }, "小明");
			expect(res.status, await res.clone().text()).toBe(201);
			const copyId = ((await res.json()) as { id: string }).id;

			const copied = await listPresets(api, copyId);
			expect(copied.map((p) => p.name)).toEqual(["压测 A 集群", "压测 B 集群"]);
			expect(copied.map(({ id: _, ...rest }) => rest)).toEqual(
				[preset, second].map(({ id: _, ...rest }) => ({
					...rest,
					updated_by: "小明",
					updated_at: "2026-01-01T00:01:00.000Z",
				})),
			);
			for (const p of copied) expect([preset.id, second.id]).not.toContain(p.id);
			// 原场景的预设不变。
			expect(await listPresets(api, id)).toEqual([preset, second]);

			const bPreset = copied[1];
			const trigger = await triggerWithPreset(api, copyId, bPreset?.id ?? "", { port: 81 });
			expect(trigger.status, await trigger.clone().text()).toBe(201);
			const run = await api.run(((await trigger.json()) as { id: string }).id);
			expect(run.params).toMatchObject({ host: "b.example", port: 81, options: { mode: "fast" } });
			expect(runsApi.get.response.parse(await api.getJson(`/runs/${run.id}`)).preset).toEqual({
				id: bPreset?.id,
				name: "压测 B 集群",
				params: ["host", "options"],
			});

			// 原场景的预设 ID 不能用在新场景上。
			const crossed = await triggerWithPreset(api, copyId, preset.id, {});
			expect(crossed.status).toBe(404);
			expect((await errorOf(crossed)).code).toBe("preset_not_found");
		});

		it("复制之后两个场景的预设各自独立；没有预设的场景照常复制", async () => {
			const { id, preset } = await sceneWithPreset();
			const plain = await api.orchestrationWith(scenario(), "没有预设");
			const copyOf = async (source: string, name: string) => {
				const res = await api.post(`/orchestrations/${source}/copy`, { name });
				expect(res.status, await res.clone().text()).toBe(201);
				return ((await res.json()) as { id: string }).id;
			};
			const copyId = await copyOf(id, "副本");
			expect(await listPresets(api, await copyOf(plain, "没有预设的副本"))).toEqual([]);

			const [inCopy] = await listPresets(api, copyId);
			await updatePresetOk(api, copyId, inCopy?.id ?? "", { name: "只改副本" });
			expect(await listPresets(api, id)).toEqual([preset]);
		});
	});

	describe("场景归档期间", () => {
		it("预设可以照常新建、修改、复制和删除，列表原样保留；恢复之后照常用来触发", async () => {
			const { id, preset } = await sceneWithPreset();
			expect((await api.postEmpty(`/orchestrations/${id}/archive`)).status).toBe(200);
			expect(await listPresets(api, id)).toEqual([preset]);

			const created = await createPresetOk(api, id, {
				name: "归档后新建",
				params: [{ name: "host", value: "new" }],
			});
			const changed = await updatePresetOk(api, id, preset.id, {
				description: "归档期间改的",
				params: [{ name: "host", value: "changed" }],
			});
			expect(changed).toMatchObject({ description: "归档期间改的" });
			const copy = await copyPresetOk(api, id, created.id, "归档后复制");
			expect((await deletePreset(api, id, created.id)).status).toBe(204);
			expect((await listPresets(api, id)).map((p) => p.name).sort()).toEqual(
				["归档后复制", "压测 A 集群"].sort(),
			);

			expect((await api.postEmpty(`/orchestrations/${id}/unarchive`)).status).toBe(200);
			const res = await triggerWithPreset(api, id, copy.id, {});
			expect(res.status, await res.clone().text()).toBe(201);
			expect((await api.run(((await res.json()) as { id: string }).id)).params).toMatchObject({
				host: "new",
			});
		});

		it("归档的场景也能复制，预设一起复制", async () => {
			const { id, preset } = await sceneWithPreset();
			expect((await api.postEmpty(`/orchestrations/${id}/archive`)).status).toBe(200);
			const res = await api.post(`/orchestrations/${id}/copy`, { name: "归档场景的副本" });
			expect(res.status, await res.clone().text()).toBe(201);
			const copyId = ((await res.json()) as { id: string }).id;
			expect((await listPresets(api, copyId)).map((p) => p.name)).toEqual([preset.name]);
		});
	});
});
