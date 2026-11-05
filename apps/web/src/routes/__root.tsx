import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Link, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { NicknameBadge, NicknameGate } from "../components/NicknameGate";
import TanStackQueryDevtools from "../integrations/tanstack-query/devtools";
import appCss from "../styles.css?url";

interface MyRouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				title: "sfly",
			},
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
		],
	}),
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="zh-CN">
			<head>
				<HeadContent />
			</head>
			<body>
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
				{children}
				<NicknameGate />
				<TanStackDevtools
					config={{
						position: "bottom-right",
					}}
					plugins={[
						{
							name: "Tanstack Router",
							render: <TanStackRouterDevtoolsPanel />,
						},
						TanStackQueryDevtools,
					]}
				/>
				<Scripts />
			</body>
		</html>
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
