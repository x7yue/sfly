import { bearer, TestAccounts } from "../../server/test/support/credentials.js";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";

// Agent 页的凭据种类和停用状态（#492）：e2e 造这些状态用的辅助。页面是只读的，状态走和管理员同样的接口、或直接写库。

/** 最近一次连接用的凭据记成这个样子（`shared` 和 `none` 在真实部署里要特定的配置才连得出来）。 */
export async function setAuthKind(
	controlPlane: TestControlPlane,
	name: string,
	kind: "agent" | "shared" | "none" | null,
): Promise<void> {
	const accounts = new TestAccounts(controlPlane.database.url);
	try {
		await accounts.agentAuthKind(name, kind);
	} finally {
		await accounts.close();
	}
}

/** 停用或恢复一台 Agent：和控制台以后用的是同一个接口（项目管理员，`POST /agents/:name/disable|enable`）。 */
export async function setAgentDisabled(
	controlPlane: TestControlPlane,
	name: string,
	disabled: boolean,
): Promise<void> {
	const accounts = new TestAccounts(controlPlane.database.url);
	try {
		const boss = await accounts.userNamed("agent-admin");
		await accounts.member("default", boss, "project_admin");
		const token = await accounts.personalToken(boss);
		const response = await controlPlane.fetch(
			`/agents/${name}/${disabled ? "disable" : "enable"}`,
			{
				method: "POST",
				headers: bearer(token),
			},
		);
		if (response.status !== 204) throw new Error(`停用或恢复 ${name} 失败：${response.status}`);
	} finally {
		await accounts.close();
	}
}
