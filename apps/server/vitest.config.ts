import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// 每个测试文件在独立进程里运行，各自创建临时数据库。
		pool: "forks",
		testTimeout: 20_000,
		hookTimeout: 60_000,
	},
});
