/** 监控页顶栏的高度（px）：底部面板按「窗口减去顶栏」的高度取默认高度（BottomPanel.tsx）。 */
export const MONITOR_TOPBAR_HEIGHT = 52;

/**
 * 监控页顶栏的按钮在窗口窄于 1280 时只显示图标（DESIGN-SYSTEM §1：监控页窄到 1024 仍可用）：
 * 按钮本身收成方形，文字留给读屏（按钮的名称不变）。
 */
export const COLLAPSE_BUTTON = "max-xl:w-7.5 max-xl:px-0";
export const COLLAPSE_LABEL = "max-xl:sr-only";
