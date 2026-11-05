import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 纯 SPA（ADR 0006）：生产环境由控制面托管 dist/，页面、API（/api/*）与 SSE 同源同端口。
// 开发时用 vite 开发服务器，/api/* 原样代理到控制面（SFLY_API_URL，默认 http://127.0.0.1:8080）。
const apiProxy = {
	"/api": { target: process.env.SFLY_API_URL ?? "http://127.0.0.1:8080", changeOrigin: true },
};

export default defineConfig(({ command }) => ({
	resolve: { tsconfigPaths: true },
	server: { proxy: apiProxy },
	preview: { proxy: apiProxy },
	plugins: [
		// TanStack 开发工具只用于开发服务器。
		...(command === "serve" ? [devtools()] : []),
		tanstackRouter({ target: "react", autoCodeSplitting: true }),
		tailwindcss(),
		viteReact(),
	],
}));
