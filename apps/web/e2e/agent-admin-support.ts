import type { BrowserContext } from "@playwright/test";
import type { ProjectRole } from "../../server/src/db/schema.js";
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
		const boss = await accounts.userNamed("agentadmin");
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

/**
 * 页面以某个人登录（Agent 的凭据、停用要登录和「管理」范围）：造用户、成员（`role` 为 null 是不是成员）、登录 Cookie；
 * `platformAdmin` 是平台管理员。返回同一个人的个人令牌（测试里直接调接口、核对列表接口的响应用）。
 */
export async function signInAs(
	context: BrowserContext,
	controlPlane: TestControlPlane,
	who: { login: string; role: ProjectRole | null; platformAdmin?: boolean },
): Promise<{ token: string; headers: Record<string, string> }> {
	const accounts = new TestAccounts(controlPlane.database.url);
	try {
		const user = await accounts.userNamed(who.login, {
			displayName: who.login,
			admin: who.platformAdmin ?? false,
		});
		if (who.role !== null) await accounts.member("default", user, who.role);
		await context.addCookies([
			{ name: "sfly_login", value: await accounts.login(user), url: controlPlane.httpUrl },
		]);
		const token = await accounts.personalToken(user);
		return { token, headers: bearer(token) };
	} finally {
		await accounts.close();
	}
}

/** 停用一个用户：他的登录和令牌立即失效（页面再发请求拿到 401）。 */
export async function disableUser(controlPlane: TestControlPlane, login: string): Promise<void> {
	const accounts = new TestAccounts(controlPlane.database.url);
	try {
		await accounts.disable(await accounts.userNamed(login));
	} finally {
		await accounts.close();
	}
}

/** 页面以项目管理员登录。 */
export const signInAsAdmin = (context: BrowserContext, controlPlane: TestControlPlane) =>
	signInAs(context, controlPlane, { login: "agentadmin", role: "project_admin" });

/** 把一台 Agent 的凭据全部删掉（只在测试里：造「这个名字还没有签发过凭据」的空列表，真实的接口不会让它发生）。 */
export async function clearCredentials(
	controlPlane: TestControlPlane,
	name: string,
): Promise<void> {
	const accounts = new TestAccounts(controlPlane.database.url);
	try {
		await accounts.clearAgentCredentials(name);
	} finally {
		await accounts.close();
	}
}
