import { defineConfig } from "vitest/config";

// 前端单测只覆盖纯逻辑模块（ADR 0005）：src 下的 *.test.ts；页面行为由 e2e/ 的 Playwright 测试覆盖。
export default defineConfig({
	test: { include: ["src/**/*.test.ts"] },
});
