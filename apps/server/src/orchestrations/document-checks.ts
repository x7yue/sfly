import {
	documentWarnings,
	type NodeTypeIo,
	type OrchestrationWarning,
	type PackageCatalog,
	packageKey,
} from "@sfly/orchestration";
import { DEV_VERSION, type StoredOrchestrationDocument } from "@sfly/schema";
import type { Db, Tx } from "../db/database.js";
import { agents, feishuBots } from "../db/schema.js";
import { findPackageVersion } from "../packages/package-repository.js";
import { devNodeTypes } from "./dev-node-types.js";

/**
 * 文档锁定的节点包版本的元信息（不存在的版本为 null）。一个版本一个版本地读：`db` 可能是事务对象。
 * 开发版本取节点派发到的 Agent 上报的元信息（{@link devNodeTypes}）；不知道它的节点类型时没有这一项，相关检查跳过。
 */
export async function packageCatalogFor(
	db: Db | Tx,
	doc: StoredOrchestrationDocument,
): Promise<PackageCatalog> {
	const catalog = new Map<string, readonly NodeTypeIo[] | null>();
	for (const [name, version] of Object.entries(doc.packages)) {
		if (version === DEV_VERSION) continue;
		const found = await findPackageVersion(db, name, version);
		catalog.set(packageKey(name, version), found ? found.metadata.nodes : null);
	}
	for (const [name, nodes] of await devNodeTypes(db, doc)) {
		catalog.set(packageKey(name, DEV_VERSION), nodes);
	}
	return catalog;
}

/** 注册过的全部 Agent（不论是否在线）。 */
export async function registeredAgents(db: Db | Tx): Promise<Set<string>> {
	return new Set((await db.select({ name: agents.name }).from(agents)).map((r) => r.name));
}

/** 已登记的全部飞书机器人（名称）。 */
export async function registeredFeishuBots(db: Db | Tx): Promise<Set<string>> {
	return new Set((await db.select({ name: feishuBots.name }).from(feishuBots)).map((r) => r.name));
}

/**
 * 文档的全部静态检查（结构、包版本锁定、引用、输入，「Agent」类型的输入选的是已注册的 Agent，
 * 「飞书机器人」类型的输入选的是已登记的飞书机器人，没有已移除种类的节点），规则与画布共用（@sfly/orchestration）。
 * `db` 由调用方传：在事务里检查时传事务对象。查询一条接一条地执行（同一个事务的连接上不并发查询）。
 */
export async function checkDocument(
	db: Db | Tx,
	doc: StoredOrchestrationDocument,
): Promise<OrchestrationWarning[]> {
	const catalog = await packageCatalogFor(db, doc);
	const registered = await registeredAgents(db);
	const bots = await registeredFeishuBots(db);
	return documentWarnings(doc, catalog, { agents: registered, feishuBots: bots });
}
