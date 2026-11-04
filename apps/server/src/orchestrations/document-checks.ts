import {
	documentWarnings,
	type NodeTypeIo,
	type OrchestrationWarning,
	type PackageCatalog,
	packageKey,
} from "@sfly/orchestration";
import type { OrchestrationDocument } from "@sfly/schema";
import type { PackageRepository } from "../packages/package-repository.js";

/** 开发版本只在本地开发模式的 Agent 上存在，控制面不知道它的元信息，跳过相关检查。 */
const DEV_VERSION = "dev";

/** 文档锁定的节点包版本的元信息（不存在的版本为 null）。 */
export async function packageCatalogFor(
	doc: OrchestrationDocument,
	packages: PackageRepository,
): Promise<PackageCatalog> {
	const catalog = new Map<string, readonly NodeTypeIo[] | null>();
	for (const [name, version] of Object.entries(doc.packages)) {
		if (version === DEV_VERSION) continue;
		const found = await packages.getVersion(name, version);
		catalog.set(packageKey(name, version), found ? found.metadata.nodes : null);
	}
	return catalog;
}

/** 文档的全部静态检查（结构、包版本锁定、引用），规则与画布共用（@sfly/orchestration）。 */
export async function checkDocument(
	doc: OrchestrationDocument,
	packages: PackageRepository,
): Promise<OrchestrationWarning[]> {
	return documentWarnings(doc, await packageCatalogFor(doc, packages));
}
