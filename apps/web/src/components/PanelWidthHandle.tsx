import {
	INSPECTOR_MIN_WIDTH,
	maxPanelWidth,
	setPanelWidth,
	usePanelWidth,
} from "#/lib/panel-width";
import { ResizeHandle } from "./ResizeHandle";

/**
 * 右侧面板（检查器、运行抽屉）左边缘的调宽拖动条：宽度所有场景、两种面板共用（见 `panel-width.ts`）。
 * 放在面板里（面板要是定位元素），面板自己用 `usePanelWidth(min)` 取宽度。
 */
export function PanelWidthHandle({
	label,
	min = INSPECTOR_MIN_WIDTH,
}: {
	label: string;
	min?: number;
}) {
	const width = usePanelWidth(min);
	return (
		<ResizeHandle
			label={label}
			edge="left"
			size={width}
			measure={() => width}
			min={min}
			max={() => Math.max(min, maxPanelWidth(window.innerWidth))}
			onResize={setPanelWidth}
			onReset={() => setPanelWidth(null)}
		/>
	);
}
