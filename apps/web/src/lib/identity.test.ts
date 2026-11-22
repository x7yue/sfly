// 登录失效之后页面回到登录页（PR #555 的复审：事件流重连拿到 401 就悄悄停了，页面停在原处，用户不知道）：
// 只有「本来登录着、现在不是了」才跳转；从没登录过的人（昵称模式，#494 之前仍然合法）不受影响。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getIdentity,
	noteUnauthorized,
	setCurrentUser,
	setSessionExpiredHandler,
} from "./identity";

const USER = { id: "u1", login_name: "root", display_name: "管理员", is_platform_admin: true };

describe("请求拿到 401（noteUnauthorized）", () => {
	const expired = vi.fn();
	beforeEach(() => {
		expired.mockReset();
		setSessionExpiredHandler(expired);
	});
	afterEach(() => {
		setSessionExpiredHandler(undefined);
		setCurrentUser(null);
	});

	it("还不知道有没有登录（页面刚打开，还在问控制面）：不跳转，也不改状态", () => {
		// 模块刚加载时的状态是 unknown：这条必须排在第一个改状态的用例之前。
		expect(getIdentity().status).toBe("unknown");
		noteUnauthorized();
		expect(expired).not.toHaveBeenCalled();
		expect(getIdentity().status).toBe("unknown");
	});

	it("没有登录（昵称模式、登录页上登录失败的 401）：不跳转", () => {
		setCurrentUser(null);
		noteUnauthorized();
		noteUnauthorized();
		expect(expired).not.toHaveBeenCalled();
		expect(getIdentity().status).toBe("anonymous");
	});

	it("本来登录着：状态变成没有登录，通知一次（同时到的好几个 401 只跳转一次）", () => {
		setCurrentUser(USER);
		noteUnauthorized();
		noteUnauthorized();
		noteUnauthorized();
		expect(expired).toHaveBeenCalledTimes(1);
		expect(getIdentity().status).toBe("anonymous");
	});

	it("重新登录之后，下一次失效又能通知", () => {
		setCurrentUser(USER);
		noteUnauthorized();
		setCurrentUser(USER);
		noteUnauthorized();
		expect(expired).toHaveBeenCalledTimes(2);
	});

	it("没有登记处理函数时不报错", () => {
		setSessionExpiredHandler(undefined);
		setCurrentUser(USER);
		expect(() => noteUnauthorized()).not.toThrow();
		expect(getIdentity().status).toBe("anonymous");
	});
});
