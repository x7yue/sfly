import { defineConfig, devices } from "@playwright/test";

/**
 * 端到端测试与视觉回归（ADR 0005）：每个测试启动自己的真实控制面（托管 dist/ 中的前端构建产物）、
 * 独立的 PostgreSQL 数据库和手动时钟，见 e2e/fixtures.ts。`pnpm test:e2e` 会先构建前端。
 *
 * 视觉基线依赖字体渲染，只在 Playwright 官方镜像里生成和比对（CI 也在同一镜像中运行），
 * 本机用 `pnpm test:e2e:docker`（更新基线加 `--update-snapshots`）。两者都设置 SFLY_VISUAL=1；
 * 未设置时（直接在本机 `pnpm test:e2e`）跳过视觉回归，只跑功能用例。
 */
const visual = process.env.SFLY_VISUAL === "1";

export default defineConfig({
	testDir: "e2e",
	testIgnore: visual ? [] : ["**/visual.spec.ts"],
	outputDir: "test-results",
	snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: 0,
	workers: process.env.CI ? 2 : undefined,
	// GitHub Actions 上的 github 报告器把失败的用例写成 check run 注释：
	// `gh api repos/{owner}/{repo}/check-runs/<job id>/annotations` 就能列出，不用下载日志。
	reporter: process.env.CI
		? [
				["list"],
				["html", { open: "never" }],
				...(process.env.GITHUB_ACTIONS ? [["github"] as [string]] : []),
			]
		: "list",
	timeout: 30_000,
	expect: { toHaveScreenshot: { animations: "disabled", caret: "hide" } },
	use: {
		...devices["Desktop Chrome"],
		viewport: { width: 1440, height: 900 },
		locale: "zh-CN",
		timezoneId: "Asia/Shanghai",
		colorScheme: "dark",
		trace: "retain-on-failure",
	},
	projects: [{ name: "chromium" }],
});
