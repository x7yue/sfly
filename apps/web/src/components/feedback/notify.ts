import { type ExternalToast, toast } from "sonner";

/**
 * 操作结果通知（原型 toast）：成功、警告、失败三种，另有中性的 info。
 * 页面里一律用它，不直接调用 sonner，保证文案与时长一致；通知容器由根路由挂载一次。
 *
 *   notify.success("已保存第 3 版");
 *   notify.error("保存失败", { description: error.message });
 *   notify.success("已归档「压测」", { action: { label: "撤销", onClick: restore } });
 *
 * 通知只回执刚做完的操作，信息在别处也看得到（docs/DESIGN-SYSTEM.md「通知与横幅」）：
 * 页面状态里需要立刻注意的（运行失败、连接断开）用 `Banner`；弹窗里的错误写在弹窗里，不发通知。
 *
 * 带操作（「撤销」）的通知和失败的通知不自动消失，有关闭按钮：键盘用户用 Alt+T 跳过去也来得及。
 */
const DURATION = 2600;

const persistent = { duration: Number.POSITIVE_INFINITY, closeButton: true } as const;

/** 调用方给的时长对带操作的通知无效：它们一律等用户关闭。 */
const withDefaults = (duration: number, options?: ExternalToast): ExternalToast => ({
	duration,
	...options,
	...(options?.action ? persistent : {}),
});

export const notify = {
	success: (message: string, options?: ExternalToast) =>
		toast.success(message, withDefaults(DURATION, options)),
	info: (message: string, options?: ExternalToast) =>
		toast.info(message, withDefaults(DURATION, options)),
	warning: (message: string, options?: ExternalToast) =>
		toast.warning(message, withDefaults(DURATION * 2, options)),
	error: (message: string, options?: ExternalToast) =>
		toast.error(message, { ...persistent, ...options }),
};
