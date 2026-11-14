import { z } from "zod";
import { optionalLine } from "./display-text.js";
import { NodeName, PackageName } from "./package-metadata.js";

/**
 * 编排文档：一个编排版本的内容（docs/SEMANTICS.md）。
 * 最小版本：只表达结构，结构与引用规则的校验由控制面完成（保存时警告、触发时阻断）。
 */

export const ParamType = z.enum(["string", "number", "boolean", "json"]);

/** 参数说明的长度上限（Unicode 字符数）。 */
export const PARAM_DESCRIPTION_MAX = 200;

export const ParamDeclaration = z.strictObject({
	name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
	type: ParamType,
	default: z.unknown().optional(),
	required: z.boolean().default(false),
	secret: z.boolean().default(false),
	/**
	 * 一行说明：触发表单、子流程参数映射表单和命令行的参数表里显示。属于版本内容，和 `position` 一样；
	 * 只用于显示，不影响执行（docs/SEMANTICS.md §2.1）。
	 */
	description: optionalLine(PARAM_DESCRIPTION_MAX),
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

export const StopSubflowNode = z.strictObject({
	...nodeBase,
	kind: z.literal("stop_subflow"),
	always: z.boolean().default(false),
	/**
	 * 要停止的子流程：子流程入口的节点 ID（画布里按名称选择，改名不影响引用，docs/SEMANTICS.md §4.1）。
	 * 可选：画布新建的节点还没有选择；没有选择时保存只警告、触发时拒绝（§1.2）。
	 */
	subflow: z.string().min(1).optional(),
});

/** 飞书通知节点的消息格式：文本、Markdown 卡片、原始消息（docs/SEMANTICS.md §4.2）。 */
export const FeishuMessageFormat = z.enum(["text", "card", "raw"]);

/** Markdown 卡片的标题颜色（飞书卡片 header 的颜色模板）。 */
export const FeishuCardColor = z.enum(["blue", "green", "orange", "red", "grey"]);

export const FeishuNotifyNode = z.strictObject({
	...nodeBase,
	kind: z.literal("feishu_notify"),
	always: z.boolean().default(false),
	/**
	 * 飞书机器人的名称：常量，或整值引用入口参数（docs/SEMANTICS.md §1.3）。
	 * 可选：画布新建的节点还没有选择；没有选择时保存只警告、触发时拒绝。
	 */
	bot: z.string().min(1).optional(),
	/**
	 * 消息格式，决定下面哪一组字段生效。切换格式时其他格式里填过的内容留在文档里，
	 * 但不参与引用检查和解析，切回去还在。
	 */
	format: FeishuMessageFormat.default("text"),
	/** 文本格式：消息文本，支持内嵌引用。 */
	text: z.string().default(""),
	/** 文本格式：在正文末尾追加 `<at user_id="all">所有人</at>`。 */
	at_all: z.boolean().default(false),
	/** Markdown 卡片：标题，支持内嵌引用。 */
	title: z.string().default(""),
	/** Markdown 卡片：标题颜色。 */
	color: FeishuCardColor.default("blue"),
	/** Markdown 卡片：Markdown 正文，支持内嵌引用。 */
	markdown: z.string().default(""),
	/**
	 * 原始消息：完整的飞书请求体（JSON 对象），字符串字段里的引用逐个字段解析；也可以整值引用入口参数。
	 * 可选：还没有填写时消息不发送，节点日志里写一条 warning。
	 */
	message: z.unknown().optional(),
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
	StopSubflowNode,
	FeishuNotifyNode,
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
