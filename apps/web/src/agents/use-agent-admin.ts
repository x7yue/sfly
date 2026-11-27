import { useEffect } from "react";
import { type Identity, refreshIdentity, useIdentity } from "#/lib/identity";

/**
 * 能不能看到 Agent 的管理操作（凭据的签发和吊销、停用和恢复）：这五个接口要登录（Cookie）和项目的「管理」范围（ADR 0029）。
 * 范围来自 `CurrentUser.scopes`（`GET /auth/me`、登录和初始化的响应，控制面按和访问检查同一个算法现算）：
 * 没登录（昵称模式，#494 之前仍可用）、还不知道身份、登录了但范围里没有「管理」（编辑者、只读成员、不是成员）都看不到。
 * 这只是让页面少显示点不了的按钮：服务端对每个请求照样检查，范围不够的请求是 403。
 */
export const canAdminAgents = (identity: Identity): boolean =>
	identity.status === "user" && identity.user.scopes.includes("manage");

export function useCanAdminAgents(): boolean {
	return canAdminAgents(useIdentity());
}

/**
 * 打开 Agent 管理页时重新问一次身份：范围跟着身份走（不另存一份），页面开着期间管理员被降级、移出项目，
 * 下次打开这一页（或身份因别的原因刷新）就看不到按钮了；放着不动的页面里按钮还在，点了服务端拒绝（403）。
 */
export function useRefreshIdentityOnOpen(): void {
	useEffect(() => {
		void refreshIdentity();
	}, []);
}
