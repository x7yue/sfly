// 骨架验收（#553）的浏览器部分：在 Playwright 官方镜像里、这套环境的容器网络中运行（accept.sh 起它）。
// 不 import @playwright/test：这个目录不在 pnpm 的工作区里，配置写成普通对象，运行器由 apps/web 的依赖提供。
const out = process.env.ACCEPT_OUT ?? "/out";

export default {
	testDir: ".",
	testMatch: "acceptance.spec.ts",
	timeout: 20 * 60_000,
	expect: { timeout: 30_000 },
	workers: 1,
	fullyParallel: false,
	retries: 0,
	reporter: [["list"]],
	outputDir: `${out}/playwright`,
	use: {
		baseURL: process.env.ACCEPT_BASE_URL,
		locale: "zh-CN",
		viewport: { width: 1440, height: 900 },
		// 读文字、点按钮最多等 15 秒：元素不在时不一直等下去（默认不限时）。
		actionTimeout: 15_000,
		trace: "off",
		screenshot: "off",
	},
};
