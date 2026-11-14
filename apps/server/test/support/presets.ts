import { type PresetView, presetsApi } from "@sfly/schema";
import { expect } from "vitest";
import type { ApiClient } from "./api-client.js";

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
