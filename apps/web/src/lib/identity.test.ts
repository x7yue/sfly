// 登录失效之后页面回到登录页（PR #555 的复审：事件流重连拿到 401 就悄悄停了，页面停在原处，用户不知道）：
// 只有「本来登录着、现在确实不是了」才跳转；从没登录过的人（昵称模式，#494 之前仍然合法）不受影响。
// 401 不一定是登录失效（#578）：公开地址和浏览器实际地址不一致、又不是安全上下文时，登录有效，写请求也会被当作没登录。
// 所以拿到 401 先问一次 `GET /auth/me`，真的失效了才跳转，不然人被困在「登录 → 又被带回登录页」的循环里。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getIdentity,
	noteUnauthorized,
	setCurrentUser,
	setSessionExpiredHandler,
} from "./identity";

const USER = { id: "u1", login_name: "root", display_name: "管理员", is_platform_admin: true };

/** 控制面对 `GET /auth/me` 的回答：登录有效（200）、已经失效（401）、网络出错。 */
type MeAnswer = "valid" | "expired" | "unreachable";

describe("请求拿到 401（noteUnauthorized）", () => {
	const expired = vi.fn();
	let asked: string[];
	let answer: MeAnswer;
	let gate: Promise<void> | undefined;

	beforeEach(() => {
		expired.mockReset();
		asked = [];
		answer = "expired";
		gate = undefined;
		setSessionExpiredHandler(expired);
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			asked.push(String(input));
			if (gate) await gate;
			if (answer === "unreachable") throw new TypeError("network down");
			return answer === "valid"
				? Response.json(USER)
				: Response.json({ error: { code: "unauthorized", message: "凭据无效" } }, { status: 401 });
		});
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		setSessionExpiredHandler(undefined);
		setCurrentUser(null);
	});

	/** 等问 `GET /auth/me` 的那一段结束：没有在问了，再让出一轮。 */
	const settle = async () => {
		await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0));
		await new Promise((resolve) => setTimeout(resolve, 20));
	};

	it("还不知道有没有登录（页面刚打开，还在问控制面）：不问、不跳转，也不改状态", async () => {
		// 模块刚加载时的状态是 unknown：这条必须排在第一个改状态的用例之前。
		expect(getIdentity().status).toBe("unknown");
		noteUnauthorized();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(asked).toEqual([]);
		expect(expired).not.toHaveBeenCalled();
		expect(getIdentity().status).toBe("unknown");
	});

	it("没有登录（昵称模式、登录页上登录失败的 401）：不问、不跳转", async () => {
		setCurrentUser(null);
		noteUnauthorized();
		noteUnauthorized();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(asked).toEqual([]);
		expect(expired).not.toHaveBeenCalled();
		expect(getIdentity().status).toBe("anonymous");
	});

	it("本来登录着、控制面确认登录失效了（GET /auth/me 也是 401）：状态变成没有登录，通知一次；同时到的好几个 401 只问一次、只跳转一次", async () => {
		setCurrentUser(USER);
		noteUnauthorized();
		noteUnauthorized();
		noteUnauthorized();
		await vi.waitFor(() => expect(expired).toHaveBeenCalledTimes(1));
		await settle();
		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain("/auth/me");
		expect(expired).toHaveBeenCalledTimes(1);
		expect(getIdentity().status).toBe("anonymous");
	});

	it("401 但登录其实还有效（地址不一致、写请求被当作没登录）：不跳转，留在原页面，身份还是已登录", async () => {
		answer = "valid";
		setCurrentUser(USER);
		noteUnauthorized();
		await settle();
		expect(asked).toHaveLength(1);
		expect(expired).not.toHaveBeenCalled();
		expect(getIdentity()).toEqual({ status: "user", user: USER });
	});

	it("登录还有效时下一个 401 照样再问一次（不会因为问过一次就不再问）；之后真的失效了才跳转", async () => {
		answer = "valid";
		setCurrentUser(USER);
		noteUnauthorized();
		await settle();
		expect(asked).toHaveLength(1);
		answer = "expired";
		noteUnauthorized();
		await vi.waitFor(() => expect(expired).toHaveBeenCalledTimes(1));
		expect(asked).toHaveLength(2);
	});

	it("问不出结果（网络出错）：不跳转，身份不变", async () => {
		answer = "unreachable";
		setCurrentUser(USER);
		noteUnauthorized();
		await settle();
		expect(expired).not.toHaveBeenCalled();
		expect(getIdentity().status).toBe("user");
	});

	it("问的这段时间里已经登出了：以现在的状态为准，不再跳转", async () => {
		let release: () => void = () => {};
		gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		setCurrentUser(USER);
		noteUnauthorized();
		await vi.waitFor(() => expect(asked).toHaveLength(1));
		setCurrentUser(null);
		release();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(expired).not.toHaveBeenCalled();
		expect(getIdentity().status).toBe("anonymous");
	});

	// 问 `GET /auth/me` 的这段时间里身份变了（登出、换了一个人登录）：回来的答案是登出之前、换人之前问的，不能用来改现在的状态。
	it("问的这段时间里登出了，而 /auth/me 在登出之前已经回了 200：还是没有登录，顶栏不会又出现账号", async () => {
		answer = "valid";
		let release: () => void = () => {};
		gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		setCurrentUser(USER);
		noteUnauthorized();
		await vi.waitFor(() => expect(asked).toHaveLength(1));
		setCurrentUser(null);
		release();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(getIdentity().status).toBe("anonymous");
		expect(expired).not.toHaveBeenCalled();
	});

	it("问的这段时间里换成另一个人登录了：回来的 200 是前一个人的，身份还是现在登录的这个人", async () => {
		answer = "valid"; // 回答里的用户是 USER
		let release: () => void = () => {};
		gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		setCurrentUser(USER);
		noteUnauthorized();
		await vi.waitFor(() => expect(asked).toHaveLength(1));
		const other = {
			id: "u2",
			login_name: "alice",
			display_name: "爱丽丝",
			is_platform_admin: false,
		};
		setCurrentUser(other);
		release();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(getIdentity()).toEqual({ status: "user", user: other });
		expect(expired).not.toHaveBeenCalled();
	});

	it("问的这段时间里换成另一个人登录了：回来的 401 是前一个人的 Cookie 的，不能把现在登录的这个人踢下线", async () => {
		answer = "expired";
		let release: () => void = () => {};
		gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		setCurrentUser(USER);
		noteUnauthorized();
		await vi.waitFor(() => expect(asked).toHaveLength(1));
		const other = {
			id: "u2",
			login_name: "alice",
			display_name: "爱丽丝",
			is_platform_admin: false,
		};
		setCurrentUser(other);
		release();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(getIdentity()).toEqual({ status: "user", user: other });
		expect(expired).not.toHaveBeenCalled();
	});

	it("没有变化时 200 照样刷新身份（显示名改了会跟着变）", async () => {
		answer = "valid";
		setCurrentUser({ ...USER, display_name: "旧名字" });
		noteUnauthorized();
		await vi.waitFor(() => expect(getIdentity()).toEqual({ status: "user", user: USER }));
	});

	it("确认的请求一直不回：到时间按「问不出结果」处理，不跳转、身份不变；之后登录真的失效了仍然能跳转", async () => {
		vi.useFakeTimers();
		try {
			gate = new Promise<void>(() => {}); // 永远不回
			setCurrentUser(USER);
			noteUnauthorized();
			await vi.advanceTimersByTimeAsync(9_000);
			expect(expired).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(2_000);
			expect(expired).not.toHaveBeenCalled();
			expect(getIdentity()).toEqual({ status: "user", user: USER });
			// 现在登录真的失效了：下一个 401 能再问、能跳转。
			gate = undefined;
			answer = "expired";
			noteUnauthorized();
			await vi.advanceTimersByTimeAsync(10);
			expect(expired).toHaveBeenCalledTimes(1);
			expect(getIdentity().status).toBe("anonymous");
		} finally {
			vi.useRealTimers();
		}
	});

	it("重新登录之后，下一次失效又能通知", async () => {
		setCurrentUser(USER);
		noteUnauthorized();
		await vi.waitFor(() => expect(expired).toHaveBeenCalledTimes(1));
		setCurrentUser(USER);
		noteUnauthorized();
		await vi.waitFor(() => expect(expired).toHaveBeenCalledTimes(2));
	});

	it("没有登记处理函数时不报错", async () => {
		setSessionExpiredHandler(undefined);
		setCurrentUser(USER);
		expect(() => noteUnauthorized()).not.toThrow();
		await vi.waitFor(() => expect(getIdentity().status).toBe("anonymous"));
	});
});
