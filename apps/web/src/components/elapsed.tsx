import { formatElapsed } from "#/lib/format";
import { useNow } from "#/lib/use-now";

/** 已持续多久（`formatElapsed`），按控制面时间每秒刷新，只这一小块重新渲染：节点卡片上的「正在做」、动作表里进行中的耗时。 */
export function Elapsed({ since, className }: { since: number; className?: string }) {
	const now = useNow(true);
	return <span className={className}>{formatElapsed(now - since)}</span>;
}
