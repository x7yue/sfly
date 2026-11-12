import type { NodeTypeMetadata, OrchestrationDocument } from "@sfly/schema";
import { inputsOfType, isInputOfType, namesInInputs } from "./input-types.js";
import { PARAM_PATH, WHOLE_REFERENCE } from "./reference-syntax.js";
import { nodeTypeOf, type PackageCatalog, referencesIn } from "./references.js";

/**
 * 飞书机器人（ADR 0020）的静态检查：节点选的机器人必须已登记。
 *
 * - 常量名称不是已登记的机器人：保存时警告，触发时阻断（{@link feishuBotWarnings}）；
 * - 整值引用入口参数（{@link notifyBotValue}）在触发时按实际值检查，节点执行时再看一次（控制面）；
 *   引用前面节点的输出、或把引用夹在文字里，都在保存时警告、触发时阻断：机器人要在触发前就能查清；
 * - 登记情况来自控制面的机器人列表，不知道时（例如画布还在加载）只检查有没有选择。
 *
 * 「飞书机器人」类型的输入（节点开发者用 `sfly.FeishuBot` 标注的参数）同样按名称引用机器人：
 * `sfly build` 在输入 schema 里标记它 `{"type": "string", "x-sfly-type": "feishu_bot"}`，
 * 可选参数（`FeishuBot | None`）是 anyOf 里的一项。静态检查见 {@link feishuBotInputWarnings}，
 * 说明与飞书通知节点共用 {@link feishuBotNotRegistered}；派发时控制面把任务引用的机器人名单随任务下发。
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
	code: "feishu_bot_not_registered" | "feishu_bot_unset" | "feishu_bot_reference_unsupported";
	message: string;
	node_id: string;
	/** 警告所指的字段，检查器显示在字段下面。 */
	input: string;
}

/**
 * 选择的机器人没有登记过时的说明（静态检查、触发时按实际值检查共用）。
 * `input` 是节点的输入名（「飞书机器人」类型的输入）；飞书通知节点自己的机器人字段不写。
 */
export function feishuBotNotRegistered(nodeId: string, bot: string, input?: string): string {
	const where = input === undefined ? `节点 ${nodeId}` : `节点 ${nodeId} 的输入 ${input}`;
	return `${where} 选择的飞书机器人「${bot}」还没有登记`;
}

/**
 * 飞书通知节点的机器人字段怎么写的：常量名称，整值引用入口参数（`${{ params.<名称> }}`，写不写空格都行），
 * 或者不支持的写法（引用前面节点的输出、引用夹在文字里、没有闭合的引用）。
 */
export type NotifyBotValue =
	| { kind: "constant"; name: string }
	| { kind: "param"; param: string }
	| { kind: "unsupported" };

/** 把飞书通知节点的机器人字段分成 {@link NotifyBotValue}（保存时的警告、触发时的检查、检查器共用这一条规则）。 */
export function notifyBotValue(bot: string): NotifyBotValue {
	const whole = WHOLE_REFERENCE.exec(bot)?.[1];
	const param = whole === undefined ? undefined : PARAM_PATH.exec(whole)?.[1];
	if (param !== undefined) return { kind: "param", param };
	return referencesIn(bot).length === 0 ? { kind: "constant", name: bot } : { kind: "unsupported" };
}

/** 机器人字段写了不支持的引用时的说明（规格：机器人是常量名称，或者整值引用入口参数）。 */
export const feishuBotReferenceUnsupported = (nodeId: string, bot: string): string =>
	`节点 ${nodeId} 的飞书机器人只能是已登记的机器人名称，或整个引用入口参数（\${{ params.<参数名> }}），现在是「${bot}」`;

/** 飞书通知节点还没有选择机器人时的说明。 */
export const feishuBotUnset = (nodeId: string): string => `节点 ${nodeId} 没有选择飞书机器人`;

/**
 * 飞书通知节点的机器人检查：没有选择；写了不支持的引用（{@link notifyBotValue}）；常量不是已登记的机器人
 * （`bots`：已登记的机器人名称）。整值引用入口参数在触发、执行时才知道。`bots` 为 undefined 时不检查登记情况。
 */
export function feishuBotWarnings(
	doc: OrchestrationDocument,
	bots?: ReadonlySet<string>,
): FeishuBotWarning[] {
	const warnings: FeishuBotWarning[] = [];
	for (const node of doc.nodes) {
		if (node.kind !== "feishu_notify") continue;
		if (node.bot === undefined) {
			warnings.push({
				code: "feishu_bot_unset",
				message: feishuBotUnset(node.id),
				node_id: node.id,
				input: "bot",
			});
			continue;
		}
		const value = notifyBotValue(node.bot);
		if (value.kind === "unsupported") {
			warnings.push({
				code: "feishu_bot_reference_unsupported",
				message: feishuBotReferenceUnsupported(node.id, node.bot),
				node_id: node.id,
				input: "bot",
			});
		} else if (value.kind === "constant" && bots && !bots.has(value.name)) {
			warnings.push({
				code: "feishu_bot_not_registered",
				message: feishuBotNotRegistered(node.id, value.name),
				node_id: node.id,
				input: "bot",
			});
		}
	}
	return warnings;
}

/**
 * 「飞书机器人」类型的输入的静态检查：常量必须是已登记的机器人（`bots`）。含引用的值在触发时按实际值检查
 * （控制面）。节点类型未知时跳过（包版本检查会指出）；没有填写的输入由必填检查指出。
 */
export function feishuBotInputWarnings(
	doc: OrchestrationDocument,
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
				message: feishuBotNotRegistered(node.id, bot, input),
				node_id: node.id,
				input,
			});
		}
	}
	return warnings;
}
