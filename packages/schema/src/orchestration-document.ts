import { z } from "zod";
import { optionalLine, optionalMultiline, requiredLine } from "./display-text.js";
import { NodeName, PackageName } from "./package-metadata.js";
import { REMOVED_NODE_KIND_NAMES } from "./removed-nodes.js";

/**
 * 编排文档：一个编排版本的内容（docs/SEMANTICS.md）。
 * 最小版本：只表达结构，结构与引用规则的校验由控制面完成（保存时警告、触发时阻断）。
 */

export const ParamType = z.enum(["string", "number", "boolean", "json"]);

/** 参数说明的长度上限（Unicode 字符数）。 */
export const PARAM_DESCRIPTION_MAX = 200;

/** 备注（节点的、注释框的）的长度上限（Unicode 字符数）。 */
export const NODE_NOTE_MAX = 2000;

/** 注释框标题的长度上限（Unicode 字符数）。 */
export const ANNOTATION_TITLE_MAX = 40;

/**
 * 注释框的颜色：场景作者选的分类色，只用于区分画布上的几个注释框，不表达状态（ADR 0025）。
 * 不写就是灰色（gray）；色板里没有青、红、紫，它们分别是执行中、失败和子流程区域的颜色。
 */
export const ANNOTATION_COLORS = ["gray", "blue", "green", "yellow", "orange", "pink"] as const;
export const AnnotationColor = z.enum(ANNOTATION_COLORS);

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

/** 节点显示名称的长度上限（Unicode 字符数）。 */
export const DISPLAY_NAME_MAX = 40;

/** 节点输入值：常量或含 `${{ ... }}` 引用的字符串，原样保存，派发时解析。 */
const InputValues = z.record(z.string(), z.unknown());

const Position = z.strictObject({ x: z.number(), y: z.number() });

const nodeBase = {
	id: z.string().min(1),
	/** 布局属于版本内容。 */
	position: Position.optional(),
	/** 备注：多行说明，写这个节点做什么、为什么这样配置。属于版本内容，只用于显示，不影响执行（docs/SEMANTICS.md §1.5）。 */
	note: optionalMultiline(NODE_NOTE_MAX),
};

/**
 * 显示名称：一行短名字，卡片标题和其他显示节点的地方优先显示它。属于版本内容，和 `position` 一样（ADR 0023）；
 * 只用于显示，不参与引用、派发和校验（docs/SEMANTICS.md §1.4）。子流程入口节点没有它：子流程名称（`name`）就是显示名称。
 */
const displayName = { display_name: optionalLine(DISPLAY_NAME_MAX) };

/**
 * 参数声明列表，没写时是空列表。用 `prefault` 而不是 `default`：参数声明里有「去掉首尾空白」的转换，
 * zod 导出输入形态的 JSON Schema 时会把转换外层的 `default` 当成只属于输出而丢掉，`prefault` 的值会留下，
 * 解析结果一样。
 */
const paramDeclarations = z.array(ParamDeclaration).prefault([]);

export const EntryNode = z.strictObject({
	...nodeBase,
	...displayName,
	kind: z.literal("entry"),
	params: paramDeclarations,
});

export const SubflowEntryNode = z.strictObject({
	...nodeBase,
	kind: z.literal("subflow_entry"),
	/**
	 * 子流程的名称，场景内唯一（停止子流程节点按名称选择子流程，docs/SEMANTICS.md §4.1）。
	 * 可选只为兼容旧版本：没有该字段时以节点 ID 作为名称；为空或重复时保存只警告、触发时拒绝（docs/SEMANTICS.md §1.2）。
	 */
	name: z.string().optional(),
	params: paramDeclarations,
});

export const AsyncTaskNode = z.strictObject({
	...nodeBase,
	...displayName,
	kind: z.literal("async"),
	/** 子流程参数映射：子流程入口参数名 → 值。 */
	params: InputValues.default({}),
});

export const StopSubflowNode = z.strictObject({
	...nodeBase,
	...displayName,
	kind: z.literal("stop_subflow"),
	always: z.boolean().default(false),
	/**
	 * 要停止的子流程：子流程入口的节点 ID（画布里按名称选择，改名不影响引用，docs/SEMANTICS.md §4.1）。
	 * 可选：画布新建的节点还没有选择；没有选择时保存只警告、触发时拒绝（docs/SEMANTICS.md §1.2）。
	 */
	subflow: z.string().min(1).optional(),
});

export const PackageNode = z.strictObject({
	...nodeBase,
	...displayName,
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
	StopSubflowNode,
	PackageNode,
]);

/** 可以执行、可以保存的节点种类。 */
export const NODE_KINDS = [
	"entry",
	"subflow_entry",
	"async",
	"stop_subflow",
	"package",
] as const satisfies readonly OrchestrationNode["kind"][];

/** 历史记录（历史版本、历史运行）里可能出现的节点种类：现在支持的，加上已移除的（ADR 0028）。 */
export const STORED_NODE_KINDS = [...NODE_KINDS, ...REMOVED_NODE_KIND_NAMES] as const;

/**
 * 已移除种类的节点（ADR 0028，种类见 removed-nodes.ts）：读取历史版本时认得它，只读显示，不能保存。
 * 只描述所有节点共有的字段；控制面读库时把它当时的其余配置原样带着（{@link keepRemovedNodeConfig}），
 * 想把旧配置换成别的写法的人读得到。它不在可以保存的节点里（{@link OrchestrationNode}）：
 * 保存带它的文档被拒绝，从画布上删掉之后才能保存。
 */
export const RemovedNode = z.object({
	id: z.string().min(1),
	kind: z.enum(REMOVED_NODE_KIND_NAMES),
	position: Position.optional(),
	note: z.string().optional(),
	display_name: z.string().optional(),
});

