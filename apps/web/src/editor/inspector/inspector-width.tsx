import { INSPECTOR_CANVAS_RESERVE } from "#/components/canvas/geometry";
import { PanelWidthHandle } from "#/components/PanelWidthHandle";
import { ACTION } from "#/lib/copy";
import { INSPECTOR_MIN_WIDTH, usePanelWidth } from "#/lib/panel-width";

/**
 * 检查器当前的宽度。上限同时要给画布的工具条和小地图留位置（geometry.ts 的 INSPECTOR_CANVAS_RESERVE），
 * 拖得再宽也不会把画布挤到放不下它们。编辑与运行状态两种检查器共用。
 */
export const useInspectorWidth = () => usePanelWidth(INSPECTOR_MIN_WIDTH, INSPECTOR_CANVAS_RESERVE);

export const InspectorWidthHandle = () => (
	<PanelWidthHandle label={ACTION.resizeInspector} reserve={INSPECTOR_CANVAS_RESERVE} />
);
