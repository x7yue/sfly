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
});

export const NodeTypeMetadata = z.strictObject({
	name: NodeName,
	title: z.string().min(1),
	/** 入口：`module:function`。 */
	entry: z.string().regex(/^[A-Za-z_][\w.]*:[A-Za-z_]\w*$/, "入口必须形如 module:function"),
	inputs: IoSchema,
	outputs: IoSchema,
});

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
		nodes: z.array(NodeTypeMetadata).min(1),
	})
	.meta({ title: "sfly 节点包元信息" });

export type PackageMetadata = z.infer<typeof PackageMetadata>;
export type NodeTypeMetadata = z.infer<typeof NodeTypeMetadata>;
