import type { RunListPreset, RunPresetView } from "@sfly/schema";
import type { runs } from "../db/schema.js";

/** 运行上记下的预设（触发时的情况，预设之后改名、删除都不变）。 */
type RunPresetColumns = Pick<typeof runs.$inferSelect, "presetId" | "presetName" | "presetParams">;

/** 运行详情里的 `preset`；没有用预设时为 null。运行详情和运行列表都从运行上记下的列取，不再回头读预设表。 */
export function runPresetView(run: RunPresetColumns): RunPresetView | null {
	if (run.presetId === null) return null;
	return { id: run.presetId, name: run.presetName ?? "", params: run.presetParams ?? [] };
}

/** 运行列表里的 `preset`：只有 ID 和触发时的名称。 */
export function runListPreset(run: RunPresetColumns): RunListPreset | null {
	const preset = runPresetView(run);
	return preset && { id: preset.id, name: preset.name };
}
