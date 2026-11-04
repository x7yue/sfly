import type { OrchestrationDocument } from "@sfly/schema";
import {
	type PackageCatalog,
	packageWarnings,
	type ReferenceWarning,
	referenceWarnings,
} from "./references.js";
import { type StructureWarning, structureWarnings } from "./structure.js";

export type OrchestrationWarning = StructureWarning | ReferenceWarning;

/**
 * 编排文档的全部静态检查（docs/SEMANTICS.md §1.2、§2.4、§7）：结构、包版本锁定、引用。
 * 保存时作为警告返回；触发时必须全部通过。控制面和画布都调用这个函数。
 */
export function documentWarnings(
	doc: OrchestrationDocument,
	catalog: PackageCatalog,
): OrchestrationWarning[] {
	return [
		...structureWarnings(doc),
		...packageWarnings(doc, catalog),
		...referenceWarnings(doc, catalog),
	];
}
