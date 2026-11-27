import {
	documentWarnings,
	type NodeTypeIo,
	type OrchestrationWarning,
	type PackageCatalog,
	packageKey,
} from "@sfly/orchestration";
import { DEV_VERSION, type StoredOrchestrationDocument } from "@sfly/schema";
import { agentsInProject } from "../agents/project-agents.js";
import type { Db, Tx } from "../db/database.js";
import { registeredBots } from "../feishu/bot-checks.js";
import { findPackageVersion } from "../packages/package-repository.js";
import type { ProjectId } from "../projects/project-id.js";
import { devNodeTypes } from "./dev-node-types.js";

/**
 * 文档锁定的节点包版本的元信息（不存在的版本为 null）。一个版本一个版本地读：`db` 可能是事务对象。
 * 已发布的包按场景所在的项目找：本项目发布的和公共项目里的，别的项目里发布的和不存在一样。
 * 开发版本取节点派发到的 Agent 上报的元信息（{@link devNodeTypes}，只看本项目的 Agent）；
 * 不知道它的节点类型时没有这一项，相关检查跳过。
 */
export async function packageCatalogFor(
	db: Db | Tx,
	project: ProjectId,
	doc: StoredOrchestrationDocument,
	session: string | null,
): Promise<PackageCatalog> {
	const catalog = new Map<string, readonly NodeTypeIo[] | null>();
	for (const [name, version] of Object.entries(doc.packages)) {
		if (version === DEV_VERSION) continue;
		const found = await findPackageVersion(db, project, name, version, { session });
		catalog.set(packageKey(name, version), found ? found.metadata.nodes : null);
	}
	for (const [name, nodes] of await devNodeTypes(db, project, doc)) {
		catalog.set(packageKey(name, DEV_VERSION), nodes);
	}
	return catalog;
}

/** 这个项目里注册过的全部 Agent（不论是否在线）：别的项目的 Agent 和没有注册过一样。 */
export async function registeredAgents(db: Db | Tx, project: ProjectId): Promise<Set<string>> {
	return new Set((await agentsInProject(db, project)).map((r) => r.name));
}

/**
 * 文档的全部静态检查（结构、包版本锁定、引用、输入，「Agent」类型的输入选的是已注册的 Agent，
 * 「飞书机器人」类型的输入选的是已登记的飞书机器人，没有已移除种类的节点），规则与画布共用（@sfly/orchestration）。
 * `project` 是场景所在的项目：包和 Agent 都只在它的范围里找（包还有公共项目的）。`session` 是这份文档（场景版本）属于的会话：
 * 锁定的会话构建只在是这个会话的、会话没结束时找得到（#795，`BuildScope`）；不属于会话的是 null。
 * `db` 由调用方传：在事务里检查时传事务对象。查询一条接一条地执行（同一个事务的连接上不并发查询）。
 */
export async function checkDocument(
	db: Db | Tx,
	project: ProjectId,
	doc: StoredOrchestrationDocument,
	session: string | null,
): Promise<OrchestrationWarning[]> {
	const catalog = await packageCatalogFor(db, project, doc, session);
	const registered = await registeredAgents(db, project);
	const bots = await registeredBots(db, project);
	return documentWarnings(doc, catalog, { agents: registered, feishuBots: bots });
}
