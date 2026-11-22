// 任务凭据（ADR 0029「凭据」，规格 #492）：派发一次任务尝试时签发，随 AssignTask 下发，SDK 用它下载本项目任务的产物。
// 库里只存 SHA-256 哈希和展示用的前缀（`api_tokens`，种类 `task`，限本项目、属于这一次尝试 `task_id`，没有用户）。
// **有效期不靠逐处吊销**：它有没有效看这次尝试此刻的状态（{@link taskIsActive}）——还在 Agent 手上（派发中、执行中）才有效，
// 结束、被取消、租约过期（`agent_lost`）、重试（新的一次尝试是新的任务行、新的凭据）都自然失效，不会有哪条路径忘了吊销。
import { randomBytes, randomUUID } from "node:crypto";
import { TOKEN_PREFIXES } from "@sfly/schema";
import { hashCredential } from "../auth/credential-hash.js";
import type { Tx } from "../db/database.js";
import { apiTokens, ON_AGENT, type TaskStatus } from "../db/schema.js";
import type { ProjectId } from "../projects/project-id.js";

/** 任务凭据有效的任务状态：还在 Agent 手上（派发中、执行中……）。 */
export const taskIsActive = (status: TaskStatus): boolean =>
	(ON_AGENT as readonly TaskStatus[]).includes(status);

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
