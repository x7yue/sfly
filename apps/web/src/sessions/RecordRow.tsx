import { Link } from "@tanstack/react-router";
import { GitBranchIcon, PlayIcon } from "lucide-react";
import { SESSION } from "#/lib/copy";
import { shortId } from "#/lib/format";
import { INLINE_LINK } from "#/lib/inline-link";
import { Truncate } from "@/components/ui/truncate";
import { PlatformRecord } from "./PlatformRecord";
import { SessionRunCard } from "./SessionRunCard";
import type { RecordItem } from "./timeline";

/** 句子中间的一个名字：别人写的文字，行内，最宽 18rem，放不下的截断，悬停给全文。 */
function Name({ children }: { children: string }) {
	return (
		<Truncate untrusted render={<span className="inline-block max-w-72 align-bottom" />}>
			{children}
		</Truncate>
	);
}

/**
 * 平台在会话里留下的记录（`platform` 的 `run`、`scenario_version`，#547）：「触发了运行 3f1c2ab9 · 场景「巡检」」「保存了场景「巡检」的版本 3」，
 * 右边是第几轮和时间。只有控制面在记下那条记录的同一个事务里写它：助手在对话里说「运行成功了」没有这一行。
 * 和助手的话明显不同（`PlatformRecord` 的外框：左边一条竖线和「平台记录」的标签，#550）。运行和版本号链到运行监控、版本历史。
 * 运行那一行下面内嵌运行卡片（`SessionRunCard`，#551）：状态实时、失败时写第一个失败的节点和原因。
 * 场景名当作别人写的文字（`Truncate untrusted`，见 `Name`）：会话令牌能写场景（新建、改名、保存版本），名字不再只是登录的人写的，
 * 看不见的字符和文字方向要处理，太长的要截断（docs/DESIGN-SYSTEM.md「不可信的文字」）。
 */
export function RecordRow({ item }: { item: RecordItem }) {
	return (
		<PlatformRecord
			rowKey={item.key}
			testId={item.kind === "run" ? "record-run" : "record-version"}
			kind={item.kind}
			turn={item.turn}
			at={item.at}
			// 运行下面内嵌运行卡片（#551）：和成果栏里的是同一个组件，状态和运行监控里的一致。
			body={
				item.kind === "run" ? (
					<SessionRunCard
						runId={item.runId}
						scenarioName={item.scenarioName}
						className="mx-3 mb-2 w-auto max-w-md"
					/>
				) : undefined
			}
		>
			{item.kind === "run" ? (
				<PlayIcon aria-hidden className="size-3.5 flex-none text-fg-3" />
			) : (
				<GitBranchIcon aria-hidden className="size-3.5 flex-none text-fg-3" />
			)}
			<span className="min-w-0 flex-1 wrap-anywhere text-fg-1">
				{item.kind === "run" ? (
					<>
						{SESSION.record.run}{" "}
						<Link
							to="/runs/$id"
							params={{ id: item.runId }}
							title={SESSION.record.openRun}
							data-slot="run-id"
							className={`${INLINE_LINK} font-mono`}
						>
							{shortId(item.runId)}
						</Link>{" "}
						· {SESSION.record.scenario.prefix}
						<Name>{item.scenarioName}</Name>
						{SESSION.record.scenario.suffix}
					</>
				) : (
					<>
						{SESSION.record.version.prefix}
						<Name>{item.name}</Name>
						{SESSION.record.version.suffix}
						<Link
							to="/orchestrations/$id/versions"
							params={{ id: item.scenarioId }}
							search={{ b: item.version }}
							title={SESSION.record.openVersion}
							className={INLINE_LINK}
						>
							{SESSION.record.versionLabel(item.version)}
						</Link>
					</>
				)}
			</span>
		</PlatformRecord>
	);
}
