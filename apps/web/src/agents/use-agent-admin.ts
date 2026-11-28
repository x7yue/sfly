import { type Identity, useIdentity } from "#/lib/identity";

/**
 * 能不能看到 Agent 的管理操作（凭据的签发和吊销、停用和恢复）：这四个写接口要登录（Cookie 或个人令牌，不认项目令牌和会话令牌）
 * 和项目的「管理」范围（ADR 0029）；列出一台 Agent 的凭据只要「读」。
 * 范围来自 `CurrentUser.scopes`（`GET /auth/me`、登录和初始化的响应，控制面按和访问检查同一个算法现算，是**默认项目里**的范围，
 * Agent 页和 `/agents` 现在都在默认项目；别的项目的页面不能拿它判断，项目切换之后要改成按页面所在的项目给）：
 * 没登录、还不知道身份、登录了但范围里没有「管理」（编辑者、只读成员、不是成员）都看不到。
 * 这只是让页面少显示点不了的按钮：服务端对每个请求照样检查，范围不够的请求是 403，对话框里写明原因（`AdminErrorText`）。
 *
 * 范围只在页面打开时（`main.tsx` 的 `refreshIdentity`）、登录和初始化时读到，**不在页面中途另外刷新**：身份的刷新只有现有的
 * 那几条路（登录失效的确认在 `lib/identity.ts` 里）。管理员被降级之后页面上的按钮还在，点了得到 403；刷新页面按钮就没了。
 */
export const canAdminAgents = (identity: Identity): boolean =>
	identity.status === "user" && identity.user.scopes.includes("manage");

export function useCanAdminAgents(): boolean {
	return canAdminAgents(useIdentity());
}
