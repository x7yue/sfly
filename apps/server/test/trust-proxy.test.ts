// `SFLY_TRUST_PROXY` 的写法（审查意见：信任所有跳时，客户端自己写的 X-Forwarded-For 首段会被当作来源地址）。
// 解析这一步的单元测试；真实请求里取到哪个地址见 login-hardening-http.test.ts。
import { describe, expect, it } from "vitest";
import { parseTrustProxy } from "../src/http/trust-proxy.js";

describe("SFLY_TRUST_PROXY", () => {
	it("没设置、空、false、0：不信任", () => {
		for (const value of [undefined, "", "  ", "false", "FALSE", "0"]) {
			expect(parseTrustProxy(value), String(value)).toBe(false);
		}
	});

	it("数字是代理的层数：对端和往右的 N-1 个地址可信，再往左的不可信（旧的 1 和 true 是一层）", () => {
		for (const value of ["1", "true", "TRUE"]) {
			const trust = parseTrustProxy(value) as (address: string, hop: number) => boolean;
			expect(typeof trust, value).toBe("function");
			expect(trust("10.0.0.1", 0)).toBe(true);
			expect(trust("203.0.113.9", 1)).toBe(false);
			expect(trust("198.51.100.1", 2)).toBe(false);
		}
		const two = parseTrustProxy("2") as (address: string, hop: number) => boolean;
		expect([two("a", 0), two("b", 1), two("c", 2)]).toEqual([true, true, false]);
		expect(() => parseTrustProxy("11")).toThrow(/不会超过 10/);
	});

	it("逗号分隔的地址段原样交给 Fastify（对端在段里才信它带来的 X-Forwarded-For）", () => {
		expect(parseTrustProxy("127.0.0.1")).toBe("127.0.0.1");
		expect(parseTrustProxy(" 10.0.0.0/8 , 127.0.0.1 ,::1")).toBe("10.0.0.0/8,127.0.0.1,::1");
		expect(parseTrustProxy("loopback,fd00::/8")).toBe("loopback,fd00::/8");
	});

	it("写错了：启动时就报错，说明怎么写，不悄悄当作不信任或全信任", () => {
		for (const value of [
			"banana",
			"10.0.0.0/33",
			"fd00::/129",
			"10.0.0.1/8/8",
			"1.2.3",
			"10.0.0.0/8,oops",
		]) {
			expect(() => parseTrustProxy(value), value).toThrow(/SFLY_TRUST_PROXY 认不出/);
		}
	});
});
