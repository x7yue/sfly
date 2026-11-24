import type { Readiness } from "@sfly/schema";
import { StatusPill } from "#/components/status";
import { UntrustedText } from "#/components/untrusted-text";
import { SESSION } from "#/lib/copy";
import { readinessProblems } from "./session-text";

/** 就绪状态那一块的 id：「开始」和输入框用 aria-describedby 指向它（不能用的原因只在这里写一处）。 */
export const READINESS_ID = "assistant-readiness";

/**
 * 助手页顶部的就绪状态：可以用就写一行「可以用 · 工作台 X 在线」；不能用就逐条写缺什么
 * （助手服务连不上、工作台不在线、没有配置助手……，来自就绪状态的 `problems`）。
 */
export function ReadinessLine({ readiness }: { readiness: Readiness }) {
	if (readiness.ready) {
		return (
			<p id={READINESS_ID} data-testid="readiness" data-ready="true" className="m-0 text-sm">
				<StatusPill kind="ok" className="text-sm">
					<UntrustedText dir="ltr" text={SESSION.ready(readiness.workbench)} />
				</StatusPill>
			</p>
		);
	}
	return (
		<div id={READINESS_ID} data-testid="readiness" data-ready="false" className="text-sm">
			<StatusPill kind="warn" className="text-sm">
				{SESSION.notReady}
			</StatusPill>
			<ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0 pl-3.5 text-fg-2">
				{readinessProblems(readiness).map((problem) => (
					<li key={problem}>
						<UntrustedText dir="ltr" text={problem} />
					</li>
				))}
			</ul>
		</div>
	);
}
