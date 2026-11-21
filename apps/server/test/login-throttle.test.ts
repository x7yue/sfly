// 登录限速（ADR 0029「认证的几处细节」：登录按用户和来源地址限速，连续失败有退避）。
import { describe, expect, it } from "vitest";
import { LoginThrottle } from "../src/auth/login-throttle.js";
import { ManualClock } from "./support/manual-clock.js";

const options = {
	freeAttempts: 3,
	baseDelayMs: 2000,
	maxDelayMs: 60_000,
	resetAfterMs: 3_600_000,
	addressFreeAttempts: 10,
};

function fail(throttle: LoginThrottle, user: string, address: string, times: number) {
	for (let i = 0; i < times; i++) throttle.failure(user, address);
}

describe("登录限速", () => {
	it("前几次失败不限制，之后每多一次失败，要等的时间翻倍，到上限为止", () => {
		const clock = new ManualClock();
		const throttle = new LoginThrottle(clock, options);
		fail(throttle, "alice", "10.0.0.1", 3);
		expect(throttle.retryAfterMs("alice", "10.0.0.1")).toBe(0);
		throttle.failure("alice", "10.0.0.1");
		expect(throttle.retryAfterMs("alice", "10.0.0.1")).toBe(2000);
		clock.advance(2000);
		expect(throttle.retryAfterMs("alice", "10.0.0.1")).toBe(0);
		throttle.failure("alice", "10.0.0.1");
		expect(throttle.retryAfterMs("alice", "10.0.0.1")).toBe(4000);
		clock.advance(4000);
		throttle.failure("alice", "10.0.0.1");
		expect(throttle.retryAfterMs("alice", "10.0.0.1")).toBe(8000);
		fail(throttle, "alice", "10.0.0.1", 10);
		expect(throttle.retryAfterMs("alice", "10.0.0.1")).toBe(60_000);
	});

	it("登录成功清零；只限速失败的那一个（用户、地址）组合，别的组合不受影响", () => {
		const clock = new ManualClock();
		const throttle = new LoginThrottle(clock, options);
		fail(throttle, "alice", "10.0.0.1", 5);
		expect(throttle.retryAfterMs("alice", "10.0.0.1")).toBeGreaterThan(0);
		// 同一个用户换一个地址、同一个地址换一个用户，都照常。
		expect(throttle.retryAfterMs("alice", "10.0.0.2")).toBe(0);
		expect(throttle.retryAfterMs("bob", "10.0.0.1")).toBe(0);
		clock.advance(60_000);
		throttle.success("alice", "10.0.0.1");
		fail(throttle, "alice", "10.0.0.1", 3);
		expect(throttle.retryAfterMs("alice", "10.0.0.1")).toBe(0);
	});

	it("被限速期间的尝试不再累加失败次数：等够了再试，不会因为中间多按了几次而等得更久", () => {
		const clock = new ManualClock();
		const throttle = new LoginThrottle(clock, options);
		fail(throttle, "alice", "10.0.0.1", 4);
		expect(throttle.retryAfterMs("alice", "10.0.0.1")).toBe(2000);
		// 调用方在被限速时不会去验证密码，也就不会记失败；这里确认查询本身没有副作用。
		for (let i = 0; i < 20; i++) throttle.retryAfterMs("alice", "10.0.0.1");
		clock.advance(2000);
		expect(throttle.retryAfterMs("alice", "10.0.0.1")).toBe(0);
	});

	it("同一个地址上试了很多个不同的用户名：地址整体也被限速（防撞库），用户名各不相同时按用户的限速拦不住", () => {
		const clock = new ManualClock();
		const throttle = new LoginThrottle(clock, options);
		for (let i = 0; i < 10; i++) throttle.failure(`user${i}`, "10.0.0.9");
		expect(throttle.retryAfterMs("user0", "10.0.0.9")).toBe(0);
		expect(throttle.retryAfterMs("someone-new", "10.0.0.9")).toBe(0);
		throttle.failure("user10", "10.0.0.9");
		expect(throttle.retryAfterMs("someone-new", "10.0.0.9")).toBe(2000);
		expect(throttle.retryAfterMs("someone-new", "10.0.0.8")).toBe(0);
	});

	it("很久没有失败就忘掉：一小时后从头算；记录的数量有上限，不会被一堆乱写的用户名撑大", () => {
		const clock = new ManualClock();
		const throttle = new LoginThrottle(clock, { ...options, maxEntries: 50 });
		fail(throttle, "alice", "10.0.0.1", 6);
		expect(throttle.retryAfterMs("alice", "10.0.0.1")).toBeGreaterThan(0);
		clock.advance(3_600_001);
		expect(throttle.retryAfterMs("alice", "10.0.0.1")).toBe(0);
		fail(throttle, "alice", "10.0.0.1", 3);
		expect(throttle.retryAfterMs("alice", "10.0.0.1")).toBe(0);
		for (let i = 0; i < 500; i++) throttle.failure(`junk${i}`, "10.0.0.5");
		expect(throttle.size).toBeLessThanOrEqual(50);
	});

	it("登录名按小写比较：换大小写不能绕开限速", () => {
		const throttle = new LoginThrottle(new ManualClock(), options);
		fail(throttle, "Alice", "10.0.0.1", 4);
		expect(throttle.retryAfterMs("alice", "10.0.0.1")).toBe(2000);
	});
});
