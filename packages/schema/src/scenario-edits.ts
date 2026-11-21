import { z } from "zod";
import { PackageNode } from "./orchestration-document.js";

/**
 * 场景的局部编辑（#470）：一组操作，由控制面按顺序作用在最新版本上（@sfly/orchestration 的 applyEditOperations，
 * 用的是画布已经在用的编辑函数），要么全部生效存成一个新版本，要么都不生效。
 *
 * 这一版只有增删节点和连线、改一个节点的字段；入口参数、注释框、子流程的结构和场景级设置（默认 Agent、锁定的包版本）
 * 仍用整份文档保存（pull / push）。
 */

const NodeId = z.string().min(1);
const EdgeKind = z.enum(["chain", "dispatch"]);

/**
 * 加一个包节点。`id` 不写时按画布的规则生成（节点名加序号，例如 `check_1`）。`after` 写了就接在那个节点后面：
 * 它是链尾时追加，后面还有节点时插在它和下一个节点之间（和画布上「在后面添加」一样）。
 * 包还没有锁定时一起锁定：`version` 写了用它，不写时用最新发布的版本，没有发布过、只有在线的 Agent 加载着开发版本时用 `dev`；
 * 已经锁定的包只能用锁定的版本。
 */
export const AddNodeOperation = z.strictObject({
	op: z.literal("add_node"),
	id: NodeId.optional(),
	package: PackageNode.shape.package,
	node: PackageNode.shape.node,
	version: z.string().min(1).optional(),
	after: NodeId.optional(),
	/** 节点的输入：常量或含 `${{ ... }}` 引用的字符串。必填的输入要给出。 */
	inputs: z.record(z.string(), z.unknown()).optional(),
	display_name: PackageNode.shape.display_name,
	note: PackageNode.shape.note,
	agent: PackageNode.shape.agent,
	always: z.boolean().optional(),
	timeout: PackageNode.shape.timeout,
	retries: PackageNode.shape.retries,
	queue_timeout: PackageNode.shape.queue_timeout,
});

/** 删一个节点，连同它的连线；它恰好一进一出时前后接上（和画布上删除一样），注释框里的成员一起去掉。入口节点不能删。 */
export const RemoveNodeOperation = z.strictObject({
	op: z.literal("remove_node"),
	node: NodeId,
});

/** 加一条连线，规则和画布上连线一样（链不分叉、不汇合、不成环；调度连线从异步任务节点连到子流程入口）。 */
export const ConnectOperation = z.strictObject({
	op: z.literal("connect"),
	from: NodeId,
	to: NodeId,
	kind: EdgeKind.default("chain"),
});

/** 断开一条连线；没有这条连线时这个操作不合法。 */
export const DisconnectOperation = z.strictObject({
	op: z.literal("disconnect"),
	from: NodeId,
	to: NodeId,
	kind: EdgeKind.default("chain"),
});

/**
 * 包节点上可以改的字段：输入（`inputs.<输入名>`）、执行它的 Agent、显示名称、备注、执行设置。
 * 其他节点只能改显示名称和备注（子流程入口节点只有备注：它的名称是子流程的结构）。
 */
export const SETTABLE_NODE_FIELDS = [
	"agent",
	"display_name",
	"note",
	"always",
	"timeout",
	"retries",
	"queue_timeout",
] as const;

/**
 * 改一个节点的一个字段：`field` 是 SETTABLE_NODE_FIELDS 之一或 `inputs.<输入名>`；`value` 不写（或写 null）就是去掉这个字段，
 * 去掉的字段按没有写处理（`always` 为 false、Agent 用场景的默认 Agent）。
 */
export const SetFieldOperation = z.strictObject({
	op: z.literal("set"),
	node: NodeId,
	field: z.string().min(1),
	value: z.unknown().optional(),
});

export const EditOperation = z.discriminatedUnion("op", [
	AddNodeOperation,
	RemoveNodeOperation,
	ConnectOperation,
	DisconnectOperation,
	SetFieldOperation,
]);

/** 一次请求最多带多少个操作。 */
export const EDIT_OPERATIONS_MAX = 100;

export const EditOperations = z.array(EditOperation).min(1).max(EDIT_OPERATIONS_MAX);

/** 操作涉及的节点（错误信息里写两端用）：ID 和种类，包节点还有「包名/节点名」。 */
export const EditNodeRef = z.object({
	id: z.string(),
	kind: z.string(),
	type: z.string().optional(),
});

/**
 * 400 `invalid_operation` 的 details：哪一个操作（从 0 开始）、为什么不合法，以及让调用方自己改对的线索：
 * 节点 ID 不存在时 `similar` 是相近的节点 ID；缺必填输入时 `missing` 是缺的输入和它们的类型；
 * 连线接不上时 `from`、`to` 是两端的节点；节点包、节点类型或输入名不对时 `choices` 是可选的。
 */
export const EditOperationProblem = z.object({
	index: z.number().int().nonnegative(),
	op: z.string(),
	message: z.string(),
	similar: z.array(z.string()).optional(),
	missing: z.array(z.object({ name: z.string(), type: z.string() })).optional(),
	from: EditNodeRef.optional(),
	to: EditNodeRef.optional(),
	choices: z.array(z.string()).optional(),
});

export type EditOperation = z.output<typeof EditOperation>;
export type EditOperationInput = z.input<typeof EditOperation>;
export type EditOperationProblem = z.infer<typeof EditOperationProblem>;
