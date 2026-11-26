import { Link } from "@tanstack/react-router";
import { GitBranchIcon, PlayIcon } from "lucide-react";
import { SESSION } from "#/lib/copy";
import { shortId } from "#/lib/format";
import { INLINE_LINK } from "#/lib/inline-link";
import type { RecordItem } from "./timeline";

/**
 * 平台在会话里留下的记录（`platform` 的 `run`、`scenario_version`，#547）：「触发了运行 3f1c2ab9 · 场景「巡检」」「保存了场景「巡检」的版本 3」，
 * 右边是第几轮。只有控制面在记下那条记录的同一个事务里写它：助手在对话里说「运行成功了」没有这一行。
 * 和助手的话明显不同：带图标的一行小字，平台自己的措辞（统一的样式在 #550）。运行和版本号链到运行监控、版本历史。
 * 场景名是登录的人写的名字（不是不可信文字，docs/DESIGN-SYSTEM.md §6.8）。
 */
export function RecordRow({ item }: { item: RecordItem }) {
	return (
		<li
			data-testid={item.kind === "run" ? "record-run" : "record-version"}
			data-record={item.kind}
			className="flex items-center gap-2 rounded-lg border border-border-soft bg-surface px-3 py-1.5 text-xs text-fg-2"
		>
			{item.kind === "run" ? (
				<PlayIcon aria-hidden className="size-3.5 flex-none text-fg-3" />
			) : (
				<GitBranchIcon aria-hidden className="size-3.5 flex-none text-fg-3" />
			)}
			<span className="min-w-0 flex-1 wrap-anywhere">
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
						{item.scenarioName}
						{SESSION.record.scenario.suffix}
					</>
				) : (
					<>
						{SESSION.record.version.prefix}
						{item.name}
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
			<span className="flex-none text-fg-3">{SESSION.record.turn(item.turn)}</span>
		</li>
	);
}
