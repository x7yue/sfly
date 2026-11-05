import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
	return (
		<div className="sf-page">
			<h1>sfly</h1>
			<ul className="sf-page__links">
				<li>
					<Link to="/orchestrations" className="sf-link">
						编排
					</Link>
				</li>
				<li>
					<Link to="/agents" className="sf-link">
						Agent
					</Link>
				</li>
				<li>
					<Link to="/packages" className="sf-link">
						节点包
					</Link>
				</li>
			</ul>
		</div>
	);
}
