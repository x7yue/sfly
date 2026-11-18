import {
	CircleCheckIcon,
	InfoIcon,
	Loader2Icon,
	OctagonXIcon,
	TriangleAlertIcon,
} from "lucide-react";
import type * as React from "react";
import { useEffect } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/** sonner 的通知列表（`<ol>`），Alt+T 把焦点移到它上面。 */
const TOASTER = "[data-sonner-toaster]";

/**
 * sonner 在 Alt+T 把焦点移进通知区域时记下原来的元素，焦点离开通知区域（blur）时还回去，通知区域卸载时也还一次。
 * 问题出在焦点所在的通知被移走的时候（点了「撤销」、通知消失）：sonner 收不到这次失焦（浏览器补发的 focusout 在节点被移走的过程中，到不了它的 onBlur），一直以为焦点还在里面，
 * 几秒后最后一条通知消失、通知区域卸载，它才把焦点抢回记下的元素——这时用户可能已经在弹窗或别的输入里，
 * 紧跟着的 Enter 就落在被抢到焦点的链接上。这里在焦点随通知消失的那一刻就让 sonner 收到一次 blur：焦点当场还回去，记录也清掉。
 */
function useReleaseFocusWithToast() {
	useEffect(() => {
		let inside = false;
		const within = (element: Element | null) => element?.closest(TOASTER) != null;
		const onFocusIn = (event: FocusEvent) => {
			inside = within(event.target as Element | null);
		};
		const observer = new MutationObserver(() => {
			if (!inside) return;
			if (document.activeElement !== document.body) {
				// 焦点已经在别处（通知区域卸载时 sonner 自己还回去了）。
				inside = within(document.activeElement);
				return;
			}
			inside = false;
			const list = document.querySelector<HTMLElement>(TOASTER);
			list?.focus({ preventScroll: true });
			list?.blur();
		});
		document.addEventListener("focusin", onFocusIn);
		observer.observe(document.body, { childList: true, subtree: true });
		return () => {
			document.removeEventListener("focusin", onFocusIn);
			observer.disconnect();
		};
	}, []);
}

/**
 * 通知容器（sonner）。只做深色主题，挂在应用根部一次（GlobalOverlays）；
 * 发通知用 `#/components/feedback/notify`，不直接调用 sonner。
 *
 * 位置在右下角：全屏页（画布、运行监控）的顶栏中间放的是运行状态与失败摘要，通知不能压在上面；
 * 右侧抽屉打开时在左下角。
 * Alt+T 把焦点移到通知区域（sonner 自带），带「撤销」的通知用键盘也点得到。
 */
const Toaster = ({ ...props }: ToasterProps) => {
	useReleaseFocusWithToast();
	return (
		<Sonner
			theme="dark"
			position="bottom-right"
			customAriaLabel="通知（Alt+T 跳到这里）"
			// 右侧抽屉（运行抽屉）打开时通知挪到左下角，不盖住抽屉底部的按钮。
			className="toaster group [body:has([data-slot=sheet-content][data-side=right])_&]:right-auto [body:has([data-slot=sheet-content][data-side=right])_&]:left-6"
			icons={{
				success: <CircleCheckIcon className="size-4 text-ok" />,
				info: <InfoIcon className="size-4 text-fg-2" />,
				warning: <TriangleAlertIcon className="size-4 text-warn-fg" />,
				error: <OctagonXIcon className="size-4 text-danger-fg" />,
				loading: <Loader2Icon className="size-4 animate-spin text-fg-2" />,
			}}
			style={
				{
					"--normal-bg": "var(--raised-2)",
					"--normal-text": "var(--fg-1)",
					"--normal-border": "var(--border-strong)",
					"--border-radius": "var(--radius)",
				} as React.CSSProperties
			}
			toastOptions={{
				closeButtonAriaLabel: "关闭通知",
				classNames: {
					// 进出场与其他浮层同一档节奏（sonner 默认 400ms 还过渡高度，堆叠变化时逐帧重排）；高度变化瞬时完成。
					toast:
						"font-sans! text-sm! shadow-pop! transition-[transform,opacity,box-shadow]! duration-(--motion-slow)! ease-out!",
					description: "text-xs! text-fg-2!",
					// 透明底加描边：raised 底的按钮比 raised-2 的通知还暗，看起来像凹进去的。
					actionButton: "bg-transparent! text-fg-1! border! border-border-strong! hover:bg-fg-1/8!",
					// 第二个按钮（「保留」这类不改东西的选择）：不描边，退后一档。
					cancelButton: "bg-transparent! text-fg-2! hover:text-fg-1! hover:bg-fg-1/8!",
					closeButton: "bg-raised-2! border-border-strong! text-fg-2! hover:text-fg-1!",
				},
			}}
			{...props}
		/>
	);
};

export { Toaster };
