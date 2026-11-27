import type { CurrentUser, Scope } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { canAdminAgents } from "./use-agent-admin";

const user = (scopes: Scope[]): CurrentUser => ({
	id: "u1",
	login_name: "root",
	display_name: "管理员",
	is_platform_admin: false,
	scopes,
});

describe("谁看得到 Agent 的管理操作（#492）", () => {
	it("没登录、还不知道身份的人看不到", () => {
		expect(canAdminAgents({ status: "anonymous" })).toBe(false);
		expect(canAdminAgents({ status: "unknown" })).toBe(false);
	});

	it("登录了、范围里有「管理」才看得到：项目管理员（和平台管理员）有，编辑者、只读、不是成员没有", () => {
		const all: Scope[] = ["read", "run", "edit", "session_build", "publish", "manage"];
		expect(canAdminAgents({ status: "user", user: user(all) })).toBe(true);
		expect(
			canAdminAgents({
				status: "user",
				user: user(["read", "run", "edit", "session_build", "publish"]),
			}),
		).toBe(false);
		expect(canAdminAgents({ status: "user", user: user(["read"]) })).toBe(false);
		expect(canAdminAgents({ status: "user", user: user([]) })).toBe(false);
	});
});
