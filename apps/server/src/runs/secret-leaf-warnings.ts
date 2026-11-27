import { MIN_LEAF_CHARS, shortLeafCount } from "../logs/secrets.js";
import type { PreflightProblem } from "./preflight.js";
import type { RawScenario } from "./raw-scenario.js";

/**
 * 预检的警告：值是对象或数组的 secret 参数，里面有太短的字符串或数字叶子（不到 {@link MIN_LEAF_CHARS} 个字符）。
 * 它们单独出现在日志、输出里时不会被打码（#479 的决定：短叶子多是配置里的标签和开关，按子串打码会把日志换得没法读），
 * 整个对象被原样写出时才会随整段一起盖住。要打码的短值应该单独做成一个 secret 参数。
 *
 * 看的是预检时已经知道的值：场景最新版本里 secret 参数的默认值，和运行预设里 secret 参数的值（原值，只在这里读，
 * 响应里只有个数，不写出值）。触发请求里临时给的值预检时还不知道，不在这里。
 * 读原始文档和预设值（{@link RawScenario}，路由读一次传进来），不经过打码的读取函数。
 */
export function secretLeafWarnings({ document, presets }: RawScenario): PreflightProblem[] {
	const warnings: PreflightProblem[] = [];
	const mainSecrets = new Set<string>();
	for (const node of document.nodes) {
		if (node.kind !== "entry" && node.kind !== "subflow_entry") continue;
		for (const param of node.params) {
			if (!param.secret) continue;
			if (node.kind === "entry") mainSecrets.add(param.name);
			const count = shortLeafCount(param.default);
			if (count > 0) {
				warnings.push({
					code: "secret_short_leaf",
					node_id: node.id,
					message: `参数 ${param.name}（${node.kind === "entry" ? "入口节点" : "子流程入口节点"} ${node.id}）是值为对象的 secret 参数，默认值里有 ${count} 个短于 ${MIN_LEAF_CHARS} 个字符的字符串或数字：${HOW}`,
				});
			}
		}
	}
	for (const preset of presets) {
		for (const [name, value] of Object.entries(preset.values)) {
			const count = mainSecrets.has(name) ? shortLeafCount(value) : 0;
			if (count > 0) {
				warnings.push({
					code: "secret_short_leaf",
					message: `运行预设「${preset.name}」里 secret 参数 ${name} 的值有 ${count} 个短于 ${MIN_LEAF_CHARS} 个字符的字符串或数字：${HOW}`,
				});
			}
		}
	}
	return warnings;
}

const HOW =
	"它们单独出现在日志、输出里时不会被打码（整个对象被原样写出时才会）；要打码的短值请单独做成一个 secret 参数";
