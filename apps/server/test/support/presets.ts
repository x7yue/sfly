// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { type PresetView, presetsApi } from "@sfly/schema";
import { expect } from "vitest";
import type { ApiClient } from "./api-client.js";

/** 运行预设测试用的入口参数：必填字符串、有默认值的数字和布尔、json、secret 字符串。 */
export const PRESET_PARAMS: Array<Record<string, unknown>> = [
	{ name: "host", type: "string", required: true },
	{ name: "port", type: "number", default: 80 },
	{ name: "verbose", type: "boolean", default: false },
	{ name: "options", type: "json" },
	{ name: "token", type: "string", secret: true },
];

/**
 * 入口节点（声明 params）+ 一个把入口参数都传下去的包节点（`stub` 包的 `echo`，用 `publishPackage(cp, "stub", "1.0.0", { echo: [...] })` 发布）。
 */
export function presetScenario(params: Array<Record<string, unknown>> = PRESET_PARAMS) {
	return {
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry", params },
			{
				id: "a",
				kind: "package",
				package: "stub",
				node: "echo",
				inputs: Object.fromEntries(params.map((p) => [p.name, `\${{ params.${p.name} }}`])),
			},
		],
		edges: [{ from: "entry", to: "a", kind: "chain" }],
		packages: { stub: "1.0.0" },
	};
}

/** 新建运行预设的请求体（presetsApi.create）；`params` 里的 value 可以省略，用来测缺值。 */
export interface PresetBody {
	name: string;
	description?: string;
	params: Array<{ name: string; value?: unknown }>;
}

/** 新建运行预设。 */
export function createPreset(
	api: ApiClient,
	orchestrationId: string,
	body: PresetBody,
	nickname = "tester",
): Promise<Response> {
	return api.post(`/orchestrations/${orchestrationId}/presets`, body, nickname);
}

/** 新建运行预设并断言成功，返回预设视图（按 HTTP 契约解析）。 */
export async function createPresetOk(
	api: ApiClient,
	orchestrationId: string,
	body: PresetBody,
	nickname = "tester",
): Promise<PresetView> {
	const res = await createPreset(api, orchestrationId, body, nickname);
	expect(res.status, await res.clone().text()).toBe(201);
	return presetsApi.create.response.parse(await res.json());
}

/** 修改运行预设的请求体（presetsApi.update）。 */
export interface PresetChanges {
	name?: string;
	description?: string;
	params?: Array<{ name: string; value?: unknown }>;
}

/** 修改运行预设。 */
export function updatePreset(
	api: ApiClient,
	orchestrationId: string,
	presetId: string,
	body: PresetChanges,
	nickname = "tester",
): Promise<Response> {
	return api.patch(`/orchestrations/${orchestrationId}/presets/${presetId}`, body, nickname);
}

/** 修改运行预设并断言成功，返回预设视图（按 HTTP 契约解析）。 */
export async function updatePresetOk(
	api: ApiClient,
	orchestrationId: string,
	presetId: string,
	body: PresetChanges,
	nickname = "tester",
): Promise<PresetView> {
	const res = await updatePreset(api, orchestrationId, presetId, body, nickname);
	expect(res.status, await res.clone().text()).toBe(200);
	return presetsApi.update.response.parse(await res.json());
}

/** 复制运行预设，`name` 是新预设的名称。 */
export function copyPreset(
	api: ApiClient,
	orchestrationId: string,
	presetId: string,
	name: string,
	nickname = "tester",
): Promise<Response> {
	return api.post(
		`/orchestrations/${orchestrationId}/presets/${presetId}/copy`,
		{ name },
		nickname,
	);
}

/** 复制运行预设并断言成功，返回新预设的视图（按 HTTP 契约解析）。 */
export async function copyPresetOk(
	api: ApiClient,
	orchestrationId: string,
	presetId: string,
	name: string,
	nickname = "tester",
): Promise<PresetView> {
	const res = await copyPreset(api, orchestrationId, presetId, name, nickname);
	expect(res.status, await res.clone().text()).toBe(201);
	return presetsApi.copy.response.parse(await res.json());
}

/** 删除运行预设。 */
export function deletePreset(
	api: ApiClient,
	orchestrationId: string,
	presetId: string,
	nickname = "tester",
): Promise<Response> {
	return api.delete(`/orchestrations/${orchestrationId}/presets/${presetId}`, nickname);
}

/** 场景的运行预设列表（按 HTTP 契约解析）。 */
export async function listPresets(api: ApiClient, orchestrationId: string): Promise<PresetView[]> {
	const body = await api.getJson(`/orchestrations/${orchestrationId}/presets`);
	return presetsApi.list.response.parse(body).presets;
}

/** 按运行预设触发场景的最新版本。 */
export function triggerWithPreset(
	api: ApiClient,
	orchestrationId: string,
	preset: string,
	params: Record<string, unknown> = {},
	nickname = "tester",
): Promise<Response> {
	return api.post(`/orchestrations/${orchestrationId}/runs`, { params, preset }, nickname);
}

/** 错误响应的 code 与 details。 */
export async function errorOf(res: Response): Promise<{ code: string; details?: unknown }> {
	return ((await res.json()) as { error: { code: string; details?: unknown } }).error;
}

/** `invalid_preset` 的 details（zod 格式的问题清单）里每一项指向的字段，如 `body.params.0.value`。 */
export async function invalidPresetFields(res: Response): Promise<string[]> {
	expect(res.status, await res.clone().text()).toBe(400);
	const error = await errorOf(res);
	expect(error.code).toBe("invalid_preset");
	return (error.details as Array<{ path: Array<string | number> }>).map((i) => i.path.join("."));
}
