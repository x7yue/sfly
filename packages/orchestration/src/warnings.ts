import type { StoredOrchestrationDocument } from "@sfly/schema";
import { type AgentInputWarning, agentInputWarnings } from "./agent-inputs.js";
import {
	type AnnotationWarning,
	annotationWarnings,
	isAnnotationWarning,
	type WarningShape,
} from "./annotation-warnings.js";
import { type FeishuBotWarning, feishuBotInputWarnings } from "./feishu-bots.js";
import { type InputWarning, inputWarnings } from "./inputs.js";
import {
	type PackageCatalog,
	packageWarnings,
	type ReferenceWarning,
	referenceWarnings,
	subflowParamWarnings,
} from "./references.js";
import { type RemovedNodeWarning, removedNodeWarnings } from "./removed-nodes.js";
import { type RunStateWarning, runStateWarnings } from "./run-state-references.js";
import { type StructureWarning, structureWarnings } from "./structure.js";

/** 指着节点或整个场景的警告：没有 `annotation_id`，和注释框的警告（`AnnotationWarning`）区分开。 */
type NodeWarning = (
	| StructureWarning
	| ReferenceWarning
	| RunStateWarning
	| InputWarning
	| AgentInputWarning
	| FeishuBotWarning
	| RemovedNodeWarning
) & { annotation_id?: undefined };

export type OrchestrationWarning = NodeWarning | AnnotationWarning;

/** 这条警告是否阻断触发：触发前的预检要求处理完；注释框的警告只提示，不阻断（docs/SEMANTICS.md §1.6）。 */
export const blocksTrigger = (warning: WarningShape): boolean => !isAnnotationWarning(warning);

/**
 * 编排文档的全部静态检查（docs/SEMANTICS.md §1.2、§1.3、§2.4、§2.7、§7）：结构、包版本锁定、引用、`run.state` 的位置和
 * 「运行状态」类型的输入、包节点输入（必填、常量类型、
 * 「Agent」类型的常量是已注册的 Agent）、「飞书机器人」类型的常量选了已登记的飞书机器人、
 * 子流程参数映射、已移除种类的节点（ADR 0028）、注释框的成员（注释框的警告只提示，不阻断触发，见 `blocksTrigger`）。
 * 保存时作为警告返回；触发时必须全部通过。控制面和画布都调用这个函数。
 * `agents`：已注册的 Agent 名称；不知道时（例如画布还在加载）不检查「Agent」类型的输入。
 * `feishuBots`：已登记的飞书机器人名称；不知道时不检查登记情况。
 */
export function documentWarnings(
	doc: StoredOrchestrationDocument,
	catalog: PackageCatalog,
	options: { agents?: ReadonlySet<string>; feishuBots?: ReadonlySet<string> } = {},
): OrchestrationWarning[] {
	return [
		...structureWarnings(doc),
		...packageWarnings(doc, catalog),
		...referenceWarnings(doc, catalog),
		...runStateWarnings(doc, catalog),
		...inputWarnings(doc, catalog),
		...(options.agents ? agentInputWarnings(doc, catalog, options.agents) : []),
		...(options.feishuBots ? feishuBotInputWarnings(doc, catalog, options.feishuBots) : []),
		...subflowParamWarnings(doc),
		...removedNodeWarnings(doc),
		...annotationWarnings(doc),
	];
}

/**
 * 全部警告的种类（运行时的名单，`documentWarnings` 可能给出的每一种）。类型上保证和 `OrchestrationWarning["code"]` 完全一致：
 * 新加一种警告而没有写进这里，编译不过；「同一条警告」的测试按这份名单逐种检查定位的字段够不够。
 */
export const DOCUMENT_WARNING_CODES = [
	"entry_count",
	"unknown_node",
	"invalid_dispatch",
	"multiple_outgoing",
	"multiple_incoming",
	"entry_incoming",
	"cycle",
	"async_without_dispatch",
	"async_multiple_dispatch",
	"subflow_not_triggered",
	"subflow_multiple_triggers",
	"subflow_name_empty",
	"subflow_name_duplicate",
	"stop_subflow_unset",
	"stop_subflow_unknown",
	"stop_subflow_before_trigger",
	"stop_subflow_out_of_scope",
	"nesting_too_deep",
	"orphan_node",
	"missing_agent",
	"timeout_out_of_range",
	"package_not_locked",
	"package_version_missing",
	"unknown_node_type",
	"reference_invalid",
	"reference_unknown_param",
	"reference_unknown_node",
	"reference_not_earlier",
	"reference_unknown_output",
	"subflow_param_unknown",
	"subflow_param_missing",
	"reference_run_state_embedded",
	"reference_run_state_misplaced",
	"input_run_state_missing",
	"input_run_state_value",
	"input_required",
	"input_type_mismatch",
	"input_not_declared",
	"agent_input_not_registered",
	"feishu_bot_not_registered",
	"node_kind_removed",
	"annotation_unknown_node",
	"annotation_unknown_subflow",
	"annotation_no_members",
	"annotation_duplicate_member",
] as const satisfies readonly OrchestrationWarning["code"][];

type MissingCodes = Exclude<OrchestrationWarning["code"], (typeof DOCUMENT_WARNING_CODES)[number]>;
/** 名单漏了哪种警告时这里报类型错误（`MissingCodes` 不是 never）。 */
const _allCodesListed: [MissingCodes] extends [never] ? true : MissingCodes = true;
void _allCodesListed;

/** 定位一条警告的字段：种类加它指向的对象（`node_id`、`input`、`annotation_id`、`target`）。 */
export interface WarningLocation {
	code: string;
	message?: string;
	node_id?: string | undefined;
	input?: string | undefined;
	annotation_id?: string | undefined;
	target?: string | undefined;
}

/**
 * 「同一条警告」的键（#424）：种类加它指向的对象，不看文字。检查一份文档时，最新版本里有同样键的警告算「改动之前就有」。
 * 指向的对象由 `node_id`、`input`、`annotation_id` 和 `target` 共同确定；同一个节点（或注释框）上可能有两条同种警告的，
 * 都在 `target` 里写清是哪一个（引用的路径、注释框的成员、连线、选的 Agent……），见各警告的说明。
 */
export const warningIdentity = (w: WarningLocation): string =>
	JSON.stringify([
		w.code,
		w.node_id ?? null,
		w.input ?? null,
		w.annotation_id ?? null,
		w.target ?? null,
	]);
