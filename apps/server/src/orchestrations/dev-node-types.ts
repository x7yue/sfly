import { isDeepStrictEqual } from "node:util";
import type { NodeTypeIo } from "@sfly/orchestration";
import { IoSchema, type StoredOrchestrationDocument } from "@sfly/schema";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "../db/database.js";
import { agents } from "../db/schema.js";
import { DEV_VERSION } from "../engine/assign-content.js";
import { agentFor } from "../engine/chain.js";

/**
 * 开发版本（`包名@dev`，docs/SEMANTICS.md §7）的节点类型：节点派发到的 Agent 以 `sfly dev` 加载源码时上报的元信息
 * （`GET /agents` 的 `dev_packages[].metadata`，命令行的 `sfly package show <包>@dev` 读的也是它），
 * 给保存时的静态检查和触发时的参数检查用，输入名、必填、类型都按它查，和已发布的版本一样。
 *
 * 取法（元信息没有经过发布校验，也可能过期，所以只在确定的时候用，不确定就当作不知道，相关检查跳过，和以前一样）：
 * - **只看用到这个包的节点实际派发到的 Agent**（`agentFor`：节点另选的 Agent，没有就用编排的默认 Agent）：
 *   派发时、`dev_package_not_loaded` 都按这台查（assign-content.ts、dev-package-loaded.ts），别的在线 Agent 上加载的是
 *   旧源码还是新源码，和这个节点跑在哪里无关；
 * - 这几台必须都在线（不在线的 Agent 库里记着的是它上次连接时上报的，现在加载了什么控制面不知道，
 *   和 `dev_package_not_loaded` 同一个口径）、都加载了这个包、上报的节点类型内容相同；有一台不满足就不检查，不猜，
 *   触发照常，交给运行时（目标上线后加载的是什么，运行时才知道）；
 * - 上报的内容不是合法的节点类型（缺字段、输入不是 JSON Schema 对象）：不检查。
 * 只读文档里锁定了开发版本的包；没有锁定、锁定了但没有节点用它时不读库。
 */
const ReportedNodeTypes = z.array(
	z.looseObject({
		name: z.string(),
		inputs: IoSchema,
		outputs: IoSchema,
		description: z.string().optional(),
	}),
);

/** 锁定开发版本的包名 → 用到它的包节点派发到的 Agent 名称（节点没有确定的 Agent 时，这个包不检查）。 */
function dispatchTargets(doc: StoredOrchestrationDocument): Map<string, Set<string> | null> {
	const targets = new Map<string, Set<string> | null>();
	for (const node of doc.nodes) {
		if (node.kind !== "package" || doc.packages[node.package] !== DEV_VERSION) continue;
		const agent: string | undefined = agentFor(doc, node);
		const known = targets.get(node.package);
		if (known === null) continue;
		if (!agent) {
			targets.set(node.package, null);
			continue;
		}
		if (known === undefined) targets.set(node.package, new Set([agent]));
		else known.add(agent);
	}
	return targets;
}

export async function devNodeTypes(
	db: Db | Tx,
	doc: StoredOrchestrationDocument,
): Promise<Map<string, readonly NodeTypeIo[]>> {
	const known = new Map<string, readonly NodeTypeIo[]>();
	const targets = dispatchTargets(doc);
	const names = [
		...new Set([...targets.values()].flatMap((agents) => (agents ? [...agents] : []))),
	];
	if (names.length === 0) return known;
	const online = new Map(
		(
			await db
				.select({ name: agents.name, info: agents.info })
				.from(agents)
				.where(and(eq(agents.status, "online"), inArray(agents.name, names)))
		).map((agent) => [agent.name, agent.info]),
	);
	for (const [pkg, agentNames] of targets) {
		if (agentNames === null) continue;
		const parsed = [...agentNames].map((name) => {
			const found = online.get(name)?.dev_packages?.find((p) => p.name === pkg);
			return found === undefined ? undefined : ReportedNodeTypes.safeParse(found.metadata?.nodes);
		});
		const [first] = parsed;
		if (
			!first?.success ||
			!parsed.every((r) => r?.success && isDeepStrictEqual(r.data, first.data))
		) {
			continue;
		}
		known.set(pkg, first.data as NodeTypeIo[]);
	}
	return known;
}
