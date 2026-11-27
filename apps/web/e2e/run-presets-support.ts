import type { PresetView } from "@sfly/schema";
import { actAs } from "../../server/test/support/credentials.js";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";

/** 运行预设端到端测试共用：通过 HTTP API 准备预设（根路径 API，与 CLI 一样不经过 /api 前缀）。 */

/** 新建运行预设并返回它的 ID；`nickname` 是最后修改人。 */
export async function createRunPreset(
	cp: TestControlPlane,
	scenarioId: string,
	body: { name: string; description?: string; params: Array<{ name: string; value: unknown }> },
	nickname = "tester",
): Promise<string> {
	const res = await cp.fetch(`/orchestrations/${scenarioId}/presets`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...actAs(nickname),
		},
		body: JSON.stringify(body),
	});
	if (res.status !== 201) {
		throw new Error(`新建运行预设：HTTP ${res.status} ${await res.text()}`);
	}
	return ((await res.json()) as { id: string }).id;
}

/** 场景当前的运行预设（按名称排序）。 */
export async function listRunPresets(
	cp: TestControlPlane,
	scenarioId: string,
): Promise<PresetView[]> {
	const res = await cp.fetch(`/orchestrations/${scenarioId}/presets`);
	return ((await res.json()) as { presets: PresetView[] }).presets;
}

/** 修改运行预设（只改给出的字段；`params` 是预设参数的完整清单）。 */
export async function updateRunPreset(
	cp: TestControlPlane,
	scenarioId: string,
	presetId: string,
	changes: { name?: string; params?: Array<{ name: string; value: unknown }> },
): Promise<void> {
	const res = await cp.fetch(`/orchestrations/${scenarioId}/presets/${presetId}`, {
		method: "PATCH",
		headers: {
			"content-type": "application/json",
			...actAs("tester"),
		},
		body: JSON.stringify(changes),
	});
	if (res.status !== 200) throw new Error(`修改运行预设：HTTP ${res.status} ${await res.text()}`);
}

/** 删除运行预设。 */
export async function deleteRunPreset(
	cp: TestControlPlane,
	scenarioId: string,
	presetId: string,
): Promise<void> {
	const res = await cp.fetch(`/orchestrations/${scenarioId}/presets/${presetId}`, {
		method: "DELETE",
		headers: { ...actAs("tester") },
	});
	if (res.status !== 204) throw new Error(`删除运行预设：HTTP ${res.status} ${await res.text()}`);
}

/** 另存一个场景版本（编辑起点是第 1 版）。 */
export async function saveScenarioVersion(
	cp: TestControlPlane,
	scenarioId: string,
	document: unknown,
): Promise<void> {
	const res = await cp.fetch(`/orchestrations/${scenarioId}/versions`, {
		method: "POST",
		headers: { "content-type": "application/json", ...actAs("tester") },
		body: JSON.stringify({ base_version: 1, document }),
	});
	if (res.status !== 201) throw new Error(`保存场景版本：HTTP ${res.status} ${await res.text()}`);
}
