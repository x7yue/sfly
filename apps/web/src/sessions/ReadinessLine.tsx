import type { Readiness } from "@sfly/schema";
import { StatusPill } from "#/components/status";
import { UntrustedText } from "#/components/untrusted-text";
import { SESSION } from "#/lib/copy";
import { readinessItems } from "./session-text";

/** 就绪状态那一块的 id：「开始」和输入框用 aria-describedby 指向它（不能用的原因只在这里写一处）。 */
export const READINESS_ID = "assistant-readiness";

/**
 * 输入框旁边的就绪状态（#541、#548，定稿 #551）：
 * - 可以用：一行小字「可以用 · 工作台 X 在线」，放在「开始」旁边；
 * - 不能用：「现在不能用：」下面逐条写，每条两句——缺什么（控制面写的，带具体的变量名、哪一台）、该找谁做什么（页面按种类写，
 *   例如「没有配置模型：<缺什么>」下面写「请部署者在助手容器上配置模型」），放在输入框和「开始」之间。
 * 缺什么那一句可能嵌着别人写的文字（助手服务报的原因、工作台的名字），经不可信文字组件。
 */
export function ReadinessLine({ readiness }: { readiness: Readiness }) {
	if (readiness.ready) {
		return (
			<p id={READINESS_ID} data-testid="readiness" data-ready="true" className="m-0 text-xs">
				<StatusPill kind="ok" className="text-fg-3">
					<UntrustedText text={SESSION.ready(readiness.workbench)} />
				</StatusPill>
			</p>
		);
	}
	return (
		<div id={READINESS_ID} data-testid="readiness" data-ready="false" className="text-sm">
			<StatusPill kind="warn" className="text-sm">
				{SESSION.notReady}
			</StatusPill>
			<ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0 pl-3.5">
				{readinessItems(readiness).map((item) => (
					<li
						key={`${item.kind}:${item.what}`}
						data-testid="readiness-problem"
						data-kind={item.kind}
					>
						<span className="block text-fg-1">
							<UntrustedText text={item.what} />
						</span>
						<span data-testid="readiness-hint" className="block text-xs text-fg-3">
							{item.hint}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}
