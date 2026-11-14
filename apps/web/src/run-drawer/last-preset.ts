/**
 * 每个场景最近一次触发时的运行预设选择，记在这个浏览器的 localStorage 里（按场景 ID），下次打开运行抽屉时默认照它选：
 * 用了某个预设就记下它，不使用预设触发就清掉，下次打开是「不使用预设」。只看触发成功的那一次：选了没触发不算。
 * 预设之后被删除、失效时这里的记录不用清：打开抽屉时由 `initialPresetId`（presets/preset-selection.ts）判断还能不能选。
 */
const key = (orchestrationId: string) => `sfly.run-preset.${orchestrationId}`;

export function readLastPreset(orchestrationId: string): string | null {
	return window.localStorage.getItem(key(orchestrationId));
}

/** 记下这一次触发的选择；`presetId` 为 null 是没有使用预设。 */
export function rememberPreset(orchestrationId: string, presetId: string | null): void {
	if (presetId === null) window.localStorage.removeItem(key(orchestrationId));
	else window.localStorage.setItem(key(orchestrationId), presetId);
}
