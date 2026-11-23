// 助手有没有配置（src/sessions/assistant-config.ts）：没配好时的原因会进就绪状态和写接口的 503，所有能读这个项目的人都看得到，
// 所以原因里不回显配置的地址（地址里可能带用户名和密码），只说是哪个变量、哪一类问题。
import { describe, expect, it } from "vitest";
import { assistantSetup } from "../src/sessions/assistant-config.js";

const SECRET = "x".repeat(32);

describe("助手的配置", () => {
	it("地址和密钥都配好了：开着，地址解析成 URL", () => {
		const setup = assistantSetup({ url: "http://assistant.internal:7000", secret: SECRET });
		expect(setup).toMatchObject({ configured: true });
		expect(setup.configured && setup.config.url.host).toBe("assistant.internal:7000");
	});

	it("没配地址、没配密钥、密钥太短：关着，原因写明是哪个变量", () => {
		expect(assistantSetup({})).toMatchObject({
			configured: false,
			reason: expect.stringContaining("SFLY_ASSISTANT_URL"),
		});
		expect(assistantSetup({ url: "http://a:1" })).toMatchObject({
			configured: false,
			reason: expect.stringContaining("SFLY_ASSISTANT_SECRET"),
		});
		expect(assistantSetup({ url: "http://a:1", secret: "short" })).toMatchObject({
			configured: false,
			reason: expect.stringContaining("短于"),
		});
	});

	it("地址里带用户名和密码：当作没配好（每个请求都会失败），原因不回显这段地址，指出共享密钥写在哪个变量里", () => {
		for (const url of ["http://user:hunter2@assistant:7000", "https://user@assistant:7000/"]) {
			const setup = assistantSetup({ url, secret: SECRET });
			expect(setup.configured, url).toBe(false);
			const reason = setup.configured ? "" : setup.reason;
			expect(reason, url).toBe(
				"SFLY_ASSISTANT_URL 不能带用户名和密码（共享密钥写在 SFLY_ASSISTANT_SECRET 里）",
			);
			expect(reason, url).not.toMatch(/hunter2|user/);
		}
	});

	it("地址配错：原因只说是哪个变量、哪一类问题，不回显配置的地址（带用户名和密码的也不会出现）", () => {
		const bad = [
			"://user:hunter2@host:7000",
			"user:hunter2 host",
			"ftp://user:hunter2@host:7000/x",
		];
		for (const url of bad) {
			const setup = assistantSetup({ url, secret: SECRET });
			expect(setup.configured, url).toBe(false);
			const reason = setup.configured ? "" : setup.reason;
			expect(reason, url).toContain("SFLY_ASSISTANT_URL");
			expect(reason, url).not.toMatch(/hunter2|host:7000/);
		}
		expect(assistantSetup({ url: "://x", secret: SECRET })).toMatchObject({
			reason: "SFLY_ASSISTANT_URL 不是一个合法的地址",
		});
		expect(assistantSetup({ url: "ftp://x/", secret: SECRET })).toMatchObject({
			reason: "SFLY_ASSISTANT_URL 要写 http 或 https 地址",
		});
	});
});
