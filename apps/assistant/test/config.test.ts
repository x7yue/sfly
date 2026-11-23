import { describe, expect, it } from "vitest";
import { ConfigError, readConfig } from "../src/config.js";

describe("配置", () => {
	it("共享密钥缺了或短于 32 个字符：拒绝启动", () => {
		expect(() => readConfig({})).toThrow(ConfigError);
		expect(() => readConfig({ SFLY_ASSISTANT_SECRET: "x".repeat(31) })).toThrow(/至少要 32 个字符/);
	});

	it("默认值", () => {
		expect(readConfig({ SFLY_ASSISTANT_SECRET: "x".repeat(32) })).toEqual({
			secret: "x".repeat(32),
			modelsFile: "/config/models.json",
			model: undefined,
			dataDir: "/data",
		});
	});
});
