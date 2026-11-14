import type { PresetView } from "@sfly/schema";
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
			"x-sfly-nickname": encodeURIComponent(nickname),
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
