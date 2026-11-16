import { formatElapsed } from "#/lib/format";
import { useNow } from "#/lib/use-now";

/**
 * 准备环境中的徽标：「准备环境中 · 2m 10s」，时长写法与槽位格、排队行一致。时长按控制面时间算，每秒走一次（ADR 0018）。
 * Agent 管理页机架的状态后面、控制台 Agent 列的名称行共用。
 */
export function PreparingBadge({ since }: { since: string }) {
	const now = useNow(true);
	return (
		<span className="text-xs text-fg-2">
			准备环境中 · {formatElapsed(now - new Date(since).getTime())}
		</span>
	);
}
