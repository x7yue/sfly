import type { ParamDeclView, PresetView, RunView } from "@sfly/schema";
import { defaultFieldValue, type FormValues } from "#/run-drawer/trigger-form";

/**
 * 运行抽屉里运行预设的选用（纯逻辑，有单测）：能不能选（{@link usablePreset}）、打开抽屉时默认选哪个
 * （{@link initialPresetId}）、换预设时表单里的字段怎么变（{@link switchPreset}）。
 * 入口参数自己的换算与校验在 run-drawer/trigger-form.ts。
 */

/** 「再次运行」的来源：上一次运行用的参数和预设（RunView 里的这两项）。 */
export type RerunSource = Pick<RunView, "params" | "preset">;

/** 能用来触发的预设：在预设清单里，并且没有失效（GLOSSARY「失效的运行预设」）。 */
export function usablePreset(
	presets: readonly PresetView[],
	id: string | null,
): PresetView | undefined {
	return presets.find((p) => p.id === id && p.status === "ok");
}

/**
 * 打开抽屉时默认选中哪个预设，选不了（已被删除、已失效或者没有）时是 null（不使用预设）。
 * 直接运行时想选的是浏览器里记住的最近一次用的预设；「再次运行」时是上一次运行用的预设（按 ID 对上，不按名称），
 * 上一次没用预设就是不使用预设，不看记住的预设：记住的是别的运行用的。
 * 「默认选哪个预设」只在这里决定，别处不再各写一遍。
 */
export function initialPresetId(
	presets: readonly PresetView[],
	remembered: string | null,
	rerunOf?: RerunSource,
): string | null {
	const wanted = rerunOf ? (rerunOf.preset?.id ?? null) : remembered;
	return usablePreset(presets, wanted)?.id ?? null;
}

/**
 * 换预设（`from` 是原来选中的预设固定的参数名，`to` 是现在的；不使用预设就是空）时表单里的字段：
 * 换预设前后都能编辑的字段保留已经填的值，其余回到参数的默认值：原来锁定、现在解锁的字段是默认值，
 * 现在锁定的字段表单里本来就用不上，也放回默认值。所以换过预设以后锁定的字段在表单里是默认值，
 * 预设之后消失也不会露出以前填的值（「再次运行」打开时就选中的预设除外：它固定的字段先带着上次运行的值，
 * 预设之后消失露出的就是它，和重新打开抽屉一样）；secret 参数锁定的值是接口返回的打码值，从来不会进表单，解锁后也是默认值。
 */
export function switchPreset(
	decls: ParamDeclView[],
	values: FormValues,
	from: { has(name: string): boolean },
	to: { has(name: string): boolean },
): FormValues {
	return Object.fromEntries(
		decls.map((p) => [
			p.name,
			from.has(p.name) || to.has(p.name)
				? defaultFieldValue(p)
				: (values[p.name] ?? defaultFieldValue(p)),
		]),
	);
}
