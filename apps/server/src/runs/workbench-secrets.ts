// 带 secret 参数的任务不派到工作台（#497，ADR 0029「助手会话」）：派到哪台 Agent，原值就落在哪台的 task.json 里，工作台上助手的命令
// 读得到。只有勾选了「联调时可以使用项目密钥」的会话触发的运行放行（工作台属于运行所在的项目：任务只派给本项目的 Agent）。
import { nodeNameWithId, referencesIn } from "@sfly/orchestration";
import type { StoredOrchestrationDocument } from "@sfly/schema";
import { planRun } from "../engine/chain.js";
import type { PreflightProblem } from "./preflight.js";

export const SECRET_TASK_ON_WORKBENCH = "secret_task_on_workbench";

const WHY =
	"工作台上助手的命令读得到任务里的原值，所以人触发的运行、没勾选「联调时可以使用项目密钥」的会话触发的运行都不能把带 secret 值的任务派到工作台：把节点换到别的 Agent，或者由勾选了的会话触发";

/** 这次运行能不能把带 secret 值的任务派到工作台：勾选了「联调时可以使用项目密钥」的会话触发的才能。 */
export const allowsSecretsOnWorkbench = (run: {
	sessionId: string | null;
	secretsWithheld: boolean;
}): boolean => run.sessionId !== null && !run.secretsWithheld;

/**
 * 触发前能看出来的：派到工作台的包节点，输入里引用了本链入口声明为 secret 的参数（子流程入口声明的也算）。`agents` 是包节点 → 它派发到的
 * Agent（文档里写死的，引用入口参数的在派发时由 {@link workbenchDispatchProblem} 兜住）。经子流程的普通参数传进来的原值、上游节点
 * 输出里的原值要到派发时才知道。
 */
export function workbenchSecretProblems(
	doc: StoredOrchestrationDocument,
	agents: ReadonlyMap<string, string>,
	workbench: string,
): PreflightProblem[] {
	const plan = planRun(doc);
	if ("errors" in plan) return [];
	const problems: PreflightProblem[] = [];
	for (const chain of new Set([plan.main, ...plan.chains.values()])) {
		const secrets = new Set(chain.entry.params.filter((p) => p.secret).map((p) => p.name));
		for (const node of chain.nodes) {
			if (node.kind !== "package" || agents.get(node.id) !== workbench) continue;
			const used = Object.values(node.inputs)
				.flatMap(referencesIn)
				.flatMap((path) => {
					const name = path?.match(/^params\.([^.[]+)/)?.[1];
					return name !== undefined && secrets.has(name) ? [name] : [];
				});
			if (used.length === 0) continue;
			problems.push({
				code: SECRET_TASK_ON_WORKBENCH,
				message: `节点 ${nodeNameWithId(node)} 的输入引用了 secret 参数 ${[...new Set(used)].join("、")}，它派发到的 Agent ${workbench} 是这个项目的工作台。${WHY}`,
				node_id: node.id,
			});
		}
	}
	return problems;
}

/** 派发时发现输入里有原值（secret 参数、经子流程参数传进来的、上游节点的原样输出）、目标是工作台：任务以配置错误失败的说明。 */
export function workbenchDispatchProblem(shownNode: string, agent: string): string {
	return `节点 ${shownNode} 的输入里有 secret 值（来自 secret 参数、子流程的参数或上游节点的输出），它派发到的 Agent ${agent} 是这个项目的工作台。${WHY}`;
}
