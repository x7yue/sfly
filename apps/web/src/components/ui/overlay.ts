/**
 * 浮层（弹窗、菜单、弹出层、提示）共用的外观与进出场（docs/DESIGN-SYSTEM.md「动效」）。
 *
 * 进出场用 Base UI 的 `data-starting-style` / `data-ending-style` 加 CSS 过渡，不用关键帧：过渡可以中途反向，
 * 刚打开就关闭时从当前的透明度退回去，不会先跳到完全显示再淡出。缩放只在不减少动效时加。
 */
export const POPUP_MOTION =
	"transition-[opacity,scale] duration-(--motion-base) ease-out data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-(--motion-fast) data-ending-style:ease-in motion-safe:data-starting-style:scale-96 motion-safe:data-ending-style:scale-96";

/** 遮罩：只淡入淡出。 */
export const BACKDROP_MOTION =
	"transition-opacity duration-(--motion-base) ease-out data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-(--motion-fast) data-ending-style:ease-in";

/** 菜单、弹出层的面板：raised 底、border-strong 描边（所有浮层同一档描边）。 */
export const MENU_SURFACE =
	"rounded-lg border border-border-strong bg-raised text-fg-1 shadow-pop outline-none";
