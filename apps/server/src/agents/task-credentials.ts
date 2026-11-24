// 任务凭据（ADR 0029「凭据」，规格 #492）：派发一次任务尝试时签发，随 AssignTask 下发，SDK 用它下载本项目任务的产物。
// 库里只存 SHA-256 哈希和展示用的前缀（`api_tokens`，种类 `task`，限本项目、属于这一次尝试 `task_id`，没有用户）。
// **有效期不靠逐处吊销**：它有没有效看这次尝试此刻的状态（{@link taskIsActive}）——还在 Agent 手上（派发中、执行中）才有效，
// 结束、被取消、租约过期（`agent_lost`）、重试（新的一次尝试是新的任务行、新的凭据）都自然失效，不会有哪条路径忘了吊销；
// Agent 被停用、派发时这条连接用的那个 Agent 凭据被吊销之后立刻不认（同一处判断，不等租约过期）。
// **任务凭据跟着派发时连接用的那一个 Agent 凭据走**（`api_tokens.agent_credential_id`），不看「这个名字此刻有没有别的有效凭据」：
// 看后者的话，凭据外泄之后「全部吊销、再给真的那台签发新的」会让外泄出去的任务凭据又被认回来（新签发的凭据让「有凭据」重新成立），
// 别的项目给同名的 Agent 签发过的凭据也会让它在吊销之后照样被认。轮换（先签发新的、Agent 用新的重连、再吊销旧的）时，旧连接上
// 派发的任务凭据在旧凭据被吊销后不再被认（旧连接随吊销断开，手上的任务走租约过期的 `agent_lost` 和重试），新连接上派发的不受影响。
// 以旧方式（共享令牌、没有凭据）连接的 Agent 的任务凭据不记凭据，只看停用。
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
 * 停用 Agent、吊销派发时这条连接用的那个 Agent 凭据（连着的连接随之断开）之后，它手上任务的凭据立刻不认，不等租约过期：
 * 执行器那边的进程拿着它，不该在这段时间里还能下载产物。`agent` 是这次尝试所在的 Agent 和派发时连接用的凭据此刻的状态：
 * Agent 停用了、那个凭据被吊销了，都算失效；派发时连接用的是旧方式（没有记凭据）的只看停用。
 * 所属用户被停用的开发 Agent（凭据没有吊销，连接在用户停用的那一刻断开）不在这里：它的任务照常等租约过期。
 */
export const taskIsActive = (
	status: TaskStatus,
	agent: { agentDisabled: boolean; credentialRevoked: boolean } = {
		agentDisabled: false,
		credentialRevoked: false,
	},
): boolean =>
	(ON_AGENT as readonly TaskStatus[]).includes(status) &&
	!agent.agentDisabled &&
	!agent.credentialRevoked;

/**
 * 为一次任务尝试签发凭据（在派发的事务里）；返回原值，只随这条派发消息出去一次。`agentCredentialId` 是派发时这条连接用的
 * Agent 凭据（连接用旧方式时为 null）：任务凭据只在它没被吊销时有效。
 */
export async function mintTaskCredential(
	tx: Tx,
	task: { id: string; projectId: ProjectId },
	agentCredentialId: string | null,
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
		agentCredentialId,
		scopes: [],
		createdAt: now,
	});
	return token;
}
