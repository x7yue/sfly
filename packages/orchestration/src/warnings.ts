import type { OrchestrationDocument } from "@sfly/schema";
import { type AgentInputWarning, agentInputWarnings } from "./agent-inputs.js";
import { type FeishuBotWarning, feishuBotWarnings } from "./feishu-bots.js";
import { type InputWarning, inputWarnings } from "./inputs.js";
import {
	type PackageCatalog,
	packageWarnings,
	type ReferenceWarning,
	referenceWarnings,
	subflowParamWarnings,
} from "./references.js";
import { type StructureWarning, structureWarnings } from "./structure.js";
import { type TimingWarning, timingWarnings } from "./timing.js";

export type OrchestrationWarning =
	| StructureWarning
	| ReferenceWarning
	| InputWarning
	| AgentInputWarning
	| FeishuBotWarning
	| TimingWarning;

/**
 * 编排文档的全部静态检查（docs/SEMANTICS.md §1.2、§2.4、§5、§7）：结构、包版本锁定、引用、包节点输入（必填、常量类型、
 * 「Agent」类型的常量是已注册的 Agent）、飞书通知节点选了已登记的飞书机器人、子流程参数映射、定时 / Sleep 配置。
 * 保存时作为警告返回；触发时必须全部通过。控制面和画布都调用这个函数。
 * `agents`：已注册的 Agent 名称；不知道时（例如画布还在加载）不检查「Agent」类型的输入。
 * `feishuBots`：已登记的飞书机器人名称；不知道时只检查飞书通知节点有没有选择机器人。
 */
export function documentWarnings(
	doc: OrchestrationDocument,
	catalog: PackageCatalog,
	options: { agents?: ReadonlySet<string>; feishuBots?: ReadonlySet<string> } = {},
): OrchestrationWarning[] {
	return [
		...structureWarnings(doc),
		...packageWarnings(doc, catalog),
		...referenceWarnings(doc, catalog),
		...inputWarnings(doc, catalog),
		...(options.agents ? agentInputWarnings(doc, catalog, options.agents) : []),
		...feishuBotWarnings(doc, options.feishuBots),
		...subflowParamWarnings(doc),
		...timingWarnings(doc),
	];
}
