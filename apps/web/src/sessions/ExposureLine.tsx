import type { WorkbenchExposure } from "@sfly/schema";
import { StatusPill } from "#/components/status";
import { UntrustedText } from "#/components/untrusted-text";
import { SESSION } from "#/lib/copy";
import { formatDateTime } from "#/lib/format";

/**
 * 工作台够得着项目外 Agent 的能力端口时的告警（#498）：哪几台、什么地址（出网名单容器探测到的，经不可信文字组件），该找谁做什么，
 * 隔离做到哪一层。没测成的目标只写个数（不列别的项目的 Agent），最近一轮整个没测成写明时间和原因，都不当成「一台也连不通」。
 * 没有探测结果、测成了且一台也连不通时不显示。助手页和会话页共用。
 */
export function ExposureLine({ exposure }: { exposure: WorkbenchExposure | null }) {
	if (!exposure) return null;
	const { agents, unmeasured, failed_at, failure, checked_at } = exposure;
	if (agents.length === 0 && unmeasured === 0 && failed_at === null) return null;
	return (
		<div data-testid="exposure" className="text-sm">
			{agents.length > 0 && (
				<>
					<StatusPill kind="warn" className="text-sm">
						{SESSION.exposure.title}
					</StatusPill>
					<ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0 pl-3.5">
						{agents.map((item) => (
							<li
								key={`${item.agent}@${item.address}`}
								data-testid="exposed-agent"
								className="text-fg-1"
							>
								<UntrustedText text={SESSION.exposure.agent(item.agent, item.address)} />
							</li>
						))}
					</ul>
					<p className="m-0 mt-1 pl-3.5 text-xs text-fg-3">{SESSION.exposure.hint}</p>
					<p className="m-0 pl-3.5 text-xs text-fg-3">{SESSION.exposure.isolation}</p>
				</>
			)}
			{unmeasured > 0 && (
				<p data-testid="exposure-unmeasured" className="m-0 mt-1 text-xs text-fg-2">
					{SESSION.exposure.unmeasured(unmeasured)}
				</p>
			)}
			{failed_at !== null && (
				<p data-testid="exposure-failed" className="m-0 mt-1 text-xs text-fg-2">
					{SESSION.exposure.failed(
						formatDateTime(failed_at),
						failure === "no_probe",
						checked_at === null ? null : formatDateTime(checked_at),
					)}
				</p>
			)}
		</div>
	);
}
