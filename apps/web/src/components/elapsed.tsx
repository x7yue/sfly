import { formatDuration } from "#/lib/format";
import { useNow } from "#/lib/use-now";

/**
 * 「已持续多久」：从 `since`（控制面时间，毫秒）到现在，按控制面时间每秒刷新（只这一小块重新渲染）。
 * 画布节点卡片和 Agent 槽位格上「正在做」的那一行共用。
 */
export function Elapsed({ since }: { since: number }) {
	const now = useNow(true);
	return (
		<span className="ml-auto flex-none pl-1.5 font-mono text-fg-3">
			{formatDuration(now - since)}
		</span>
	);
}
