// 限速用的来源地址怎么归一（PR #555 的差异复审：代理追加的段里带着端口、IPv6 按完整地址算，换端口或换同一个 /64 里的地址
// 就能每次重新开始计数）：去掉端口，IPv6 按 /64 归在一起，IPv4 映射的 IPv6 就是那个 IPv4，认不出的原样作键（偏向多拦）。
import { describe, expect, it } from "vitest";
import { LoginThrottle } from "../src/auth/login-throttle.js";
import { throttleAddress } from "../src/auth/source-address.js";
import { ManualClock } from "./support/manual-clock.js";

describe("throttleAddress", () => {
	it("IPv4：去掉端口，不带端口的原样", () => {
		expect(throttleAddress("10.9.9.9")).toBe("10.9.9.9");
		expect(throttleAddress("10.9.9.9:5555")).toBe("10.9.9.9");
		expect(throttleAddress("10.9.9.9:1")).toBe("10.9.9.9");
		expect(throttleAddress(" 10.9.9.9:80 ")).toBe("10.9.9.9");
	});

	it("IPv6：按 /64 归在一起；方括号、端口、大小写、缩写写法、区域标识都不影响", () => {
		const group = throttleAddress("2001:db8:1:2::1");
		for (const form of [
			"[2001:db8:1:2::1]:443",
			"[2001:db8:1:2::1]",
			"2001:DB8:1:2::9",
			"2001:db8:1:2:aaaa:bbbb:cccc:dddd",
			"2001:db8:1:2:0:0:0:1",
			"2001:0db8:0001:0002:0000:0000:0000:0001",
		]) {
			expect(throttleAddress(form), form).toBe(group);
		}
		expect(throttleAddress("fe80::1%eth0")).toBe(throttleAddress("fe80::2"));
		// 前 64 位不同就是不同的来源。
		expect(throttleAddress("2001:db8:1:3::1")).not.toBe(group);
		expect(throttleAddress("2001:db9:1:2::1")).not.toBe(group);
		// 全零、缩写在中间也认。
		expect(throttleAddress("::1")).toBe(throttleAddress("::2"));
		expect(throttleAddress("2001:db8::1")).toBe(throttleAddress("2001:db8:0:0:5::1"));
	});

	it("IPv4 映射的 IPv6（双栈监听时 Node 给的写法）就是那个 IPv4", () => {
		expect(throttleAddress("::ffff:10.9.9.9")).toBe("10.9.9.9");
		expect(throttleAddress("::FFFF:10.9.9.9")).toBe("10.9.9.9");
		expect(throttleAddress("::ffff:0a09:0909")).toBe("10.9.9.9");
		expect(throttleAddress("[::ffff:10.9.9.9]:443")).toBe("10.9.9.9");
	});

	it("认不出的值原样作键：不同的值是不同的来源，不会被归到一起（偏向多拦）", () => {
		for (const value of [
			"unknown",
			"",
			"not an address",
			"10.9.9",
			"10.9.9.9.9",
			"999.1.1.1:80",
			"[bad]:1",
		]) {
			expect(throttleAddress(value), value).toBe(value);
		}
		expect(throttleAddress("unknown")).not.toBe(throttleAddress("other"));
	});
});

describe("限速用归一后的地址", () => {
	const options = { freeAttempts: 3, baseDelayMs: 2000, addressFreeAttempts: 10 };

	it("同一个来源换端口：用户 + 地址的计数和地址整体的计数都按归一后的地址", () => {
		const throttle = new LoginThrottle(new ManualClock(), options);
		for (let port = 5000; port < 5004; port++) throttle.failure("alice", `10.9.9.9:${port}`);
		expect(throttle.retryAfterMs("alice", "10.9.9.9")).toBeGreaterThan(0);
		expect(throttle.retryAfterMs("alice", "10.9.9.9:60000")).toBeGreaterThan(0);
		// 别的来源不受牵连。
		expect(throttle.retryAfterMs("alice", "10.9.9.10:5000")).toBe(0);
	});

	it("同一个 /64 里换地址：地址整体的计数合在一起", () => {
		const throttle = new LoginThrottle(new ManualClock(), options);
		for (let i = 0; i < 11; i++) throttle.failure(`user${i}`, `2001:db8:1:2::${i + 1}`);
		expect(throttle.retryAfterMs("someone-else", "[2001:db8:1:2:ffff::1]:443")).toBeGreaterThan(0);
		expect(throttle.retryAfterMs("someone-else", "2001:db8:1:3::1")).toBe(0);
	});

	it("占位和还回去（acquire、cancel、confirm）用同一个归一后的键：换着写法也还得回去", () => {
		const throttle = new LoginThrottle(new ManualClock(), options);
		for (let i = 0; i < 3; i++) {
			expect(throttle.acquire("alice", "10.9.9.9:1000").ok).toBe(true);
			throttle.cancel("alice", "10.9.9.9:2000");
		}
		expect(throttle.size).toBe(0);
	});
});
