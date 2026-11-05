import { type ExternalToast, toast } from "sonner";

/**
 * 操作结果通知（原型 toast）：成功、警告、失败三种，另有中性的 info。
 * 页面里一律用它，不直接调用 sonner，保证文案与时长一致；通知容器由根路由挂载一次。
 *
 *   notify.success("已保存第 3 版");
 *   notify.error("保存失败", { description: error.message });
 */
const DURATION = 2600;

export const notify = {
	success: (message: string, options?: ExternalToast) =>
		toast.success(message, { duration: DURATION, ...options }),
	info: (message: string, options?: ExternalToast) =>
		toast.info(message, { duration: DURATION, ...options }),
	warning: (message: string, options?: ExternalToast) =>
		toast.warning(message, { duration: DURATION * 2, ...options }),
	/** 失败的通知不自动消失，需要手动关闭。 */
	error: (message: string, options?: ExternalToast) =>
		toast.error(message, { duration: Number.POSITIVE_INFINITY, closeButton: true, ...options }),
};
