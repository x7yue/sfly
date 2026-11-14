/**
 * 每个场景最近一次用的运行预设，记在这个浏览器的 localStorage 里（按场景 ID），下次打开运行抽屉时默认选中它。
 * 只记触发时真正用过的预设：选了没触发不算，不使用预设触发也不会清掉它。
 * 预设之后被删除、失效时这里的记录不用清：打开抽屉时由 `initialPresetId`（presets/preset-selection.ts）判断还能不能选。
 */
const key = (orchestrationId: string) => `sfly.run-preset.${orchestrationId}`;

export function readLastPreset(orchestrationId: string): string | null {
	return window.localStorage.getItem(key(orchestrationId));
}

export function rememberPreset(orchestrationId: string, presetId: string): void {
	window.localStorage.setItem(key(orchestrationId), presetId);
}
