import { z } from "zod";
import { OrchestrationDocument } from "./orchestration-document.js";
import { PackageMetadata } from "./package-metadata.js";

export * from "./http/index.js";
export * from "./orchestration-document.js";
export * from "./package-metadata.js";

/** 导出给 Python CLI 使用的 JSON Schema：文件名（不含扩展名） → zod schema。 */
export const exportedSchemas = {
	"orchestration-document": OrchestrationDocument,
	"package-metadata": PackageMetadata,
} as const;

/** 按输入形态导出 JSON Schema（draft 2020-12）；带默认值的字段在输入中可省略。 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
	return z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" });
}
