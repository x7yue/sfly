import type { NodeTypeMetadata, StoredOrchestrationDocument } from "@sfly/schema";
import { inputsOfType, isInputOfType, namesInInputs } from "./input-types.js";
import { nodeNameWithId } from "./node-display.js";
import { nodeTypeOf, type PackageCatalog, referencesIn } from "./references.js";

/**
 * 飞书机器人（ADR 0020）的静态检查：节点选的机器人必须已登记。
 *
 * 「飞书机器人」类型的输入（节点开发者用 `sfly.FeishuBot` 标注的参数）按名称引用机器人：
 * `sfly build` 在输入 schema 里标记它 `{"type": "string", "x-sfly-type": "feishu_bot"}`，
 * 可选参数（`FeishuBot | None`）是 anyOf 里的一项。常量不是已登记的机器人：保存时警告，触发时阻断
 * （{@link feishuBotInputWarnings}）；引用入口参数的在触发时按实际值检查（控制面）；
 * 登记情况来自控制面的机器人列表，不知道时（例如画布还在加载）不检查。
 * 派发时控制面把任务引用的机器人名单随任务下发。
 */

type Io = NodeTypeMetadata["inputs"];
type JsonSchema = Record<string, unknown>;

/** 输入 schema 里标记「飞书机器人」类型的值（`x-sfly-type`，与 sdk/python/src/sfly/cli/scan.py 一致）。 */
export const FEISHU_BOT_INPUT_TYPE = "feishu_bot";

/** 这个输入是不是「飞书机器人」类型（`FeishuBot`，或 `FeishuBot | None`）。 */
export const isFeishuBotInput = (schema: JsonSchema): boolean =>
	isInputOfType(schema, FEISHU_BOT_INPUT_TYPE);

/** 节点类型里「飞书机器人」类型的输入名（按参数顺序）。 */
export const feishuBotInputs = (io: Io): string[] => inputsOfType(io, FEISHU_BOT_INPUT_TYPE);

/** 已解析的输入里，「飞书机器人」类型的输入引用的机器人：每个值不为空的字符串一项（null、其他类型留给类型检查）。 */
export function referencedFeishuBots(
	io: Io,
	inputs: Record<string, unknown>,
): { input: string; bot: string }[] {
	return namesInInputs(io, inputs, FEISHU_BOT_INPUT_TYPE).map(({ input, name }) => ({
		input,
		bot: name,
	}));
}

export interface FeishuBotWarning {
	code: "feishu_bot_not_registered";
	message: string;
	node_id: string;
	/** 警告所指的字段，检查器显示在字段下面。 */
	input: string;
}

/**
 * 选择的机器人没有登记过时的说明（静态检查、触发时按实际值检查共用）。
 * `node` 是节点的名字：节点 ID，静态检查写成「显示名称（节点 ID）」（{@link nodeNameWithId}）。
 * `input` 是节点的输入名（「飞书机器人」类型的输入）。
 */
export function feishuBotNotRegistered(node: string, bot: string, input: string): string {
	return `节点 ${node} 的输入 ${input} 选择的飞书机器人「${bot}」还没有登记`;
}

/**
 * 「飞书机器人」类型的输入的静态检查：常量必须是已登记的机器人（`bots`）。含引用的值在触发时按实际值检查
 * （控制面）。节点类型未知时跳过（包版本检查会指出）；没有填写的输入由必填检查指出。
 */
export function feishuBotInputWarnings(
	doc: StoredOrchestrationDocument,
	catalog: PackageCatalog,
	bots: ReadonlySet<string>,
): FeishuBotWarning[] {
	const warnings: FeishuBotWarning[] = [];
	for (const node of doc.nodes) {
		if (node.kind !== "package") continue;
		const type = nodeTypeOf(doc, node, catalog);
		if (!type) continue;
		for (const { input, bot } of referencedFeishuBots(type.inputs, node.inputs)) {
			if (referencesIn(bot).length > 0 || bots.has(bot)) continue;
			warnings.push({
				code: "feishu_bot_not_registered",
				message: feishuBotNotRegistered(nodeNameWithId(node), bot, input),
				node_id: node.id,
				input,
			});
		}
	}
	return warnings;
}
