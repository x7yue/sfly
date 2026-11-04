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
				<nav className="flex h-[49px] items-center gap-5 border-b border-gray-200 bg-white px-4">
					<Link to="/" className="font-bold">
						sfly
					</Link>
					<NavLink to="/orchestrations">编排</NavLink>
					<NavLink to="/agents">Agent</NavLink>
					<NavLink to="/packages">节点包</NavLink>
					<span className="ml-auto">
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
		<Link
			to={to}
			className="text-sm text-gray-600 hover:text-gray-900"
			activeProps={{ className: "font-semibold text-gray-900" }}
		>
			{children}
		</Link>
	);
}
