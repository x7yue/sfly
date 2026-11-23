import {
	type AgentDevReport,
	devPackageTargets,
	type NodeTypeIo,
	devNodeTypes as pickDevNodeTypes,
} from "@sfly/orchestration";
import type { StoredOrchestrationDocument } from "@sfly/schema";
import { agentsInProject } from "../agents/project-agents.js";
import type { Db, Tx } from "../db/database.js";
import type { ProjectId } from "../projects/project-id.js";

/**
 * 开发版本（`包名@dev`，docs/SEMANTICS.md §7）的节点类型，给保存时的静态检查和触发时的参数检查用：节点派发到的 Agent 以
 * `sfly dev` 加载源码时上报的元信息（`GET /agents` 的 `dev_packages[].metadata`，命令行的 `sfly package show <包>@dev`
 * 读的也是它）。**取法（只看节点派发到的那几台、都在线都加载内容相同才用，其余当作不知道）是 `@sfly/orchestration` 里的纯函数
 * `devNodeTypes`，画布用的是同一个**：这里只负责把「文档里用到这个包的节点派发到的 Agent」的上报从库里读出来。
 * 没有锁定开发版本、或者没有节点用它时不读库。只看场景所在项目的 Agent（`agentsInProject`）：别的项目的 Agent
 * 和不存在一样，它上报的开发版本声明不会进检查的结果。
 */
export async function devNodeTypes(
	db: Db | Tx,
	project: ProjectId,
	doc: StoredOrchestrationDocument,
): Promise<Map<string, readonly NodeTypeIo[]>> {
	const names = new Set<string>();
	for (const targets of devPackageTargets(doc).values()) {
		for (const name of targets ?? []) names.add(name);
	}
	if (names.size === 0) return new Map();
	const rows = await agentsInProject(db, project, [...names]);
	const reports: AgentDevReport[] = rows.map((row) => ({
		name: row.name,
		online: row.status === "online",
		devPackages: new Map((row.info.dev_packages ?? []).map((p) => [p.name, p.metadata?.nodes])),
	}));
	return pickDevNodeTypes(doc, reports);
}
