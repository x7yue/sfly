import { Link } from "@tanstack/react-router";
import { GitBranchIcon, PlayIcon } from "lucide-react";
import { SESSION } from "#/lib/copy";
import { shortId } from "#/lib/format";
import { INLINE_LINK } from "#/lib/inline-link";
import { Truncate } from "@/components/ui/truncate";
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
 * 右边是第几轮。只有控制面在记下那条记录的同一个事务里写它：助手在对话里说「运行成功了」没有这一行。
 * 和助手的话明显不同：带图标的一行小字，平台自己的措辞（统一的样式在 #550）。运行和版本号链到运行监控、版本历史。
 * 场景名当作别人写的文字（`Truncate untrusted`，见 `Name`）：会话令牌能写场景（新建、改名、保存版本），名字不再只是登录的人写的，
 * 看不见的字符和文字方向要处理，太长的要截断（docs/DESIGN-SYSTEM.md「不可信的文字」）。
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
			<span className="flex-none text-fg-3">{SESSION.record.turn(item.turn)}</span>
		</li>
	);
}
