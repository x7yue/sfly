import {
	documentWarnings,
	type NodeTypeIo,
	type OrchestrationWarning,
	type PackageCatalog,
	packageKey,
} from "@sfly/orchestration";
import type { OrchestrationDocument } from "@sfly/schema";
import type { Db } from "../db/database.js";
import { agents } from "../db/schema.js";
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

/** 注册过的全部 Agent（不论是否在线）。 */
export async function registeredAgents(db: Db): Promise<Set<string>> {
	return new Set((await db.select({ name: agents.name }).from(agents)).map((r) => r.name));
}

/**
 * 文档的全部静态检查（结构、包版本锁定、引用、输入，「Agent」类型的输入选的是已注册的 Agent），
 * 规则与画布共用（@sfly/orchestration）。
 */
export async function checkDocument(
	doc: OrchestrationDocument,
	deps: { db: Db; packages: PackageRepository },
): Promise<OrchestrationWarning[]> {
	const [catalog, registered] = await Promise.all([
		packageCatalogFor(doc, deps.packages),
		registeredAgents(deps.db),
	]);
	return documentWarnings(doc, catalog, { agents: registered });
}
