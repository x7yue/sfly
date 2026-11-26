import { createElement, type ReactNode } from "react";
import { type ExternalToast, toast } from "sonner";
import { UntrustedText } from "#/components/untrusted-text";

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

/** 对外的选项不含 `duration`：时长由通知的种类决定，带操作的通知一律等用户关闭。 */
export type NotifyOptions = Omit<ExternalToast, "duration">;

/**
 * 通知里的文字（标题、说明）一律经 `UntrustedText`（#699）：说明常是 `error.message`，里面可能有 Agent 报的原文（名称、原因），
 * 控制字符不能在读屏立刻读出来的通知里生效。普通的文字不包一层，和原来一样是文字节点。
 */
const shown = (text: ReactNode): ReactNode =>
	typeof text === "string" ? createElement(UntrustedText, { text, mode: "text" }) : text;

const prepare = (options?: NotifyOptions): NotifyOptions | undefined =>
	options?.description === undefined
		? options
		: { ...options, description: shown(options.description as ReactNode) };

const withDefaults = (duration: number, options?: NotifyOptions): ExternalToast => ({
	...prepare(options),
	duration,
	...(options?.action ? persistent : {}),
});

export const notify = {
	success: (message: string, options?: NotifyOptions) =>
		toast.success(shown(message), withDefaults(DURATION, options)),
	info: (message: string, options?: NotifyOptions) =>
		toast.info(shown(message), withDefaults(DURATION, options)),
	warning: (message: string, options?: NotifyOptions) =>
		toast.warning(shown(message), withDefaults(DURATION * 2, options)),
	error: (message: string, options?: NotifyOptions) =>
		toast.error(shown(message), { ...prepare(options), ...persistent }),
	/** 收起一条通知（它说的操作已经过时，例如「还原」之后又做了别的修改）。 */
	dismiss: (id: string | number) => toast.dismiss(id),
};
