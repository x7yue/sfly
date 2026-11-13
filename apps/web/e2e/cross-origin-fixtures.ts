import {
	type StreamingProxy,
	startStreamingProxy,
} from "../../server/test/support/streaming-proxy.js";
import { type PageHost, startPageHost } from "./cross-origin-page.js";
import { test as base, expect } from "./fixtures";

export interface CrossOriginFixtures {
	/** 另一个来源的页面服务（本机另一个端口，页面加载构建好的 API 客户端），本测试独占。 */
	pageHost: PageHost;
	/** 第二个页面服务：和 pageHost 来源不同，用来模拟名单之外的来源。 */
	foreignPageHost: PageHost;
	/** 为 true 时控制面的 `SFLY_CORS_ORIGINS` 只含 pageHost 的来源；默认不设置，允许所有来源。 */
	restrictCorsToPage: boolean;
	/** 控制面的版本号；设成和 API 客户端不同的值，就会触发版本不一致的警告。默认是控制面包的版本。 */
	controlPlaneVersion: string | undefined;
	/** 记录请求头的代理（含浏览器的预检请求），转发到控制面；页面把它当作控制面地址。 */
	controlPlaneProxy: StreamingProxy;
}

// biome-ignore lint/correctness/noEmptyPattern: Playwright 要求 fixture 的第一个参数是解构模式
const pageHostFixture = async ({}, use: (host: PageHost) => Promise<void>) => {
	const host = await startPageHost();
	try {
		await use(host);
	} finally {
		await host.close();
	}
};

export const test = base.extend<CrossOriginFixtures>({
	pageHost: pageHostFixture,
	foreignPageHost: pageHostFixture,
	restrictCorsToPage: [false, { option: true }],
	controlPlaneVersion: [undefined, { option: true }],
	controlPlaneOptions: async (
		{ controlPlaneOptions, pageHost, restrictCorsToPage, controlPlaneVersion },
		use,
	) => {
		await use({
			...controlPlaneOptions,
			...(restrictCorsToPage ? { corsOrigins: [pageHost.origin] } : {}),
			...(controlPlaneVersion === undefined ? {} : { version: controlPlaneVersion }),
		});
	},
	controlPlaneProxy: async ({ controlPlane }, use) => {
		const proxy = await startStreamingProxy(controlPlane.httpUrl);
		try {
			await use(proxy);
		} finally {
			await proxy.close();
		}
	},
});

export { expect };
