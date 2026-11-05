import { TanStackDevtools } from "@tanstack/react-devtools";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";

/** TanStack 开发工具（Router、Query）；只在开发环境由 __root.tsx 懒加载。 */
export function Devtools() {
	return (
		<TanStackDevtools
			config={{ position: "bottom-right" }}
			plugins={[
				{ name: "Tanstack Router", render: <TanStackRouterDevtoolsPanel /> },
				{ name: "Tanstack Query", render: <ReactQueryDevtoolsPanel /> },
			]}
		/>
	);
}