/** 读到的节点：可以执行、可以保存的种类，加上已移除种类的占位。 */
export const StoredNode = z.union([OrchestrationNode, RemovedNode]);

export const Edge = z.strictObject({
	from: z.string().min(1),
	to: z.string().min(1),
	/** chain：链上的顺序连线；dispatch：异步任务节点 → 子流程入口节点的调度连线。 */
	kind: z.enum(["chain", "dispatch"]),
});

/**
 * 注释框：给一组节点和子流程画的框，带标题和备注，说明它们合起来在场景里做什么。属于版本内容，只记成员、
 * 不存坐标和大小，框的范围由成员算出（@sfly/orchestration 的 annotationBoxes，ADR 0023）；
 * 只用于显示，不影响执行（docs/SEMANTICS.md §1.6）。
 */
export const Annotation = z.strictObject({
	/** 注释框之间唯一（重复时文档不合法）；画布新建时自动生成，例如 `annotation_1`。 */
	id: z.string().min(1),
	title: requiredLine(ANNOTATION_TITLE_MAX),
	note: optionalMultiline(NODE_NOTE_MAX),
	/** 颜色，不写就是灰色；画布新建的注释框不写，选灰色时也去掉这一项。 */
	color: AnnotationColor.optional(),
	/** 成员节点的节点 ID。 */
	nodes: z.array(z.string().min(1)).default([]),
	/** 成员子流程：子流程入口的节点 ID（和停止子流程节点一样，子流程改名不影响）。 */
	subflows: z.array(z.string().min(1)).default([]),
});

const Annotations = z.array(Annotation).superRefine((annotations, ctx) => {
	const seen = new Set<string>();
	for (const [i, { id }] of annotations.entries()) {
		if (seen.has(id)) {
			ctx.addIssue({ code: "custom", path: [i, "id"], message: `注释框 ID ${id} 重复` });
		}
		seen.add(id);
	}
});

const documentShape = <N extends z.ZodType>(node: N) => ({
	default_agent: z.string().min(1).optional(),
	nodes: z.array(node),
	edges: z.array(Edge).default([]),
	/** 锁定的节点包版本：包名 → 版本（`dev` 表示开发版本）。 */
	packages: z.record(PackageName, z.string().min(1)).default({}),
	annotations: Annotations.default([]),
});

const documentOf = <N extends z.ZodType>(node: N) => z.strictObject(documentShape(node));

/**
 * 已移除的顶层字段（便签 `sticky_notes`，ADR 0028）在保存请求里的写法：只收空数组。升级前保存的版本都带着
 * `sticky_notes: []`，「读出来改一处再存回去」是自建页面和命令行最常见的写法，不该因为一个空数组被拒绝；
 * 收下之后控制面丢掉它（`withoutRemovedFields`），新版本里没有。有内容的数组不收：读取时丢掉的内容不能再悄悄丢一次，
 * 保存被拒绝，错误信息写明有几条、怎么办（`removedFieldsMessage`）。和 `REMOVED_DOCUMENT_FIELDS` 登记的字段一一对应
 * （`removed-document-fields.test.ts` 核对）。
 */
const EmptyRemovedField = z
	.array(z.unknown())
	.max(0)
	.optional()
	.describe(
		"已移除的字段（便签，ADR 0028）：只为兼容旧客户端和升级前导出的文件保留，新写的文档不要带它。读到的文档里没有它；保存时收到空数组会丢掉，有内容的被拒绝。",
	);

/** 可以保存的场景文档：节点都是现在支持的种类（保存、命令行的本地检查、导出给 Python 的 JSON Schema 用它）。 */
export const OrchestrationDocument = z
	.strictObject({
		...documentShape(OrchestrationNode),
		/**
		 * 已移除的字段（便签，ADR 0028）：只为兼容旧客户端和升级前导出的文件保留，新写的文档不要带它。
		 * 保存时收到空数组会丢掉（新版本里没有它），里面有内容的被拒绝（400 `invalid_document`，写明有几条、怎么办）。
		 * 读到的文档（`StoredOrchestrationDocument`）里没有这个字段，读出来原样存回去不用处理它。
		 */
		sticky_notes: EmptyRemovedField,
	})
	.meta({ title: "sfly 编排文档" });

/**
 * 读到的场景文档（接口的响应、控制面读库、画布打开最新版本）：结构和保存用的 {@link OrchestrationDocument} 相同，
 * 只是节点里可以有已移除种类的占位（{@link RemovedNode}）。场景版本不可变，历史版本里留着已移除的节点，读取时认得它们。
 * 保存不接受这些占位：把读到的文档原样传回保存之前，先过滤掉 `RemovedNode`。
 */
export const StoredOrchestrationDocument = documentOf(StoredNode);

export type ParamDeclaration = z.infer<typeof ParamDeclaration>;
export type OrchestrationDocument = z.infer<typeof OrchestrationDocument>;
export type StoredOrchestrationDocument = z.infer<typeof StoredOrchestrationDocument>;
export type OrchestrationNode = z.infer<typeof OrchestrationNode>;
export type RemovedNode = z.infer<typeof RemovedNode>;
export type StoredNode = z.infer<typeof StoredNode>;
export type Annotation = z.infer<typeof Annotation>;
export type AnnotationColor = z.infer<typeof AnnotationColor>;

/** 注释框不写颜色时是灰色（ADR 0025）：画布选回灰色时去掉 `color`，版本对比把两种写法当成同一种。 */
export const ANNOTATION_DEFAULT_COLOR: AnnotationColor = "gray";

/** 注释框实际显示的颜色。 */
export const annotationColor = (annotation: { color?: AnnotationColor | undefined }) =>
	annotation.color ?? ANNOTATION_DEFAULT_COLOR;
