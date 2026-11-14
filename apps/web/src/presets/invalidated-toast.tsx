import { type DocumentWarningView, PRESET_INVALIDATED_WARNING } from "@sfly/schema";
import { notify } from "#/components/feedback/notify";

/** 保存或恢复出新版本的警告里，会让运行预设失效的（`preset_invalidated`）和其他警告分开。 */
export function splitPresetWarnings(warnings: DocumentWarningView[]) {
	return {
		presets: warnings.filter((w) => w.code === PRESET_INVALIDATED_WARNING),
		rest: warnings.filter((w) => w.code !== PRESET_INVALIDATED_WARNING),
	};
}

/**
 * 新版本让一些运行预设失效了（GLOSSARY「失效的运行预设」）：列出这些预设和原因。只是提示，版本已经保存。
 * 它们不是「触发运行前需要处理」的警告，所以不和其他警告一起计数。
 */
export function notifyInvalidatedPresets(warnings: DocumentWarningView[]) {
	if (warnings.length === 0) return;
	notify.warning(`${warnings.length} 个运行预设已失效`, {
		description: (
			<ul className="m-0 flex list-none flex-col gap-1 p-0">
				{warnings.map((w) => (
					<li key={w.message}>{w.message}</li>
				))}
			</ul>
		),
		duration: 10_000,
	});
}
