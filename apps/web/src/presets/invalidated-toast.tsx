import {
	type DocumentWarningView,
	PRESET_INVALIDATED_WARNING,
	SECRET_PARAM_DEFAULT_WARNING,
} from "@sfly/schema";
import { notify } from "#/components/feedback/notify";

/**
 * 保存或恢复出新版本的警告里，会让运行预设失效的（`preset_invalidated`）、secret 参数写了默认值的提醒
 * （`secret_param_default`）和其他警告分开：前两种不是「触发运行前需要处理」的警告，各有一条提示，不和其他警告一起计数。
 */
export function splitPresetWarnings(warnings: DocumentWarningView[]) {
	const isPreset = (w: DocumentWarningView) => w.code === PRESET_INVALIDATED_WARNING;
	const isSecretDefault = (w: DocumentWarningView) => w.code === SECRET_PARAM_DEFAULT_WARNING;
	return {
		presets: warnings.filter(isPreset),
		secretDefaults: warnings.filter(isSecretDefault),
		rest: warnings.filter((w) => !isPreset(w) && !isSecretDefault(w)),
	};
}

/** secret 参数写了默认值：版本不可修改，默认值会留在这个版本里。只是提示，版本已经保存。 */
export function notifySecretDefaults(warnings: DocumentWarningView[]) {
	if (warnings.length === 0) return;
	notify.warning(`${warnings.length} 个 secret 参数写了默认值`, {
		description: (
			<ul className="m-0 flex list-none flex-col gap-1 p-0">
				{warnings.map((w) => (
					<li key={w.message}>{w.message}</li>
				))}
			</ul>
		),
	});
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
	});
}
