import { nodeNameWithId } from "@sfly/orchestration";
import type { StoredOrchestrationDocument } from "@sfly/schema";
import { eq } from "drizzle-orm";
import type { Db, Tx } from "../db/database.js";
import { agents } from "../db/schema.js";
import { DEV_VERSION } from "../engine/assign-content.js";
import { agentFor } from "../engine/chain.js";
import type { PreflightProblem } from "./preflight.js";

/** 「已经加载它的 Agent」最多列出几台，多出来的写台数。 */
const LISTED_LOADERS = 5;

/**
 * 在线的 Agent 以开发模式（`sfly dev`）加载的节点包：Agent 名称 → 包名。
 * 不在线的 Agent 不在里面：库里记着的是它上次连接时上报的，现在它重新连上、或者重启之后加载了什么，控制面不知道。
 */
export type LoadedDevPackages = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * 锁定开发版本（`包名@dev`，docs/SEMANTICS.md §7 第 3 条）的节点，派发到的 Agent 必须已经加载了这个包：
 * 没有加载时任务到了那个 Agent 上只会以 env_error 失败，场景要跑到那个节点才知道，所以触发前就阻断。
 * 只判断在线的 Agent：不在线的、没有注册过的 Agent 不知道它加载了什么，按离线的规则排队、
 * 没有注册过的由 `agent_not_registered` 指出，这里都不另外阻断。
 * 每个没有加载的节点一条，并写明哪台在线的 Agent 已经加载了同一个包。
 */
export function devPackageProblems(
	doc: StoredOrchestrationDocument,
	loaded: LoadedDevPackages,
): PreflightProblem[] {
	const problems: PreflightProblem[] = [];
	for (const node of doc.nodes) {
		if (node.kind !== "package" || doc.packages[node.package] !== DEV_VERSION) continue;
		const agent = agentFor(doc, node);
		const here = loaded.get(agent);
		if (here === undefined || here.has(node.package)) continue;
		const others = [...loaded]
			.filter(([name, packages]) => name !== agent && packages.has(node.package))
			.map(([name]) => name)
			.sort();
		const listed = others.slice(0, LISTED_LOADERS).join("、");
		const alternative =
			others.length === 0
				? ""
				: `，或者把这个节点的 Agent 改成已经加载它的 ${listed}${
						others.length > LISTED_LOADERS ? ` 等 ${others.length} 台` : ""
					}`;
		problems.push({
			code: "dev_package_not_loaded",
			message: `节点 ${nodeNameWithId(node)} 用的是开发版本 ${node.package}@${DEV_VERSION}，但它派发到的 Agent ${agent} 没有加载：在 ${agent} 所在的机器上、节点包源码目录下运行 sfly dev 加载它${alternative}`,
			node_id: node.id,
		});
	}
	return problems;
}

/** 在线的 Agent 当前加载的开发版本（读库一次）；文档没有锁定开发版本时不读。 */
async function loadedDevPackages(db: Db | Tx): Promise<Map<string, Set<string>>> {
	const rows = await db
		.select({ name: agents.name, info: agents.info })
		.from(agents)
		.where(eq(agents.status, "online"));
	return new Map(
		rows.map((r) => [r.name, new Set((r.info.dev_packages ?? []).map((p) => p.name))]),
	);
}

/** {@link devPackageProblems}：读在线 Agent 的开发版本。`db` 由调用方传，触发准入在事务里传事务对象。 */
export async function checkDevPackagesLoaded(
	db: Db | Tx,
	doc: StoredOrchestrationDocument,
): Promise<PreflightProblem[]> {
	if (!Object.values(doc.packages).includes(DEV_VERSION)) return [];
	return devPackageProblems(doc, await loadedDevPackages(db));
}
