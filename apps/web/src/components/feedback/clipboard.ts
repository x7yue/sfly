import { MESSAGE } from "#/lib/copy";
import { notify } from "./notify";

/**
 * 把文字写进剪贴板（按钮、菜单项这类不是按键触发的复制）：写入后调用 `done`。
 *
 * 控制面在内网用 http 访问，那里没有 Clipboard API（只在 https 与 localhost 上有）。没有它或写入被拒绝时，
 * 改用浏览器的复制命令：这一步必须还在这次点击的用户激活里，所以在点击处理函数里同步调用本函数。
 * 两条路都失败才提示「复制失败」，`hint` 写明还能怎么复制。
 */
export function writeClipboard(text: string, done: () => void, hint?: string) {
	const failed = () =>
		notify.error(MESSAGE.copyFailed, {
			description: hint ? `${MESSAGE.clipboardDenied}，${hint}` : MESSAGE.clipboardDenied,
		});
	const fallback = () => (copyByCommand(text) ? done() : failed());
	if (!navigator.clipboard) {
		fallback();
		return;
	}
	navigator.clipboard.writeText(text).then(done, fallback);
}

/**
 * `document.execCommand("copy")` 会触发一次 copy 事件，在事件里放进要复制的文字。不用临时的 textarea 选中文字：
 * 那会抢走焦点，弹窗的焦点锁会把焦点拉回去，选区跟着丢。
 * 监听挂在 window 的捕获阶段并停止传播，画布自己的 copy 处理（复制节点）不会接到这次事件。
 */
function copyByCommand(text: string): boolean {
	let written = false;
	const put = (event: ClipboardEvent) => {
		if (!event.clipboardData) return;
		event.clipboardData.setData("text/plain", text);
		event.preventDefault();
		event.stopImmediatePropagation();
		written = true;
	};
	window.addEventListener("copy", put, { capture: true });
	try {
		return document.execCommand("copy") && written;
	} catch {
		return false;
	} finally {
		window.removeEventListener("copy", put, { capture: true });
	}
}
