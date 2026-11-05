import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { GlobalOverlays } from "#/components/app-shell/overlays";

interface MyRouterContext {
	queryClient: QueryClient;
}

declare module "@tanstack/react-router" {
	interface StaticDataRouteOption {
		/** 面包屑：这个路由的名称，或从上级页面开始的几级名称（外壳顶栏按路由层级拼接）。 */
		crumb?: string | readonly string[];
	}
}

// 开发工具只在 vite 开发服务器中加载，生产包里不包含（import.meta.env.DEV 在构建时为 false）。
const Devtools = import.meta.env.DEV
	? lazy(() => import("../integrations/devtools").then((m) => ({ default: m.Devtools })))
	: () => null;

/**
 * 根路由：全局浮层（命令面板、快捷键面板、昵称、通知）与快捷键监听。
 * 带侧边栏和顶栏的页面在 _shell/ 下面；全屏页（编排画布、运行监控，#35 / #36）直接放在 routes/ 下。
 */
export const Route = createRootRouteWithContext<MyRouterContext>()({
	component: RootLayout,
});

function RootLayout() {
	return (
		<GlobalOverlays>
			<Outlet />
			<Suspense>
				<Devtools />
			</Suspense>
		</GlobalOverlays>
	);
}
