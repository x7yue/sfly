import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { httpContract } from "@sfly/schema";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * 前端（SPA）与 HTTP API 同源同端口（ADR 0006）：
 *
 * - 浏览器经 `/api/*` 调用 API 和 SSE：{@link stripApiPrefix} 去掉前缀后按原路由处理，
 *   `/api` 下的未知路由照常返回 JSON 404，不回退到入口页。
 * - Agent、CLI 等非浏览器客户端继续访问根路径上的 API，不受影响。
 * - 其余 GET 请求：命中前端构建产物中的文件就返回文件；浏览器导航（Accept 含 text/html）
 *   回退到入口页 index.html，由前端路由处理（前端路由与根路径 API 同名也没关系）。
 *   契约里标了 `raw` 的路由（用户文档原文与 `/llms.txt`、`/install.sh`、Agent 下载、sfly 简单索引）不回退，
 *   在浏览器里也能直接打开。
 */

const API_PREFIX = "/api";

const isApiPath = (url: string) => url === API_PREFIX || /^\/api[/?]/.test(url);

/**
 * 契约里的路径模板 → 匹配请求路径的正则：`:参数` 匹配一段（可以带后缀，如 `:page.md`），末尾的 `*` 匹配剩余路径，
 * 末尾的 `/` 可有可无。
 */
function routePattern(template: string): RegExp {
	const source = template
		.replace(/\/$/, "")
		.split(/(:[A-Za-z_][A-Za-z0-9_]*|\*$)/)
		.map((part) => {
			if (part === "*") return ".*";
			if (part.startsWith(":")) return "[^/]+?";
			return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		})
		.join("");
	return new RegExp(`^${source}/?$`);
}

/** 给 curl 用的原文与下载：契约里标了 `raw` 的路由。 */
const RAW_ROUTES = httpContract.filter((def) => def.raw).map((def) => routePattern(def.path));

const isRawPath = (path: string) => RAW_ROUTES.some((pattern) => pattern.test(path));

/** Fastify `rewriteUrl`：`/api/agents?x=1` → `/agents?x=1`。 */
export function stripApiPrefix(url: string): string {
	if (!isApiPath(url)) return url;
	const rest = url.slice(API_PREFIX.length);
	return rest.startsWith("/") ? rest : `/${rest}`;
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".txt": "text/plain; charset=utf-8",
};

async function listFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

/** 前端构建产物：URL 路径 → 文件。 */
export interface WebApp {
	readonly files: ReadonlyMap<string, string>;
	readonly index: string;
}

/**
 * 扫描前端构建产物目录 `webDir`（vite build 的输出，必须含 index.html）。
 * 文件清单只在启动时扫描一次，之后只提供清单里的文件（不会读到目录外）。
 */
export async function loadWebApp(webDir: string): Promise<WebApp> {
	const files = new Map<string, string>();
	for (const file of await listFiles(webDir)) {
		files.set(`/${relative(webDir, file).split(sep).join("/")}`, file);
	}
	const index = files.get("/index.html");
	if (!index) throw new Error(`web app directory ${webDir} has no index.html`);
	return { files, index };
}

const send = async (reply: FastifyReply, file: string, cacheControl: string) =>
	reply
		.header("cache-control", cacheControl)
		.type(CONTENT_TYPES[extname(file)] ?? "application/octet-stream")
		.send(await readFile(file));

const pathOf = (url: string): string | undefined => {
	try {
		return decodeURIComponent(url.split("?")[0] ?? "/");
	} catch {
		return undefined;
	}
};

/** 在路由之前处理前端文件与入口页回退；必须在注册 API 路由之前调用。 */
export function registerWebApp(app: FastifyInstance, { files, index }: WebApp): void {
	app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
		if (request.method !== "GET" || isApiPath(request.originalUrl)) return;
		const path = pathOf(request.originalUrl);
		const file = path === undefined || path === "/" ? undefined : files.get(path);
		if (file) {
			// vite 产物的文件名带内容哈希，可以长期缓存；其余文件（favicon 等）每次校验。
			const hashed = path?.startsWith("/assets/");
			return send(reply, file, hashed ? "public, max-age=31536000, immutable" : "no-cache");
		}
		if (path !== undefined && isRawPath(path)) return;
		if (request.headers.accept?.includes("text/html")) return send(reply, index, "no-cache");
	});
}
