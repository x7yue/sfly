/**
 * 画布内文字的字号（语义缩放）：画布容器上有 `--canvas-zoom`（当前缩放比例）和 `data-lod`
 * （低于 LOD_THRESHOLD 时为 true）。字号取 max(原字号, 屏幕最小字号 ÷ 缩放比例)，
 * 缩小视图时文字在世界坐标里放大，屏幕上始终不小于 11px（geometry.ts 的 MIN_SCREEN_TEXT）。
 *
 * Tailwind 只能识别源码里完整写出的类名，所以这里逐个写死。
 */
export const ZOOM_TEXT_11 = "text-[length:max(11px,calc(11px/var(--canvas-zoom)))]";
export const ZOOM_TEXT_12 = "text-[length:max(12px,calc(11px/var(--canvas-zoom)))]";
/** 卡片标题：语义缩放时在屏幕上约 12px。 */
export const ZOOM_TEXT_TITLE = "text-[length:max(13px,calc(12px/var(--canvas-zoom)))]";
/** 语义缩放时隐藏的细节（摘要槽、标签、种类名）。 */
export const LOD_HIDDEN = "in-data-[lod=true]:hidden";
/**
 * 节点种类图标的方块：方块与图标按所在文字的字号（em）取尺寸。卡片头部随语义缩放一起放大，缩小视图时
 * 仍能分辨种类，也不会撑高头部；添加节点菜单里放在 11px 文字中（约 18px）。
 */
export const KIND_CHIP =
	"grid size-[1.6em] flex-none place-items-center rounded-sm bg-raised-2 text-fg-2 [&_svg]:size-[1.05em]";
