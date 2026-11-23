import type { Readiness } from "@sfly/schema";
import { StatusPill } from "#/components/status";
import { SESSION } from "#/lib/copy";
import { readinessProblems } from "./session-text";

/**
 * 助手页顶部的就绪状态：可以用就写一行「可以用 · 工作台 X 在线」；不能用就逐条写缺什么
 * （助手服务连不上、工作台不在线、没有配置助手……，来自就绪状态的 `problems`）。
 */
export function ReadinessLine({ readiness }: { readiness: Readiness }) {
	if (readiness.ready) {
		return (
			<p data-testid="readiness" data-ready="true" className="m-0 text-sm">
				<StatusPill kind="ok" className="text-sm">
					{SESSION.ready(readiness.workbench)}
				</StatusPill>
			</p>
		);
	}
	return (
		<div data-testid="readiness" data-ready="false" className="text-sm">
			<StatusPill kind="warn" className="text-sm">
				{SESSION.notReady}
			</StatusPill>
			<ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0 pl-3.5 text-fg-2">
				{readinessProblems(readiness).map((problem) => (
					<li key={problem}>{problem}</li>
				))}
			</ul>
		</div>
	);
}
