import {
	applyEditOperations,
	compareVersions,
	type EditContext,
	type NodeTypeIo,
	newestVersion,
	packageKey,
} from "@sfly/orchestration";
import {
	type EditOperation,
	type EditOperationProblem,
	OrchestrationDocument,
	removedNodesIn,
	removedNodesMessage,
	type StoredOrchestrationDocument,
} from "@sfly/schema";
import { asc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "../db/database.js";
import { agents, nodePackages, orchestrations as orchestrationRows } from "../db/schema.js";
import { DEV_VERSION } from "../engine/assign-content.js";
import { findPackageVersion } from "../packages/package-repository.js";
import { readableProjects } from "../projects/project-id.js";
import type { OrchestrationStore, VersionSummary } from "./orchestration-store.js";

/**
 * 场景的局部编辑（#470）在控制面这一侧：读最新版本（打码的，secret 参数的默认值是占位符），把操作作用上去
 * （@sfly/orchestration 的 applyEditOperations），再按场景文档的 schema 解析。之后交给保存（saveVersion）或检查（checkVersion），
 * 和整份文档保存走同一条路：占位符换回原值、补坐标、同一组警告。
 */

export type PreparedEdits =
	| {
			kind: "edited";
			/** 作用了操作之后的文档：交给保存或检查。 */
			document: OrchestrationDocument;
			/** 作用操作之前的最新版本（打码的），算差异用。 */
			before: StoredOrchestrationDocument;
			/** 最新版本号：保存时的 base_version。 */
			base: number;
	  }
	| { kind: "not_found" }
	| { kind: "conflict"; head: VersionSummary | null }
	| { kind: "invalid_operation"; problem: EditOperationProblem }
	| { kind: "invalid_document"; message: string; issues: z.core.$ZodIssue[] };

export async function prepareEdits(
	db: Db,
	orchestrations: OrchestrationStore,
	orchestrationId: string,
	operations: readonly EditOperation[],
	baseVersion: number | undefined,
): Promise<PreparedEdits> {
	const head = await orchestrations.head(orchestrationId);
	if (!head) return { kind: "not_found" };
	if (baseVersion !== undefined && baseVersion !== head.number) {
		return {
			kind: "conflict",
			head:
				head.number > 0 && head.author !== null && head.created_at !== null
					? {
							number: head.number,
							author: head.author,
							author_via: head.author_via,
							created_at: head.created_at,
						}
					: null,
		};
	}
	const outcome = applyEditOperations(
		head.document,
		operations,
		await editContext(db, orchestrationId, head.document, operations),
	);
	if (!outcome.ok) return { kind: "invalid_operation", problem: outcome.problem };
	const parsed = OrchestrationDocument.safeParse(outcome.doc);
	if (!parsed.success) {
		const removed = removedNodesIn(outcome.doc);
		const issues = parsed.error.issues.map((i) => ({ ...i, path: ["document", ...i.path] }));
		const summary = issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；");
		return {
			kind: "invalid_document",
			message:
				removed.length > 0 ? removedNodesMessage(removed) : `编辑之后的场景文档不合法：${summary}`,
			issues,
		};
	}
	return { kind: "edited", document: parsed.data, before: head.document, base: head.number };
}

/** 开发包的元信息（Agent 上报的，没有经过发布时的校验）里的节点类型；读不出来时 undefined。 */
function devNodeTypes(metadata: Record<string, unknown> | null): NodeTypeIo[] | undefined {
	const nodes = metadata?.nodes;
	if (!Array.isArray(nodes)) return undefined;
	const valid = nodes.every(
		(n) =>
			typeof n === "object" &&
			n !== null &&
			typeof n.name === "string" &&
			typeof n.inputs === "object" &&
			n.inputs !== null &&
			typeof n.inputs.properties === "object",
	);
	return valid ? (nodes as NodeTypeIo[]) : undefined;
}

/**
 * 加节点要用到的节点包信息：文档里锁定的包和操作里提到的包，各自已发布的版本（最新的那个是默认版本）和用到的版本的节点类型。
 * 开发版本的节点类型取在线的 Agent 上报的（按 Agent 名称取第一台；画布上的添加节点菜单也是这样）；没有在线的 Agent 加载时不知道。
 */
async function editContext(
	db: Db,
	orchestrationId: string,
	doc: StoredOrchestrationDocument,
	operations: readonly EditOperation[],
): Promise<EditContext> {
	const [scenario] = await db
		.select({ projectId: orchestrationRows.projectId })
		.from(orchestrationRows)
		.where(eq(orchestrationRows.id, orchestrationId));
	const projects = scenario ? readableProjects(scenario.projectId) : [];
	const adds = operations.flatMap((op) => (op.op === "add_node" ? [op] : []));
	const names = new Set([...Object.keys(doc.packages), ...adds.map((op) => op.package)]);
	const dev = new Map<string, NodeTypeIo[] | undefined>();
	const online = await db
		.select({ info: agents.info, projectId: agents.projectId })
		.from(agents)
		.where(eq(agents.status, "online"))
		.orderBy(asc(agents.name));
	// 包名写错时只从这个场景读得到的包里找相近的（本项目的、公共项目的；开发版本只看本项目的 Agent），不列出别的项目的包名。
	const devHere = new Set<string>();
	for (const { info, projectId } of online) {
		for (const p of info.dev_packages ?? []) {
			if (!dev.has(p.name)) dev.set(p.name, devNodeTypes(p.metadata));
			if (projects.includes(projectId)) devHere.add(p.name);
		}
	}
	// 这个场景读得到的已发布版本（版本写错时列出来）：一次读完，行数是已发布的版本数。
	const releases = new Map<string, string[]>();
	for (const row of await db
		.select({ name: nodePackages.name, version: nodePackages.version })
		.from(nodePackages)
		.where(inArray(nodePackages.projectId, projects))) {
		releases.set(row.name, [...(releases.get(row.name) ?? []), row.version]);
	}
	for (const versions of releases.values()) versions.sort((a, b) => compareVersions(b, a));
	const catalog = new Map<string, readonly NodeTypeIo[] | null>();
	const defaults = new Map<string, string | undefined>();
	for (const name of names) {
		// 默认版本和节点类型照旧按名字找（名字全局唯一，见 findPackageVersion）；只是线索按项目收窄。
		const published = (
			await db
				.select({ version: nodePackages.version })
				.from(nodePackages)
				.where(eq(nodePackages.name, name))
		).map((r) => r.version);
		const fallback = newestVersion(published) ?? (dev.has(name) ? DEV_VERSION : undefined);
		defaults.set(name, fallback);
		const wanted = new Set(
			[
				doc.packages[name],
				fallback,
				...adds.filter((op) => op.package === name).map((op) => op.version),
			].filter((v): v is string => v !== undefined),
		);
		for (const version of wanted) {
			if (version === DEV_VERSION) {
				const types = dev.get(name);
				if (types) catalog.set(packageKey(name, version), types);
				continue;
			}
			const found = published.includes(version)
				? await findPackageVersion(db, name, version)
				: undefined;
			catalog.set(packageKey(name, version), found ? found.metadata.nodes : null);
		}
	}
	return {
		catalog,
		defaultVersion: (name) => defaults.get(name),
		packageNames: [...new Set([...releases.keys(), ...devHere])].sort(),
		publishedVersions: (name) => releases.get(name) ?? [],
	};
}
