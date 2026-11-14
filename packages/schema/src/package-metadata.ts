import { z } from "zod";
import { optionalMultiline } from "./display-text.js";

/** 节点包名：小写字母、数字、`-`、`_`，以字母或数字开头。 */
export const PackageName = z
	.string()
	.regex(/^[a-z0-9][a-z0-9_-]*$/, "包名只能包含小写字母、数字、- 和 _");

/** 节点名：Python 标识符（节点类型引用形式为 `包名/节点名`）。 */
export const NodeName = z
	.string()
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "节点名必须是合法的 Python 标识符");

/** 节点输入或输出的 JSON Schema（type=object，properties 的键即参数名 / 输出键）。 */
export const IoSchema = z.looseObject({
	type: z.literal("object"),
	properties: z.record(z.string(), z.record(z.string(), z.unknown())),
	required: z.array(z.string()).optional(),
	/**
	 * properties 的键顺序（输入为函数参数顺序）。PostgreSQL JSONB 不保留对象键顺序，
	 * 参数表单按这里排列；没有时按 properties 的键顺序（#1 评审）。
	 */
	order: z.array(z.string()).optional(),
});

/** 每个节点类型最多声明的指标数。 */
export const MAX_METRICS = 50;
/** 每个节点类型最多声明的图表数。 */
export const MAX_CHARTS = 20;

/** 指标名：标识符。 */
export const MetricName = z
	.string()
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "指标名必须是标识符（字母、数字、下划线，不以数字开头）");

/** 每个指标最多声明的标签键数。 */
export const MAX_LABEL_KEYS = 3;

/**
 * 指标声明：`gauge` 瞬时值 | `counter` 累计值。
 * `labels` 是标签键（命名规则同指标名、不重复）：每个点必须给全这些键的值，每组标签值是一个序列；
 * 没有这个字段的指标不带标签。
 */
export const MetricDeclaration = z.strictObject({
	name: MetricName,
	unit: z.string(),
	kind: z.enum(["gauge", "counter"]),
	description: z.string().optional(),
	labels: z.array(MetricName).max(MAX_LABEL_KEYS).optional(),
});

/** 指标是否带标签（声明了标签键）。 */
export const isLabeled = (metric: { labels?: readonly string[] | undefined }): boolean =>
	(metric.labels?.length ?? 0) > 0;

/** 图表声明：把一个或几个本节点类型声明的指标画出来。 */
export const ChartDeclaration = z.strictObject({
	title: z.string().min(1),
	type: z.enum(["line", "area", "bar", "stat"]),
	metrics: z.array(MetricName).min(1),
});

/** 节点类型说明的长度上限（Unicode 字符数）；`sfly build` 按同一个上限检查。 */
export const NODE_DESCRIPTION_MAX = 4000;

export const NodeTypeMetadata = z
	.strictObject({
		name: NodeName,
		title: z.string().min(1),
		// 这一层是严格对象：带说明的包发布到没有这个字段的旧控制面会被拒绝，升级说明里要写明。
		/**
		 * 节点类型的说明：节点函数的文档字符串（去掉缩进，可以多段），显示在「添加节点」菜单（第一段）、
		 * 节点包管理页（第一段）和检查器的「说明」页（全文）。只用于显示；没有文档字符串时没有这个字段。
		 */
		description: optionalMultiline(NODE_DESCRIPTION_MAX),
		/** 入口：`module:function`。 */
		entry: z.string().regex(/^[A-Za-z_][\w.]*:[A-Za-z_]\w*$/, "入口必须形如 module:function"),
		inputs: IoSchema,
		outputs: IoSchema,
		/** 节点运行时上报的指标；早于指标功能构建的节点包没有这个字段。 */
		metrics: z.array(MetricDeclaration).max(MAX_METRICS).optional(),
		/** 图表；没被任何图表引用的指标由控制面 API 补上默认图表。 */
		charts: z.array(ChartDeclaration).max(MAX_CHARTS).optional(),
		/** 主指标：一个已声明的指标名；没有时紧凑位置不显示。 */
		primary_metric: MetricName.optional(),
	})
	.superRefine((node, ctx) => {
		// 交叉引用约束 JSON Schema 表达不了：Python CLI 在 sfly build 时做同样的检查。
		const names = new Set<string>();
		const labeled = new Set<string>();
		for (const [i, metric] of (node.metrics ?? []).entries()) {
			if (names.has(metric.name)) {
				ctx.addIssue({
					code: "custom",
					path: ["metrics", i, "name"],
					message: `指标名 ${metric.name} 重复`,
				});
			}
			names.add(metric.name);
			const keys = metric.labels ?? [];
			if (isLabeled(metric)) labeled.add(metric.name);
			for (const [j, key] of keys.entries()) {
				if (keys.indexOf(key) !== j) {
					ctx.addIssue({
						code: "custom",
						path: ["metrics", i, "labels", j],
						message: `指标 ${metric.name} 的标签键 ${key} 重复`,
					});
				}
			}
		}
		for (const [i, chart] of (node.charts ?? []).entries()) {
			for (const ref of chart.metrics) {
				if (!names.has(ref)) {
					ctx.addIssue({
						code: "custom",
						path: ["charts", i, "metrics"],
						message: `图表 ${chart.title} 引用了未声明的指标 ${ref}`,
					});
				}
				// 数值卡和柱状图每个指标只画一个值，画不出多个序列。
				if (labeled.has(ref) && (chart.type === "stat" || chart.type === "bar")) {
					ctx.addIssue({
						code: "custom",
						path: ["charts", i, "metrics"],
						message: `图表 ${chart.title} 是 ${chart.type}，不能引用带标签键的指标 ${ref}；带标签的指标只能画在 line 或 area 图表里`,
					});
				}
			}
		}
		if (node.primary_metric !== undefined && !names.has(node.primary_metric)) {
			ctx.addIssue({
				code: "custom",
				path: ["primary_metric"],
				message: `主指标 ${node.primary_metric} 未声明`,
			});
		}
		// 紧凑位置只显示一个值；需要合计时由节点另报一个不带标签的指标。
		if (node.primary_metric !== undefined && labeled.has(node.primary_metric)) {
			ctx.addIssue({
				code: "custom",
				path: ["primary_metric"],
				message: `主指标 ${node.primary_metric} 带标签键，不能作为主指标；请另报一个不带标签的合计指标作为主指标`,
			});
		}
	});

