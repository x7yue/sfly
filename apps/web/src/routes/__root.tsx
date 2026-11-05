import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Link, Outlet } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { NicknameBadge, NicknameGate } from "../components/NicknameGate";

interface MyRouterContext {
	queryClient: QueryClient;
}

// 开发工具只在 vite 开发服务器中加载，生产包里不包含（import.meta.env.DEV 在构建时为 false）。
const Devtools = import.meta.env.DEV
	? lazy(() => import("../integrations/devtools").then((m) => ({ default: m.Devtools })))
	: () => null;

export const Route = createRootRouteWithContext<MyRouterContext>()({
	component: RootLayout,
});

function RootLayout() {
	return (
		<>
			<nav className="sf-nav">
				<Link to="/" className="sf-nav__brand">
					sfly
				</Link>
				<NavLink to="/orchestrations">编排</NavLink>
				<NavLink to="/agents">Agent</NavLink>
				<NavLink to="/packages">节点包</NavLink>
				<span className="sf-nav__nick">
					<NicknameBadge />
				</span>
			</nav>
			<Outlet />
			<NicknameGate />
			<Suspense>
				<Devtools />
			</Suspense>
		</>
	);
}

function NavLink({
	to,
	children,
}: {
	to: "/orchestrations" | "/agents" | "/packages";
	children: string;
}) {
	return (
		<Link to={to} className="sf-nav__link" activeProps={{ className: "sf-nav__link--active" }}>
			{children}
		</Link>
	);
}
