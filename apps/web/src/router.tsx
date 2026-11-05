import { QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { ApiError } from "./lib/api";
import { routeTree } from "./routeTree.gen";

/** 请求失败后的重试：4xx（请求本身有问题）不重试，其余最多再试 2 次，间隔 1 秒。 */
const retry = (failures: number, error: unknown) =>
	!(error instanceof ApiError && error.status >= 400 && error.status < 500) && failures < 2;

export function createRouter() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry, retryDelay: 1000 } },
	});
	return createTanStackRouter({
		routeTree,
		context: { queryClient },
		scrollRestoration: true,
		defaultPreload: "intent",
		defaultPreloadStaleTime: 0,
	});
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof createRouter>;
	}
}
