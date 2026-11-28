import type { ExposedAgent, WorkbenchExposure } from "@sfly/schema";
import { StatusPill } from "#/components/status";
import { UntrustedText } from "#/components/untrusted-text";
import { SESSION } from "#/lib/copy";
import { formatDateTime } from "#/lib/format";

/**
 * 工作台够得着项目外 Agent 的能力端口时的告警（#498）：哪几台、什么地址（出网名单容器探测到的，经不可信文字组件），该找谁做什么，
 * 隔离做到哪一层。没测成的目标、最近一轮整个没测成也写出来，不当成「一台也连不通」。没有探测结果、测成了且一台也连不通时不显示。
 * 助手页和会话页共用。
 */
export function ExposureLine({ exposure }: { exposure: WorkbenchExposure | null }) {
	if (!exposure) return null;
	const { agents, unmeasured, failed_at, checked_at } = exposure;
	if (agents.length === 0 && unmeasured.length === 0 && failed_at === null) return null;
	return (
		<div data-testid="exposure" className="text-sm">
			{agents.length > 0 && (
				<>
					<StatusPill kind="warn" className="text-sm">
						{SESSION.exposure.title}
					</StatusPill>
					<AgentList testId="exposed-agent" items={agents} />
					<p className="m-0 mt-1 pl-3.5 text-xs text-fg-3">{SESSION.exposure.hint}</p>
					<p className="m-0 pl-3.5 text-xs text-fg-3">{SESSION.exposure.isolation}</p>
				</>
			)}
			{unmeasured.length > 0 && (
				<>
					<p className="m-0 mt-1 text-xs text-fg-2">{SESSION.exposure.unmeasured}</p>
					<AgentList testId="unmeasured-agent" items={unmeasured} />
				</>
			)}
			{failed_at !== null && (
				<p data-testid="exposure-failed" className="m-0 mt-1 text-xs text-fg-2">
					{SESSION.exposure.failed(
						formatDateTime(failed_at),
						checked_at === null ? null : formatDateTime(checked_at),
					)}
				</p>
			)}
		</div>
	);
}

function AgentList({ testId, items }: { testId: string; items: ExposedAgent[] }) {
	return (
		<ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0 pl-3.5">
			{items.map((item) => (
				<li key={`${item.agent}@${item.address}`} data-testid={testId} className="text-fg-1">
					<UntrustedText text={SESSION.exposure.agent(item.agent, item.address)} />
				</li>
			))}
		</ul>
	);
}
