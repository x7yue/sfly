import { access, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import type * as SflyClient from "../../../packages/client/src/index.js";

declare global {
	interface Window {
		/** 自建页面加载的 API 客户端（`@sfly/client` 的构建产物）。 */
		sfly: typeof SflyClient;
		sflyReady?: true;
	}
}

/** `pnpm --filter @sfly/client build` 的产物：ESM，相对导入都带 .js，浏览器直接加载。 */
const CLIENT_DIST = fileURLToPath(new URL("../../../packages/client/dist", import.meta.url));

const CLIENT_PREFIX = "/client/";

const DEFAULT_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>自建页面</title>
<script type="module">
	import * as sfly from "${CLIENT_PREFIX}index.js";
	window.sfly = sfly;
	window.sflyReady = true;
</script>
`;

/** 另一个来源的页面服务：本机的另一个端口，托管自建页面和构建好的 API 客户端。 */
export interface PageHost {
	/** 页面所在的来源，例如 `http://127.0.0.1:41234`；和控制面的端口不同，所以是另一个来源。 */
	readonly origin: string;
	close(): Promise<void>;
}

/**
 * 启动一个页面服务。`/` 是默认页面：加载 `/client/index.js`（API 客户端）并设置 `window.sfly` 和 `window.sflyReady`；
 * `pages` 用来自己提供别的页面（路径 → HTML），页面里同样可以 `import "/client/index.js"`。
 */
export async function startPageHost(
	pages: Readonly<Record<string, string>> = {},
): Promise<PageHost> {
	await access(join(CLIENT_DIST, "index.js")).catch(() => {
		throw new Error(`${CLIENT_DIST} 里没有构建产物：先运行 pnpm --filter @sfly/client build`);
	});
	const server = createServer(async (req, res) => {
		const path = new URL(req.url ?? "/", "http://page.invalid").pathname;
		const html = path === "/" ? DEFAULT_PAGE : pages[path];
		if (html !== undefined) {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
			return;
		}
		const file = path.startsWith(CLIENT_PREFIX)
			? resolve(CLIENT_DIST, path.slice(CLIENT_PREFIX.length))
			: "";
		if (!file.startsWith(CLIENT_DIST + sep) || !file.endsWith(".js")) {
			res.writeHead(404).end();
			return;
		}
		const body = await readFile(file).catch(() => undefined);
		if (body === undefined) res.writeHead(404).end();
		else res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(body);
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	return {
		origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		close: () =>
			new Promise<void>((done) => {
				server.close(() => done());
				server.closeAllConnections();
			}),
	};
}

/** 打开页面服务上的一个页面，等 API 客户端加载好；之后在页面里用 `window.sfly`。 */
export async function openPage(page: Page, host: PageHost, path = "/"): Promise<void> {
	await page.goto(`${host.origin}${path}`);
	await page.waitForFunction(() => window.sflyReady === true);
}
