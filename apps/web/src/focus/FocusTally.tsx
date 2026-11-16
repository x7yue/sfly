import type { RunFocusItem } from "@sfly/schema";
import { FOCUS } from "#/lib/copy";
import { countAttention } from "./focus-preview";

/**
 * 关注项标题后面的「4 · 2 项需要注意」：项数和其中有异常的项数（{@link countAttention}），没有异常时只有项数。控制台运行块的
 * 读数区和画布概况的关注项共用；`showCount` 为 false 时不写项数（场景没设关注项、读数是主指标时不数个数）。
 */
export function FocusTally({
	items,
	showCount = true,
}: {
	items: readonly Pick<RunFocusItem, "anomaly">[];
	showCount?: boolean;
}) {
	const attention = countAttention(items);
	return (
		<>
			{showCount && <span className="font-mono">{items.length}</span>}
			{attention > 0 && <span className="text-warn-fg">· {FOCUS.attentionCount(attention)}</span>}
		</>
	);
}