/**
 * 最低 SDK 版本要求（#79）：逗号分隔的若干条件，每条是比较符加只含数字的版本号，例如 `>=0.0.4`。
 * 比较符取 PEP 440 的 `>=`、`>`、`<=`、`<`、`==`、`!=`、`~=`；不支持通配符和预发布版本
 * （Agent 的版本只有 `X.Y.Z`，ADR 0010）。
 */
const SDK_CLAUSE = String.raw`(?:~=|==|!=|<=|>=|<|>)\s*[0-9]+(?:\.[0-9]+)*`;
export const RequiresSdk = z
	.string()
	.regex(
		new RegExp(String.raw`^\s*${SDK_CLAUSE}(?:\s*,\s*${SDK_CLAUSE})*\s*$`),
		"SDK 版本要求必须形如 >=0.0.4（逗号分隔的比较符加数字版本号）",
	);

/**
 * 最低 Agent 版本要求（ADR 0019）：格式与 {@link RequiresSdk} 相同，例如 `>=0.2.0`。用到 Agent 能力的节点包声明它，
 * 触发前和派发前对节点所在的 Agent 和它通过「Agent」类型的输入引用的 Agent 都检查。
 */
export const RequiresAgent = z
	.string()
	.regex(
		new RegExp(String.raw`^\s*${SDK_CLAUSE}(?:\s*,\s*${SDK_CLAUSE})*\s*$`),
		"Agent 版本要求必须形如 >=0.2.0（逗号分隔的比较符加数字版本号）",
	);

/** 节点包元信息：节点包归档中的 `sfly-package.json`。 */
export const PackageMetadata = z
	.strictObject({
		name: PackageName,
		/**
		 * 版本号（PEP 440 风格，以数字开头）。`dev` 保留给开发模式（docs/SEMANTICS.md §7），
		 * 不能发布；版本号也用作控制面上的文件名，所以不能包含路径分隔符。
		 */
		version: z
			.string()
			.regex(/^[0-9][0-9A-Za-z.+_!-]*$/, "版本号必须以数字开头，只能包含字母、数字和 . + _ ! -"),
		/** Python 版本要求，例如 `>=3.10`。 */
		requires_python: z.string().min(1),
		/**
		 * 需要的 SDK 运行时版本（即 Agent 版本，ADR 0010），控制面派发前检查；
		 * 早于 #79 构建的节点包没有这个字段，不检查。
		 */
		requires_sdk: RequiresSdk.optional(),
		/** 需要的 Agent 版本（`[tool.sfly] requires-agent`）；没有声明时不检查。 */
		requires_agent: RequiresAgent.optional(),
		nodes: z.array(NodeTypeMetadata).min(1),
	})
	.meta({ title: "sfly 节点包元信息" });

/**
 * 节点包查询 API 返回的图表：声明的图表（default=false）之后，是控制面为没被任何图表引用的
 * 指标生成的默认图表（default=true）。
 */
export const ChartView = ChartDeclaration.extend({ default: z.boolean() });

export type PackageMetadata = z.infer<typeof PackageMetadata>;
export type ChartView = z.infer<typeof ChartView>;
export type NodeTypeMetadata = z.infer<typeof NodeTypeMetadata>;
export type MetricDeclaration = z.infer<typeof MetricDeclaration>;
export type ChartDeclaration = z.infer<typeof ChartDeclaration>;
