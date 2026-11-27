import { ApiError } from "@sfly/client";
import { describe, expect, it } from "vitest";
import { isForbidden, mayHaveIssued } from "./admin-error";

const error = (status: number, code = "x") =>
	new ApiError({ status, code, message: "m", method: "POST", path: "/agents/a/credentials" });

describe("签发出错之后：控制面有没有可能已经签发了一枚", () => {
	it("没有收到响应、控制面自己出错、响应读不出来：可能已经签发了", () => {
		expect(mayHaveIssued(new Error("断了"))).toBe(true);
		expect(mayHaveIssued(error(0, "network_error"))).toBe(true);
		expect(mayHaveIssued(error(500))).toBe(true);
		expect(mayHaveIssued(error(502))).toBe(true);
		expect(mayHaveIssued(error(201, "invalid_response"))).toBe(true);
	});

	it("控制面明确拒绝了（4xx：名称不合格、没有范围、没有登录、限速）：一定没有签发", () => {
		for (const status of [400, 401, 403, 404, 409, 429]) {
			expect(mayHaveIssued(error(status)), String(status)).toBe(false);
		}
	});

	it("403 是没有「管理」范围", () => {
		expect(isForbidden(error(403))).toBe(true);
		expect(isForbidden(error(401))).toBe(false);
		expect(isForbidden(new Error("x"))).toBe(false);
	});
});
