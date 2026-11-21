import { isDeepStrictEqual } from "node:util";
import type { NodeTypeIo } from "@sfly/orchestration";
import { IoSchema, type StoredOrchestrationDocument } from "@sfly/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "../db/database.js";
import { agents } from "../db/schema.js";
import { DEV_VERSION } from "../engine/assign-content.js";

/**
 * 开发版本（`包名@dev`，docs/SEMANTICS.md §7）的节点类型：在线的 Agent 以 `sfly dev` 加载源码时上报的元信息
 * （`GET /agents` 的 `dev_packages[].metadata`，命令行的 `sfly package show <包>@dev` 读的也是它），
 * 给保存时的静态检查和触发时的参数检查用，输入名、必填、类型都按它查，和已发布的版本一样。
 *
 * 取法（元信息没有经过发布校验，也可能过期，所以只在确定的时候用，不确定就当作不知道，相关检查跳过，和以前一样）：
 * - 只看在线的 Agent：不在线的 Agent 库里记着的是它上次连接时上报的，现在加载了什么控制面不知道
 *   （和触发前的 `dev_package_not_loaded` 同一个口径，dev-package-loaded.ts）；
 * - 同一个开发包加载在不止一台在线的 Agent 上、上报的节点类型不一样（例如一台上是旧源码）：不知道节点会落在哪一份上，
 *   不检查，不猜；内容相同才用；
 * - 上报的内容不是合法的节点类型（缺字段、输入不是 JSON Schema 对象）：不检查。
 * 只读文档里锁定了开发版本的包；没有锁定时不读库。
 */
const ReportedNodeTypes = z.array(
	z.looseObject({
		name: z.string(),
		inputs: IoSchema,
		outputs: IoSchema,
		description: z.string().optional(),
	}),
);

export async function devNodeTypes(
	db: Db | Tx,
	doc: StoredOrchestrationDocument,
): Promise<Map<string, readonly NodeTypeIo[]>> {
	const wanted = Object.entries(doc.packages)
		.filter(([, version]) => version === DEV_VERSION)
		.map(([name]) => name);
	const known = new Map<string, readonly NodeTypeIo[]>();
	if (wanted.length === 0) return known;
	const online = await db
		.select({ info: agents.info })
		.from(agents)
		.where(eq(agents.status, "online"));
	for (const name of wanted) {
		const reported = online.flatMap((agent) => {
			const found = agent.info.dev_packages?.find((p) => p.name === name);
			return found ? [found.metadata?.nodes] : [];
		});
		const [first, ...rest] = reported.map((nodes) => ReportedNodeTypes.safeParse(nodes));
		if (!first?.success || !rest.every((r) => r.success && isDeepStrictEqual(r.data, first.data))) {
			continue;
		}
		known.set(name, first.data as NodeTypeIo[]);
	}
	return known;
}
