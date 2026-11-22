// 例外：评测集臂 B 的原型扩展要装进 pi 里，只能引用 pi（删除臂 B 时，#552，连同规则里的这条例外一起删）。
import {
	type ExtensionAPI,
	registerTool,
} from "@earendil-works/pi-coding-agent";

export function install(api: ExtensionAPI): void {
	registerTool(api);
}
