// 评测集臂 B 的原型扩展以前是例外，#552 删掉了：评测集里引用 pi 也拦。
// @hit
import { type ExtensionAPI, registerTool } from "@earendil-works/pi-coding-agent";

export function install(api: ExtensionAPI): void {
	registerTool(api);
}
