import { z } from "zod";
import { NodeName, PackageName } from "./package-metadata.js";

/**
 * 编排文档：一个编排版本的内容（docs/SEMANTICS.md）。
 * 最小版本：只表达结构，结构与引用规则的校验由控制面完成（保存时警告、触发时阻断）。
 */

export const ParamType = z.enum(["string", "number", "boolean", "json"]);

export const ParamDeclaration = z.strictObject({
	name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
	type: ParamType,
	default: z.unknown().optional(),
	required: z.boolean().default(false),
	secret: z.boolean().default(false),
});

/** 节点输入值：常量或含 `${{ ... }}` 引用的字符串，原样保存，派发时解析。 */
const InputValues = z.record(z.string(), z.unknown());

const Position = z.strictObject({ x: z.number(), y: z.number() });

const nodeBase = {
	id: z.string().min(1),
	/** 布局属于版本内容。 */
	position: Position.optional(),
};

export const EntryNode = z.strictObject({
	...nodeBase,
	kind: z.literal("entry"),
	params: z.array(ParamDeclaration).default([]),
});

export const SubflowEntryNode = z.strictObject({
	...nodeBase,
	kind: z.literal("subflow_entry"),
	/**
	 * 子流程的名称，场景内唯一（停止子流程节点按名称选择子流程，docs/SEMANTICS.md §4.1）。
	 * 可选只为兼容旧版本：没有该字段时以节点 ID 作为名称；为空或重复时保存只警告、触发时拒绝（§1.2）。
	 */
	name: z.string().optional(),
	params: z.array(ParamDeclaration).default([]),
});

export const AsyncTaskNode = z.strictObject({
	...nodeBase,
	kind: z.literal("async"),
	/** 子流程参数映射：子流程入口参数名 → 值。 */
	params: InputValues.default({}),
});

export const TimerNode = z.strictObject({
	...nodeBase,
	kind: z.literal("timer"),
	always: z.boolean().default(false),
	/** `HH:MM:SS` 或 ISO 8601 日期时间。 */
	at: z.string().min(1),
	tz: z.string().default("Asia/Shanghai"),
});

export const SleepNode = z.strictObject({
	...nodeBase,
	kind: z.literal("sleep"),
	always: z.boolean().default(false),
	/** 例如 `30s`、`10m`、`1h`，可以是引用。 */
	duration: z.string().min(1),
});

export const PackageNode = z.strictObject({
	...nodeBase,
	kind: z.literal("package"),
	always: z.boolean().default(false),
	package: PackageName,
	node: NodeName,
	/** 未设置时使用编排的默认 Agent。 */
	agent: z.string().min(1).optional(),
	inputs: InputValues.default({}),
	/** 秒。 */
	timeout: z.number().int().positive().optional(),
	retries: z.number().int().nonnegative().optional(),
	/** 秒。 */
	queue_timeout: z.number().int().positive().optional(),
});

export const OrchestrationNode = z.discriminatedUnion("kind", [
	EntryNode,
	SubflowEntryNode,
	AsyncTaskNode,
	TimerNode,
	SleepNode,
	PackageNode,
]);

export const Edge = z.strictObject({
	from: z.string().min(1),
	to: z.string().min(1),
	/** chain：链上的顺序连线；dispatch：异步任务节点 → 子流程入口节点的调度连线。 */
	kind: z.enum(["chain", "dispatch"]),
});

export const OrchestrationDocument = z
	.strictObject({
		default_agent: z.string().min(1).optional(),
		nodes: z.array(OrchestrationNode),
		edges: z.array(Edge).default([]),
		/** 锁定的节点包版本：包名 → 版本（`dev` 表示开发版本）。 */
		packages: z.record(PackageName, z.string().min(1)).default({}),
	})
	.meta({ title: "sfly 编排文档" });

export type OrchestrationDocument = z.infer<typeof OrchestrationDocument>;
export type OrchestrationNode = z.infer<typeof OrchestrationNode>;
