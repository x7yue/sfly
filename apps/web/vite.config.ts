import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// 纯 SPA（ADR 0006）：生产环境由控制面托管 dist/，页面、API（/api/*）与 SSE 同源同端口。
// 开发时用 vite 开发服务器，/api/* 原样代理到控制面（SFLY_API_URL，默认 http://127.0.0.1:8080）。
const apiProxy = {
	"/api": { target: process.env.SFLY_API_URL ?? "http://127.0.0.1:8080", changeOrigin: true },
};

/**
 * sonner 在运行时往 <head> 插入自己的样式，那些规则不在任何 CSS layer 里。把它包进 vendor 层，
 * 与其它第三方样式一样排在组件样式之下（层的顺序见 src/styles/app.css）。
 */
const sonnerStylesInLayer = (): Plugin => ({
	name: "sfly:sonner-styles-in-layer",
	enforce: "pre",
	transform(code, id) {
		if (!/[\\/]sonner[\\/]dist[\\/]index\.m?js$/.test(id)) return;
		const wrapped = code.replace(
			/__insertCSS\("(.*)"\);/,
			(_, css: string) => `__insertCSS("@layer vendor{${css}}");`,
		);
		if (wrapped === code) this.error("sonner 的样式注入方式变了，请更新 vite.config.ts");
		return wrapped;
	},
});

export default defineConfig(({ command }) => ({
	resolve: { tsconfigPaths: true },
	server: { proxy: apiProxy },
	// 不预构建 sonner，开发服务器上也经过 sonnerStylesInLayer。
	optimizeDeps: { exclude: ["sonner"] },
	preview: { proxy: apiProxy },
	plugins: [
		// TanStack 开发工具只用于开发服务器。
		...(command === "serve" ? [devtools()] : []),
		tanstackRouter({ target: "react", autoCodeSplitting: true }),
		sonnerStylesInLayer(),
		tailwindcss(),
		viteReact(),
	],
}));
