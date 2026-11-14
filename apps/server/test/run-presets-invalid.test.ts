// 失效的运行预设（#326，ADR 0023）：新版本让预设对不上以后的状态与问题清单、触发时拒绝、保存版本时的警告、修好以后恢复可用。
// HTTP API + 假 Agent + 真实 PostgreSQL。
import { orchestrationsApi, type PresetView, runsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import {
	createPresetOk,
	errorOf,
	listPresets,
	PRESET_PARAMS,
	presetScenario as scenario,
	triggerWithPreset,
	updatePresetOk,
} from "./support/presets.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** PRESET_PARAMS 的改法：按名称给某几个参数改字段，`null` 表示删除这个参数；`extra` 是新增的参数。 */
function declared(
	changes: Record<string, Record<string, unknown> | null> = {},
	extra: Array<Record<string, unknown>> = [],
) {
	return [
		...PRESET_PARAMS.flatMap((p) => {
			const change = changes[p.name as string];
			if (change === null) return [];
			return [{ ...p, ...change }];
		}),
		...extra,
	];
}

describe("失效的运行预设", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	const connect = async (name: string) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name });
		agents.push(agent);
		return agent;
	};

	/** 以当前最新版本为基线保存新版本，返回响应里的警告（按 HTTP 契约解析）。 */
	async function saveWarnings(id: string, params: Array<Record<string, unknown>>) {
		const res = await api.post(
			`/orchestrations/${id}/versions`,
			{ base_version: await api.headVersion(id), document: scenario(params) },
			"小蓝",
		);
		expect(res.status, await res.clone().text()).toBe(201);
		return orchestrationsApi.saveVersion.response.parse(await res.json()).warnings;
	}
	const invalidated = <T extends { code: string }>(warnings: T[]) =>
		warnings.filter((w) => w.code === "preset_invalidated");

	/** 场景（入口参数 PRESET_PARAMS）和一个固定了 host、port、options 的预设。 */
	async function sceneWithPreset(name = "压测 A 集群") {
		const id = await api.orchestrationWith(scenario());
		const preset = await createPresetOk(api, id, {
			name,
			params: [
				{ name: "host", value: "a.example" },
				{ name: "port", value: 9000 },
				{ name: "options", value: { mode: "fast" } },
			],
		});
		return { id, preset };
	}
	const status = async (id: string, presetId: string) => {
		const preset = (await listPresets(api, id)).find((p) => p.id === presetId) as PresetView;
		return { status: preset.status, problems: preset.problems };
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

	describe("有效性", () => {
		it("新建时可用；预设参数被删除或改名以后失效，问题清单写明是哪个参数；改回来以后恢复可用", async () => {
			const { id, preset } = await sceneWithPreset();
			expect(preset).toMatchObject({ status: "ok", problems: [] });

			await api.saveVersion(id, scenario(declared({ host: null })));
			expect(await status(id, preset.id)).toEqual({
				status: "invalid",
				problems: [{ param: "host", reason: "missing" }],
			});

			// 改名等于删掉旧名称：预设里的参数名不会跟着变。
			await api.saveVersion(
				id,
				scenario(declared({ host: { name: "server" }, port: { name: "tcp_port" } })),
			);
			expect(await status(id, preset.id)).toEqual({
				status: "invalid",
				problems: [
					{ param: "host", reason: "missing" },
					{ param: "port", reason: "missing" },
				],
			});

			await api.saveVersion(id, scenario());
			expect(await status(id, preset.id)).toEqual({ status: "ok", problems: [] });
		});

		it("保存的值不符合参数现在的类型时失效，问题清单写明是哪个参数；json 类型接受任何值", async () => {
			const { id, preset } = await sceneWithPreset();
			await api.saveVersion(
				id,
				scenario(
					declared({
						host: { type: "json" },
						port: { type: "string", default: "80" },
						options: { type: "number" },
					}),
				),
			);
			expect(await status(id, preset.id)).toEqual({
				status: "invalid",
				problems: [
					{ param: "options", reason: "type_mismatch" },
					{ param: "port", reason: "type_mismatch" },
				],
			});
		});

		it("新增参数、改默认值、改是否必填、改是否敏感以后，预设仍然可用", async () => {
			const { id, preset } = await sceneWithPreset();
			await api.saveVersion(
				id,
				scenario(
					declared(
						{
							host: { default: "other.example", required: false },
							port: { secret: true, required: true },
						},
						[{ name: "retries", type: "number", required: true }],
					),
				),
			);
			expect(await status(id, preset.id)).toEqual({ status: "ok", problems: [] });
		});

		it("触发前检查里的预设有同样的状态和问题清单，对照这次检查用的最新版本", async () => {
			const { id, preset } = await sceneWithPreset();
			await api.saveVersion(id, scenario(declared({ port: null })));
			const preflight = runsApi.preflight.response.parse(
				await api.getJson(`/orchestrations/${id}/preflight`),
			);
			expect(preflight.presets).toEqual(await listPresets(api, id));
			expect(preflight.presets).toMatchObject([
				{ id: preset.id, status: "invalid", problems: [{ param: "port", reason: "missing" }] },
			]);
		});

		it("失效的预设仍然可以只改名称；给了 params 并全部通过以后恢复可用，之后照常触发", async () => {
			const { id, preset } = await sceneWithPreset();
			await api.saveVersion(id, scenario(declared({ host: null })));

			const renamed = await updatePresetOk(api, id, preset.id, { name: "旧集群" });
			expect(renamed).toMatchObject({
				name: "旧集群",
				status: "invalid",
				problems: [{ param: "host", reason: "missing" }],
			});

			const fixed = await updatePresetOk(api, id, preset.id, {
				params: [
					{ name: "port", value: 9000 },
					{ name: "options", value: { mode: "fast" } },
				],
			});
			expect(fixed).toMatchObject({ status: "ok", problems: [] });
			const res = await triggerWithPreset(api, id, preset.id);
			expect(res.status, await res.clone().text()).toBe(201);
		});
	});

	describe("触发", () => {
		it("用失效的预设触发：409 preset_invalid，带上问题清单，不产生运行；修好以后可以正常触发", async () => {
			const { id, preset } = await sceneWithPreset();
			await api.saveVersion(
				id,
				scenario(declared({ host: null, port: { type: "string", default: "80" } })),
			);

			const res = await triggerWithPreset(api, id, preset.id, {});
			expect(res.status, await res.clone().text()).toBe(409);
			const error = await errorOf(res);
			expect(error.code).toBe("preset_invalid");
			expect(error.details).toEqual([
				{ param: "host", reason: "missing" },
				{ param: "port", reason: "type_mismatch" },
			]);
			const { runs } = (await api.getJson(`/orchestrations/${id}/runs`)) as { runs: unknown[] };
			expect(runs).toEqual([]);

			await updatePresetOk(api, id, preset.id, {
				params: [
					{ name: "port", value: "9000" },
					{ name: "options", value: { mode: "fast" } },
				],
			});
			const ok = await triggerWithPreset(api, id, preset.id, {});
			expect(ok.status, await ok.clone().text()).toBe(201);
			const run = runsApi.get.response.parse(
				await api.getJson(`/runs/${((await ok.json()) as { id: string }).id}`),
			);
			expect(run.params).toMatchObject({ port: "9000" });
			expect(run.preset).toMatchObject({ id: preset.id, params: ["port", "options"] });
		});

		it("预设失效和别的预设无关：同一个场景里没有失效的预设照常触发", async () => {
			const { id, preset } = await sceneWithPreset();
			const other = await createPresetOk(api, id, {
				name: "压测 B 集群",
				params: [{ name: "verbose", value: true }],
			});
			await api.saveVersion(id, scenario(declared({ host: null })));

			expect((await triggerWithPreset(api, id, preset.id)).status).toBe(409);
			const ok = await triggerWithPreset(api, id, other.id, {});
			expect(ok.status, await ok.clone().text()).toBe(201);
		});
	});

	describe("保存场景版本时的警告", () => {
		it("原来可用、对照新版本会失效的预设，各给出一条 preset_invalidated 警告，写明预设名和原因；版本照常保存", async () => {
			const { id, preset } = await sceneWithPreset("压测 A 集群");
			const second = await createPresetOk(api, id, {
				name: "压测 B 集群",
				params: [{ name: "port", value: 8000 }],
			});
			const unaffected = await createPresetOk(api, id, {
				name: "冒烟",
				params: [{ name: "verbose", value: true }],
			});

			const warnings = await saveWarnings(
				id,
				declared({ host: null, port: { type: "string", default: "80" } }),
			);
			const found = invalidated(warnings);
			expect(found).toHaveLength(2);
			expect(found[0]?.message).toContain("压测 A 集群");
			expect(found[0]?.message).toContain("host");
			expect(found[0]?.message).toContain("port");
			expect(found[1]?.message).toContain("压测 B 集群");
			expect(found[1]?.message).toContain("port");
			expect(found.map((w) => w.message).join("")).not.toContain("冒烟");
			expect(await api.headVersion(id)).toBe(2);
			expect(await status(id, preset.id)).toMatchObject({ status: "invalid" });
			expect(await status(id, second.id)).toMatchObject({ status: "invalid" });
			expect(await status(id, unaffected.id)).toMatchObject({ status: "ok" });
		});

		it("原来就已失效的预设不重复警告；修好以后再次失效会再警告", async () => {
			const { id, preset } = await sceneWithPreset();
			expect(invalidated(await saveWarnings(id, declared({ host: null })))).toHaveLength(1);

			// 又保存了一个版本，预设还是失效：不重复警告，哪怕问题变了。
			expect(invalidated(await saveWarnings(id, declared({ host: null, port: null })))).toEqual([]);

			// 修好之后再次失效。
			await updatePresetOk(api, id, preset.id, { params: [{ name: "verbose", value: true }] });
			expect(invalidated(await saveWarnings(id, declared({ verbose: null })))).toHaveLength(1);
		});

		it("没有让预设失效的改动没有这类警告：新增参数、改默认值、改是否必填、改是否敏感，没有预设的场景也一样", async () => {
			const { id } = await sceneWithPreset();
			const warnings = await saveWarnings(
				id,
				declared({ host: { required: false, default: "x" }, port: { secret: true } }),
			);
			expect(invalidated(warnings)).toEqual([]);

			const bare = await api.orchestrationWith(scenario(), "没有预设");
			expect(invalidated(await saveWarnings(bare, declared({ host: null })))).toEqual([]);
		});

		it("恢复历史版本也是保存新版本：会让预设失效时同样给出警告", async () => {
			const { id } = await sceneWithPreset();
			await api.saveVersion(id, scenario(declared({ host: null })));
			await api.saveVersion(id, scenario());
			const res = await api.postEmpty(`/orchestrations/${id}/versions/2/restore`, "小蓝");
			expect(res.status, await res.clone().text()).toBe(201);
			const restored = orchestrationsApi.restoreVersion.response.parse(await res.json());
			expect(restored.number).toBe(4);
			expect(invalidated(restored.warnings)).toHaveLength(1);
		});
	});
});
