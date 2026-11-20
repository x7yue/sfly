import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { hashCredential } from "../auth/credential-hash.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { agentCredentials } from "../db/schema.js";
import { DEFAULT_PROJECT } from "../projects/project-id.js";

/**
 * 控制面启动时：配了共享令牌（`SFLY_AGENT_TOKEN`）就把它的哈希登记成默认项目的旧式 Agent 凭据（不限名字），
 * #489 起据此认出它（ADR 0029「迁移与过渡」）；没配则不登记。可以重复执行，每次启动都执行一遍。
 * 环境变量是共享令牌的唯一来源：换了新的值，之前登记的那条随之删除（没有别的表引用它），旧值不会留在库里继续有效；
 * 之后又换回旧值，当作新登记一条。管理员吊销过的这一条（#492）不会因为重启又恢复有效：已经有这条记录就不再改它。
 * 目前没有任何检查读这张表：Hello 和上传产物照旧比较环境变量里的值（`agent-token.ts`）。
 */
export async function registerSharedAgentToken(
	db: Db,
	clock: Clock,
	token: string | undefined,
): Promise<void> {
	if (!token) return;
	const hash = hashCredential(token);
	const now = clock.now();
	await db.transaction(async (tx) => {
		await tx
			.delete(agentCredentials)
			.where(and(eq(agentCredentials.kind, "shared"), ne(agentCredentials.tokenHash, hash)));
		await tx
			.insert(agentCredentials)
			.values({
				id: randomUUID(),
				kind: "shared",
				projectId: DEFAULT_PROJECT,
				tokenHash: hash,
				createdAt: now,
			})
			.onConflictDoNothing({ target: agentCredentials.tokenHash });
	});
}
