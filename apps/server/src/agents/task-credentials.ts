// 任务凭据（ADR 0029「凭据」，规格 #492）：派发一次任务尝试时签发，随 AssignTask 下发，SDK 用它下载本项目任务的产物。
// 库里只存 SHA-256 哈希和展示用的前缀（`api_tokens`，种类 `task`，限本项目、属于这一次尝试 `task_id`，没有用户）。
// **有效期不靠逐处吊销**：它有没有效看这次尝试此刻的状态（{@link taskIsActive}）——还在 Agent 手上（派发中、执行中）才有效，
// 结束、被取消、租约过期（`agent_lost`）、重试（新的一次尝试是新的任务行、新的凭据）都自然失效，不会有哪条路径忘了吊销；
// Agent 被停用、它的 Agent 凭据被吊销之后立刻不认（同一处判断，不等租约过期）。
// 为什么按状态失效、不在尝试结束时删掉这一行：删除要每条结束路径（成功、失败、取消、租约过期、重试、重启恢复）都记得做，漏一处
// 就是一把还能用的凭据；按状态判断没有「忘了」这一说，库里的行留到保留期随运行一起清理（`retention.ts`）。
// 代价在令牌表的索引上（#487 的审查建议「尝试结束时直接删掉任务凭据，按项目的索引只收项目令牌」）：每次派发多一行，
// `api_tokens_project`（项目令牌的列表和吊销按它查）里也多一条，一个项目有多少任务尝试就多多少条，随保留期清理；
// 这些查询是管理面上很少用的，多扫一些索引项可以接受；每个请求认凭据用的是哈希上的唯一索引，不受影响。
// 没有改这个索引：要收紧就是把它改成 `where kind = 'project'` 的部分索引，是一条迁移，和这个 PR 的主题无关，单独做。
import { randomBytes, randomUUID } from "node:crypto";
import { TOKEN_PREFIXES } from "@sfly/schema";
import { hashCredential } from "../auth/credential-hash.js";
import type { Tx } from "../db/database.js";
import { apiTokens, ON_AGENT, type TaskStatus } from "../db/schema.js";
import type { ProjectId } from "../projects/project-id.js";

/**
 * 任务凭据此刻有没有效：这次尝试还在 Agent 手上（派发中、执行中……），**并且这台 Agent 没有被停用、没有被取消凭据**——
 * 停用 Agent、吊销它的 Agent 凭据（连着的连接随之断开）之后，它手上任务的凭据立刻不认，不等租约过期：
 * 执行器那边的进程拿着它，不该在这段时间里还能下载产物。`agent` 是这次尝试所在的 Agent 此刻的状态：
 * 停用了、最近一次连接用的是 Agent 凭据而它的凭据已经全部吊销了，都算失效；以旧方式连接的 Agent 只看停用。
 * 所属用户被停用的开发 Agent（凭据没有吊销，连接在用户停用的那一刻断开）不在这里：它的任务照常等租约过期。
 */
export const taskIsActive = (
	status: TaskStatus,
	agent: { agentDisabled: boolean; agentOnCredentials: boolean; agentHasCredential: boolean } = {
		agentDisabled: false,
		agentOnCredentials: false,
		agentHasCredential: true,
	},
): boolean =>
	(ON_AGENT as readonly TaskStatus[]).includes(status) &&
	!agent.agentDisabled &&
	(!agent.agentOnCredentials || agent.agentHasCredential);

/** 为一次任务尝试签发凭据（在派发的事务里）；返回原值，只随这条派发消息出去一次。 */
export async function mintTaskCredential(
	tx: Tx,
	task: { id: string; projectId: ProjectId },
	now: Date,
): Promise<string> {
	const token = `${TOKEN_PREFIXES.task}${randomBytes(24).toString("hex")}`;
	await tx.insert(apiTokens).values({
		id: randomUUID(),
		kind: "task",
		name: `任务 ${task.id.slice(0, 8)}`,
		prefix: token.slice(0, 13),
		tokenHash: hashCredential(token),
		projectId: task.projectId,
		taskId: task.id,
		scopes: [],
		createdAt: now,
	});
	return token;
}
