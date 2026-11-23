import { effectiveTimeout } from "@sfly/orchestration";
import type { StoredOrchestrationDocument } from "@sfly/schema";
import type { Db, Tx } from "../db/database.js";
import { nodeTypeOf } from "../metrics/node-types.js";
import type { ProjectId } from "../projects/project-id.js";

/** 用了平台默认的超时而超时失败时，接在 Agent 报的错误信息后面的一句（docs/SEMANTICS.md §3.3，#476）。 */
export const PLATFORM_TIMEOUT_HINT =
	"节点和节点类型都没有设置超时，用的是平台默认的 1 小时；长时间运行的节点在 `@node(timeout=…)` 里声明，或在场景里给这个节点设超时。";

/**
 * 节点超时失败时错误信息后面要补的一句：节点和节点类型都没有设置超时、用的是平台默认的才有，否则是空串。
 * 派发时没有把超时的来源记在任务上，这里按派发时同一个顺序重新取一次（锁定的节点包版本不会变；开发版本取任务所在 Agent
 * 当前加载的源码）。找不到节点类型时不知道它有没有声明超时，不补，免得说错。
 */
export async function platformTimeoutHint(
	db: Db | Tx,
	project: ProjectId,
	document: StoredOrchestrationDocument,
	nodeId: string,
	agentName: string | null,
): Promise<string> {
	const node = document.nodes.find((n) => n.id === nodeId);
	if (node?.kind !== "package") return "";
	const ref = await nodeTypeOf(db, project, document, nodeId, agentName);
	if (!ref?.type) return "";
	return effectiveTimeout(node, ref.type).source === "platform" ? PLATFORM_TIMEOUT_HINT : "";
}
