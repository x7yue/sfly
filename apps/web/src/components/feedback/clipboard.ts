import { MESSAGE } from "#/lib/copy";
import { notify } from "./notify";

/**
 * 用 Clipboard API 把文字写进剪贴板（按钮、菜单项这类不是按键触发的复制）：写入后调用 `done`；
 * 浏览器不允许访问剪贴板（拒绝授权、http 下没有 Clipboard API）时提示「复制失败」，`hint` 写明还能怎么复制。
 */
export function writeClipboard(text: string, done: () => void, hint?: string) {
	const failed = () =>
		notify.error(MESSAGE.copyFailed, {
			description: hint ? `${MESSAGE.clipboardDenied}，${hint}` : MESSAGE.clipboardDenied,
		});
	if (!navigator.clipboard) {
		failed();
		return;
	}
	void navigator.clipboard.writeText(text).then(done).catch(failed);
}
