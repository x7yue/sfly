import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 浏览器请求同源 /api/*，代理到控制面 HTTP API（去掉 /api 前缀）。
const apiProxy = {
	"/api": {
		target: process.env.SFLY_API_URL ?? "http://127.0.0.1:8080",
		changeOrigin: true,
		rewrite: (path: string) => path.replace(/^\/api/, ""),
	},
};

const config = defineConfig({
	resolve: { tsconfigPaths: true },
	server: { proxy: apiProxy },
	preview: { proxy: apiProxy },
	plugins: [devtools(), tailwindcss(), tanstackStart(), viteReact()],
});

export default config;
