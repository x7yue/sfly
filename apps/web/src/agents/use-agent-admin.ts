import { useIdentity } from "#/lib/identity";

/**
 * 能不能看到 Agent 的管理操作（凭据的签发和吊销、停用和恢复）：这五个接口要登录（Cookie）和项目的「管理」范围（ADR 0029），
 * 服务端照样检查，页面不给没有资格的人看见按钮。没登录（昵称模式，#494 之前仍可用）的人一律没有。
 */
export function useCanAdminAgents(): boolean {
	return useIdentity().status === "user";
}
