// secret 参数作为预设参数（#324，ADR 0023「secret 预设参数」）：打码、`keep`、随预设和场景复制、日志打码。
// HTTP API + 假 Agent + 真实 PostgreSQL。
import { runsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import {
	copyPresetOk,
	createPreset,
	createPresetOk,
	errorOf,
	invalidPresetFields,
	listPresets,
	PRESET_PARAMS,
	type PresetParamBody,
	presetScenario as scenario,
	triggerWithPreset,
	updatePreset,
	updatePresetOk,
} from "./support/presets.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const MASK = "******";
const SECRET = "tok-s3cr3t-value";

describe("secret 预设参数", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	let live: FakeAgent | undefined;
	const connect = async (name = "agent-a") => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name });
		agents.push(agent);
		return agent;
	};
	/** 在线的 agent-a（第一次用到时才连接，之后复用）。 */
	const agentA = async () => (live ??= await connect());

	/** 场景和一个固定了 host 与 secret 参数 token 的预设。 */
	async function sceneWithSecretPreset(params: Array<Record<string, unknown>> = PRESET_PARAMS) {
		const id = await api.orchestrationWith(scenario(params));
		const preset = await createPresetOk(api, id, {
			name: "压测 A 集群",
			params: [
				{ name: "host", value: "a.example" },
				{ name: "token", value: SECRET },
			],
		});
		return { id, preset };
	}

	/** 用预设触发，返回 Agent 收到的任务输入。 */
	async function inputsOf(orchestrationId: string, presetId: string, params = {}) {
		const res = await triggerWithPreset(api, orchestrationId, presetId, params);
		expect(res.status, await res.clone().text()).toBe(201);
		return (await (await agentA()).nextAssign()).inputs;
	}

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		live = undefined;
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		// 触发前的预检只要求 Agent 已注册。
		await (await connect()).disconnect();
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	describe("打码", () => {
		it("新建、列表、修改、复制、触发前检查的响应里 secret 值都是掩码，触发后运行里照常用原值", async () => {
			const { id, preset } = await sceneWithSecretPreset();
			const expected = [
				{ name: "host", secret: false, value: "a.example" },
				{ name: "token", secret: true, value: MASK },
			];
			expect(preset.params).toEqual(expected);

			const responses: Array<[string, Response]> = [
				["列表", await api.get(`/orchestrations/${id}/presets`)],
				["触发前检查", await api.get(`/orchestrations/${id}/preflight`)],
				[
					"修改",
					await updatePreset(api, id, preset.id, {
						description: "改说明",
						params: [
							{ name: "host", value: "a.example" },
							{ name: "token", keep: true },
						],
					}),
				],
				[
					"复制",
					await api.post(`/orchestrations/${id}/presets/${preset.id}/copy`, { name: "副本" }),
				],
			];
			for (const [what, res] of responses) {
				expect(res.status, what).toBeLessThan(300);
				const text = await res.text();
				expect(text, what).not.toContain(SECRET);
				expect(text, what).toContain(MASK);
			}

			expect((await listPresets(api, id)).map((p) => p.params)).toEqual([expected, expected]);
			const preflight = runsApi.preflight.response.parse(
				await api.getJson(`/orchestrations/${id}/preflight`),
			);
			expect(preflight.presets.map((p) => p.params)).toEqual([expected, expected]);

			const triggered = await triggerWithPreset(api, id, preset.id, {});
			expect(triggered.status, await triggered.clone().text()).toBe(201);
			const triggeredText = await triggered.text();
			expect(triggeredText).not.toContain(SECRET);
			const runId = (JSON.parse(triggeredText) as { id: string }).id;
			const detail = await cp.fetch(`/runs/${runId}`);
			expect(await detail.text()).not.toContain(SECRET);
			expect((await api.run(runId)).params).toMatchObject({ host: "a.example", token: MASK });
			expect((await (await agentA()).nextAssign()).inputs).toMatchObject({
				host: "a.example",
				token: SECRET,
			});
		});

		it("非字符串的 secret 值同样打码，触发时仍是原来的类型", async () => {
			const params = [
				{ name: "host", type: "string", required: true },
				{ name: "pin", type: "number", secret: true },
				{ name: "flag", type: "boolean", secret: true },
				{ name: "opts", type: "json", secret: true },
			];
			const id = await api.orchestrationWith(scenario(params));
			const res = await createPreset(api, id, {
				name: "p",
				params: [
					{ name: "pin", value: 4242 },
					{ name: "flag", value: true },
					{ name: "opts", value: { key: "v-secret" } },
				],
			});
			expect(res.status, await res.clone().text()).toBe(201);
			const text = await res.text();
			for (const raw of ["4242", "v-secret"]) expect(text).not.toContain(raw);
			const [preset] = await listPresets(api, id);
			expect(preset?.params).toEqual([
				{ name: "pin", secret: true, value: MASK },
				{ name: "flag", secret: true, value: MASK },
				{ name: "opts", secret: true, value: MASK },
			]);
			expect(await inputsOf(id, preset?.id ?? "", { host: "h" })).toEqual({
				host: "h",
				pin: 4242,
				flag: true,
				opts: { key: "v-secret" },
			});
		});

		it("secret 值和其他预设参数一样要检查：类型要对，字符串不能为空", async () => {
			const params = [
				{ name: "pin", type: "number", secret: true },
				{ name: "token", type: "string", secret: true },
			];
			const id = await api.orchestrationWith(scenario(params));
			const fields = async (p: Array<{ name: string; value?: unknown }>) =>
				invalidPresetFields(await createPreset(api, id, { name: "p", params: p }));
			expect(await fields([{ name: "pin", value: "4242" }])).toEqual(["body.params.0.value"]);
			expect(await fields([{ name: "token", value: "  " }])).toEqual(["body.params.0.value"]);
			expect(await fields([{ name: "token" }])).toEqual(["body.params.0.value"]);
			expect(await listPresets(api, id)).toEqual([]);
		});
	});

	describe("修改时沿用原值（keep）", () => {
		it("不重新输入的 secret 参数写成 keep：按这个预设触发用的仍是原值；可以替换，也可以不带它", async () => {
			const { id, preset } = await sceneWithSecretPreset();

			const kept = await updatePresetOk(api, id, preset.id, {
				params: [
					{ name: "host", value: "b.example" },
					{ name: "token", keep: true },
				],
			});
			expect(kept.params).toEqual([
				{ name: "host", secret: false, value: "b.example" },
				{ name: "token", secret: true, value: MASK },
			]);
			expect(await inputsOf(id, preset.id)).toMatchObject({ host: "b.example", token: SECRET });

			// 只改名称和说明时，secret 值也不动。
			await updatePresetOk(api, id, preset.id, { name: "改名" });
			expect(await inputsOf(id, preset.id)).toMatchObject({ token: SECRET });

			// 重新输入：替换成新值。
			await updatePresetOk(api, id, preset.id, {
				params: [
					{ name: "host", value: "b.example" },
					{ name: "token", value: "tok-new" },
				],
			});
			expect(await inputsOf(id, preset.id)).toMatchObject({ token: "tok-new" });

			// 不带它：不再是预设参数，触发时照常填写。
			const dropped = await updatePresetOk(api, id, preset.id, {
				params: [{ name: "host", value: "b.example" }],
			});
			expect(dropped.params.map((p) => p.name)).toEqual(["host"]);
			expect(await inputsOf(id, preset.id, { token: "tok-caller" })).toMatchObject({
				host: "b.example",
				token: "tok-caller",
			});
		});

		it("keep 只能用在这个预设里已经有值的 secret 参数上，用错地方返回 400 invalid_preset，预设原样不动", async () => {
			const { id, preset } = await sceneWithSecretPreset();
			const only = await createPresetOk(api, id, {
				name: "只有 host",
				params: [{ name: "host", value: "h" }],
			});
			const fields = async (presetId: string, params: PresetParamBody[]) =>
				invalidPresetFields(await updatePreset(api, id, presetId, { params }));

			// 非 secret 参数。
			expect(await fields(preset.id, [{ name: "host", keep: true }])).toEqual([
				"body.params.0.keep",
			]);
			// 这个预设里原来没有值的 secret 参数。
			expect(
				await fields(only.id, [
					{ name: "host", value: "h" },
					{ name: "token", keep: true },
				]),
			).toEqual(["body.params.1.keep"]);
			// 没有声明的参数。
			expect(await fields(preset.id, [{ name: "nope", keep: true }])).toEqual([
				"body.params.0.name",
			]);
			// 重复。
			expect(
				await fields(preset.id, [
					{ name: "token", keep: true },
					{ name: "token", value: "x" },
				]),
			).toEqual(["body.params.1.name"]);
			// 新建时预设还不存在，没有什么可沿用的。
			expect(
				await invalidPresetFields(
					await createPreset(api, id, { name: "新", params: [{ name: "token", keep: true }] }),
				),
			).toEqual(["body.params.0.keep"]);

			// keep 只能是 true，也不能和 value 一起给。
			const malformed = [
				{ name: "token", keep: false },
				{ name: "token", keep: "yes" },
				{ name: "token", keep: true, value: "x" },
			] as unknown as PresetParamBody[];
			for (const bad of malformed) {
				const res = await updatePreset(api, id, preset.id, { params: [bad] });
				expect(res.status, JSON.stringify(bad)).toBe(400);
				expect((await errorOf(res)).code).toBe("invalid_preset");
			}

			expect((await listPresets(api, id)).map((p) => p.name).sort()).toEqual(
				["只有 host", "压测 A 集群"].sort(),
			);
			expect(await inputsOf(id, preset.id)).toMatchObject({ host: "a.example", token: SECRET });
		});
	});

	describe("是不是 secret 以最新版本的声明为准", () => {
		it("保存之后才变成 secret 的参数：值换成掩码，也能 keep，触发时仍是原值", async () => {
			const id = await api.orchestrationWith(scenario());
			const preset = await createPresetOk(api, id, {
				name: "p",
				params: [
					{ name: "host", value: "a.example" },
					{ name: "port", value: 9000 },
				],
			});
			expect(preset.params.map((p) => p.value)).toEqual(["a.example", 9000]);

			await api.saveVersion(
				id,
				scenario(PRESET_PARAMS.map((p) => (p.name === "host" ? { ...p, secret: true } : p))),
			);
			const [listed] = await listPresets(api, id);
			expect(listed?.params).toEqual([
				{ name: "host", secret: true, value: MASK },
				{ name: "port", secret: false, value: 9000 },
			]);

			const kept = await updatePresetOk(api, id, preset.id, {
				params: [
					{ name: "host", keep: true },
					{ name: "port", value: 9000 },
				],
			});
			expect(kept.params[0]).toEqual({ name: "host", secret: true, value: MASK });
			expect(await inputsOf(id, preset.id)).toMatchObject({ host: "a.example", port: 9000 });
		});

		it("不再是 secret 的参数：按普通参数显示，keep 不再适用", async () => {
			const { id, preset } = await sceneWithSecretPreset();
			await api.saveVersion(
				id,
				scenario(PRESET_PARAMS.map((p) => (p.name === "token" ? { ...p, secret: false } : p))),
			);
			const [listed] = await listPresets(api, id);
			expect(listed?.params).toEqual([
				{ name: "host", secret: false, value: "a.example" },
				{ name: "token", secret: false, value: SECRET },
			]);
			expect(
				await invalidPresetFields(
					await updatePreset(api, id, preset.id, { params: [{ name: "token", keep: true }] }),
				),
			).toEqual(["body.params.0.keep"]);
		});

		it("类型变了、保存的值对不上的 secret 参数不能沿用：keep 返回 invalid_preset，重新输入以后预设恢复可用", async () => {
			const { id, preset } = await sceneWithSecretPreset();
			await api.saveVersion(
				id,
				scenario(PRESET_PARAMS.map((p) => (p.name === "token" ? { ...p, type: "number" } : p))),
			);
			const [stale] = await listPresets(api, id);
			expect(stale).toMatchObject({
				status: "invalid",
				problems: [{ param: "token", reason: "type_mismatch" }],
			});
			expect(JSON.stringify(stale)).not.toContain(SECRET);

			const keep = await updatePreset(api, id, preset.id, {
				params: [
					{ name: "host", value: "a.example" },
					{ name: "token", keep: true },
				],
			});
			expect(await invalidPresetFields(keep)).toEqual(["body.params.1.keep"]);

			const fixed = await updatePresetOk(api, id, preset.id, {
				params: [
					{ name: "host", value: "a.example" },
					{ name: "token", value: 4242 },
				],
			});
			expect(fixed.status).toBe("ok");
			expect(await inputsOf(id, preset.id)).toMatchObject({ token: 4242 });
		});

		it("已不在入口参数里的预设参数，值也不返回：原来是不是 secret 已经无从判断", async () => {
			const { id } = await sceneWithSecretPreset();
			await api.saveVersion(id, scenario(PRESET_PARAMS.filter((p) => p.name !== "token")));
			const responses = [
				await api.get(`/orchestrations/${id}/presets`),
				await api.get(`/orchestrations/${id}/preflight`),
			];
			for (const res of responses) expect(await res.text()).not.toContain(SECRET);
			const [listed] = await listPresets(api, id);
			expect(listed?.params.map((p) => p.name)).toEqual(["host", "token"]);
			expect(listed?.params[1]?.value).toBe(MASK);
		});
	});

	describe("复制", () => {
		it("复制预设之后，按新预设触发用的是同一个 secret 值", async () => {
			const { id, preset } = await sceneWithSecretPreset();
			const copy = await copyPresetOk(api, id, preset.id, "副本");
			expect(copy.params).toEqual(preset.params);
			expect(await inputsOf(id, copy.id)).toMatchObject({ host: "a.example", token: SECRET });
		});

		it("复制场景之后，新场景的预设触发用的是同一个 secret 值，新场景的接口里也只有掩码", async () => {
			const { id } = await sceneWithSecretPreset();
			const res = await api.post(`/orchestrations/${id}/copy`, { name: "副本" }, "小明");
			expect(res.status, await res.clone().text()).toBe(201);
			const copyId = ((await res.json()) as { id: string }).id;

			const list = await api.get(`/orchestrations/${copyId}/presets`);
			expect(await list.text()).not.toContain(SECRET);
			const [copied] = await listPresets(api, copyId);
			expect(copied?.params[1]).toEqual({ name: "token", secret: true, value: MASK });
			expect(await inputsOf(copyId, copied?.id ?? "")).toMatchObject({
				host: "a.example",
				token: SECRET,
			});
		});
	});

	describe("任务日志", () => {
		it("按预设触发时，节点打印出的 secret 值在任务日志里是掩码，日志文件里也没有明文", async () => {
			const { id, preset } = await sceneWithSecretPreset();
			const res = await triggerWithPreset(api, id, preset.id, {});
			expect(res.status, await res.clone().text()).toBe(201);
			const agent = await agentA();
			const task = await agent.nextAssign();
			agent.logs(task, [
				[1, `login with ${SECRET} ok`],
				[2, "host a.example"],
			]);

			await eventually(async () => {
				const { lines } = await api.getJson<{ lines: Array<{ text: string }> }>(
					`/tasks/${task.taskId}/logs`,
				);
				expect(lines.map((l) => l.text)).toEqual([`login with ${MASK} ok`, "host a.example"]);
			});
			const download = await cp.fetch(`/tasks/${task.taskId}/logs/download`);
			expect(await download.text()).not.toContain(SECRET);
		});
	});
});
