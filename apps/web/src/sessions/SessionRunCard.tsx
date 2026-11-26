import { errorHeadline, runViewFailures } from "@sfly/schema";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useContext } from "react";
import { Elapsed } from "#/components/elapsed";
import { runNodeName } from "#/components/node-name";
import { StatusPill } from "#/components/status";
import { MESSAGE, SESSION } from "#/lib/copy";
import { formatDuration, shortId } from "#/lib/format";
import { untrustedPlain } from "#/lib/untrusted-text";
import { useRunView } from "#/monitor/live-run";
import { runStatus } from "#/monitor/run-model";
import { Truncate } from "@/components/ui/truncate";
import { LiveRunsContext } from "./use-live-runs";

/**
 * 会话里的运行卡片（#551）：时间线上平台记录下面内嵌的和成果栏里的是**同一个组件**——场景名、运行 ID 的前几位、状态（实时）、用时，
 * 失败时第一个失败的节点和原因一行；整张卡片是链接，点开进运行监控。
 *
 * 状态和运行监控读同一份缓存（`useRunView`）：这个运行在会话页的「事件流名额」里（`LiveRunsContext`，最近的 3 个在跑的运行）时，
 * 由运行事件流推送，和运行监控同时变；时间线上的和成果栏里的同一个运行共用一条连接。没有名额的定时重新读（5 秒），慢一点但不会漏
 * （浏览器对同源只给 6 条连接，不能每个在跑的运行都开一条，`sessions/live-runs.ts`）。
 *
 * 场景名是触发那一刻的（事件里记的），当作别人写的文字（会话令牌能写场景：新建、改名、保存版本）；失败原因是节点（别人写的代码）报的，
 * 整句经 `Truncate untrusted`。
 */
export function SessionRunCard({
	runId,
	scenarioName,
	className,
}: {
	runId: string;
	scenarioName: string;
	className?: string;
}) {
	const stream = useContext(LiveRunsContext).has(runId);
	const query = useRunView(runId, { stream });
	const run = query.data;
	const status = run ? runStatus(run) : null;
	const first = run ? runViewFailures(run.chains)[0] : undefined;
	const failure =
		run?.status === "failed" && first
			? SESSION.runCard.failed(runNodeName(first.node), errorHeadline(first.node.error?.message))
			: null;
	const label = `${shortId(runId)} · ${untrustedPlain(scenarioName)}${
		failure === null ? "" : ` · ${untrustedPlain(failure)}`
	}`;
	return (
		<Truncate
			label={label}
			render={
				<Link
					to="/runs/$id"
					params={{ id: runId }}
					data-testid="run-card"
					data-run={runId}
					data-status={run?.status}
					aria-description={SESSION.record.openRun}
					className={cn(
						"flex min-w-0 flex-col gap-1 rounded-md border border-border-soft bg-surface px-2.5 py-1.5 text-xs no-underline hover:bg-raised",
						className,
					)}
				/>
			}
		>
			<span className="flex min-w-0 items-baseline gap-2">
				<Truncate untrusted className="flex-1 font-medium text-fg-1">
					{scenarioName}
				</Truncate>
				<span data-slot="run-id" className="flex-none font-mono text-fg-2">
					{shortId(runId)}
				</span>
			</span>
			<span className="flex items-center gap-2">
				<span data-testid="run-card-status">
					{status ? (
						<StatusPill kind={status.kind} pulse={status.kind === "running"}>
							{status.label}
						</StatusPill>
					) : query.isError ? (
						<span className="text-fg-3">{SESSION.runCard.unknown}</span>
					) : (
						<span className="text-fg-3">{MESSAGE.loading}</span>
					)}
				</span>
				{run && (
					<span
						data-testid="run-card-elapsed"
						title={SESSION.runCard.elapsed}
						className="ml-auto flex-none font-mono text-fg-3"
					>
						{run.ended_at === null ? (
							<Elapsed since={Date.parse(run.started_at)} />
						) : (
							formatDuration(Date.parse(run.ended_at) - Date.parse(run.started_at))
						)}
					</span>
				)}
			</span>
			{failure !== null && (
				<span data-testid="run-card-failure" className="flex min-w-0">
					<Truncate untrusted className="text-danger-fg">
						{failure}
					</Truncate>
				</span>
			)}
		</Truncate>
	);
}
