import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
	return (
		<div className="p-8">
			<h1 className="text-4xl font-bold">sfly</h1>
			<ul className="mt-4 text-lg">
				<li>
					<Link to="/packages" className="text-blue-600 hover:underline">
						节点包
					</Link>
				</li>
			</ul>
		</div>
	);
}
