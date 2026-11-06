import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "#/components/app-shell/AppShell";

/** 带外壳（侧边栏 + 顶栏）的页面布局；子路由在 routes/_shell/ 下。 */
export const Route = createFileRoute("/_shell")({
	component: () => (
		<AppShell>
			<Outlet />
		</AppShell>
	),
});
