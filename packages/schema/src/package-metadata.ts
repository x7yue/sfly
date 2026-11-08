import { z } from "zod";

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

/** 图表声明：把一个或几个本节点类型声明的指标画出来。 */
export const ChartDeclaration = z.strictObject({
	title: z.string().min(1),
	type: z.enum(["line", "area", "bar", "stat"]),
	metrics: z.array(MetricName).min(1),
});

export const NodeTypeMetadata = z
	.strictObject({
		name: NodeName,
		title: z.string().min(1),
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
			}
		}
		if (node.primary_metric !== undefined && !names.has(node.primary_metric)) {
			ctx.addIssue({
				code: "custom",
				path: ["primary_metric"],
				message: `主指标 ${node.primary_metric} 未声明`,
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
