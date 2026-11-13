import { defineConfig } from "vitest/config";

// 前端单测以纯逻辑模块为主（ADR 0005）：src 下的 *.test.ts，没有 DOM，组件只能当函数直接调用；页面行为由 e2e/ 的 Playwright 测试覆盖。
export default defineConfig({
	resolve: { tsconfigPaths: true },
	test: { include: ["src/**/*.test.ts"] },
});
