import {
	type AgentDevReport,
	applyEditOperations,
	compareReleases,
	type EditContext,
	type NodeTypeIo,
	newestVersion,
	packageKey,
	devNodeTypes as pickDevNodeTypes,
} from "@sfly/orchestration";
import {
	DEV_VERSION,
	type EditOperation,
	type EditOperationProblem,
	OrchestrationDocument,
	removedNodesIn,
	removedNodesMessage,
	type StoredOrchestrationDocument,
} from "@sfly/schema";
import { inArray } from "drizzle-orm";
import type { z } from "zod";
import { agentsInProject } from "../agents/project-agents.js";
import type { Db } from "../db/database.js";
import { nodePackages } from "../db/schema.js";
import { findPackageVersion } from "../packages/package-repository.js";
import { type ProjectId, readableProjects } from "../projects/project-id.js";
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
	const project = await orchestrations.projectOf(orchestrationId);
	if (!head || project === undefined) return { kind: "not_found" };
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
		await editContext(db, project, head.document, operations),
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

/**
 * 加节点要用到的节点包信息：文档里锁定的包和操作里提到的包，各自已发布的版本（最新的那个是默认版本）和用到的版本的节点类型。
 * 开发版本的节点类型和保存时的检查（document-checks.ts）、画布同一套取法（`@sfly/orchestration` 的 `devNodeTypes`）：
 * 只看用到这个包的节点派发到的 Agent——文档里已有的节点，加上这组操作加的节点和改了 Agent 的节点——都在线、都加载了、
 * 内容相同才用，否则当作不知道（相关检查跳过）。只看这个场景所在项目的 Agent：别的项目的 Agent 上报的东西不进报错。
 */
async function editContext(
	db: Db,
	project: ProjectId,
	doc: StoredOrchestrationDocument,
	operations: readonly EditOperation[],
): Promise<EditContext> {
	const projects = readableProjects(project);
	const adds = operations.flatMap((op) => (op.op === "add_node" ? [op] : []));
	const names = new Set([...Object.keys(doc.packages), ...adds.map((op) => op.package)]);
	const projectAgents = await agentsInProject(db, project);
	const reports: AgentDevReport[] = projectAgents.map((row) => ({
		name: row.name,
		online: row.status === "online",
		devPackages: new Map((row.info.dev_packages ?? []).map((p) => [p.name, p.metadata?.nodes])),
	}));
	// 本项目在线的 Agent 加载着的开发包：没锁定时默认用 dev 的依据，也是包名写错时的线索（不列出别的项目的包名）。
	const devHere = new Set(
		reports.filter((r) => r.online).flatMap((r) => [...r.devPackages.keys()]),
	);
	// 这个场景读得到的已发布版本（版本写错时列出来）：一次读完，行数是已发布的版本数。
	const releases = new Map<string, string[]>();
	for (const row of await db
		.select({ name: nodePackages.name, version: nodePackages.version })
		.from(nodePackages)
		.where(inArray(nodePackages.projectId, projects))) {
		releases.set(row.name, [...(releases.get(row.name) ?? []), row.version]);
	}
	for (const versions of releases.values()) versions.sort((a, b) => compareReleases(b, a));
	const devTypes = pickDevNodeTypes(dispatchView(doc, operations), reports);
	const catalog = new Map<string, readonly NodeTypeIo[] | null>();
	const defaults = new Map<string, string | undefined>();
	for (const name of names) {
		// 默认版本、版本写错时的线索和节点类型都在这个场景读得到的范围里找（本项目的和公共项目的包），
		// 和保存时的检查（document-checks.ts）、预检是同一个范围（`findPackageVersion`）。
		const published = releases.get(name) ?? [];
		const fallback = newestVersion(published) ?? (devHere.has(name) ? DEV_VERSION : undefined);
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
				const types = devTypes.get(name);
				if (types) catalog.set(packageKey(name, version), types);
				continue;
			}
			const found = published.includes(version)
				? await findPackageVersion(db, project, name, version)
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

/**
 * 算开发版本的派发目标用的文档：每个包都当作锁定了开发版本（用不用 dev 由调用方按版本决定），节点是文档里已有的，
 * 加上这组操作要加的节点（`agent` 没写就用默认 Agent）和改了 Agent 的节点（改之前、改之后的 Agent 都算：
 * 两台的声明不一样时当作不知道；去掉 Agent 按默认 Agent 算；不写 ID 加的节点认不出，改它的 Agent 时算进每个
 * 不写 ID 加的包）。只用来定「派发到哪几台」，不保存。
 */
function dispatchView(
	doc: StoredOrchestrationDocument,
	operations: readonly EditOperation[],
): StoredOrchestrationDocument {
	type Dispatch = { kind: "package"; package: string; agent?: string };
	const nodes: Dispatch[] = doc.nodes.flatMap((n) =>
		n.kind === "package" ? [{ kind: "package", package: n.package, agent: n.agent }] : [],
	);
	// 节点 ID → 包名（已有的包节点，和这组操作里写了 ID 的新节点）：改 Agent 的操作要知道节点用的是哪个包。
	const packageOf = new Map<string, string>();
	for (const n of doc.nodes) if (n.kind === "package") packageOf.set(n.id, n.package);
	// 这组操作里不写 ID 加的节点的包：它们的 ID 应用操作时才生成，这里认不出。
	const unnamed = new Set<string>();
	const packages: Record<string, string> = {};
	for (const op of operations) {
		if (op.op === "add_node") {
			nodes.push({ kind: "package", package: op.package, agent: op.agent });
			if (op.id) packageOf.set(op.id, op.package);
			else unnamed.add(op.package);
		} else if (op.op === "set" && op.field === "agent") {
			// 不写值（或写 null）是去掉节点的 Agent：之后派到场景的默认 Agent（dispatchAgentOf 落到 default_agent）。
			const agent = typeof op.value === "string" ? op.value : undefined;
			// 认不出的节点可能是不写 ID 加的：新的 Agent 算进每个这样加的包。多算只会让检查更宽（几台声明不同时当作
			// 不知道），保存时的检查看的是改完之后的文档，兜得住。
			const pkg = packageOf.get(op.node);
			for (const p of pkg ? [pkg] : unnamed) nodes.push({ kind: "package", package: p, agent });
		}
	}
	for (const n of nodes) packages[n.package] = DEV_VERSION;
	return { ...doc, packages, nodes: nodes as never };
}
