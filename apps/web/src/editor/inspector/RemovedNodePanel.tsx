import { REMOVED_NODE_KINDS, removedKindLabel, removedOutputsAdvice } from "@sfly/schema";
import type { RemovedDocNode } from "#/components/canvas/flow";
import { SectionTitle } from "./fields";

/** 已移除节点的检查器内容里不再显示的字段：它们已经在检查器别处（ID、位置）或不属于配置。 */
const SHARED_FIELDS = new Set(["id", "kind", "position", "note", "display_name"]);

/** 节点当时的配置（共有字段之外的全部）；没有时为 undefined。 */
function legacyConfig(node: RemovedDocNode): string | undefined {
	const config = Object.fromEntries(
		Object.entries(node).filter(([key]) => !SHARED_FIELDS.has(key)),
	);
	return Object.keys(config).length === 0 ? undefined : JSON.stringify(config, null, 2);
}

/**
 * 已移除种类的节点（ADR 0028）的检查器：写明它为什么不能再用、怎么替换，把它当时的配置只读地列出来
 * （改写成别的做法时照着写）。删掉它（顶上的删除按钮）之后才能保存，前后的节点会自动接上。
 */
export function RemovedNodePanel({ node }: { node: RemovedDocNode }) {
	const config = legacyConfig(node);
	const { label, replacement } = REMOVED_NODE_KINDS[node.kind];
	const referenced = removedOutputsAdvice(node.kind);
	return (
		<>
			<p className="m-0 text-xs text-fg-2">
				{`这个节点的类型（${removedKindLabel(node.kind)}，原来的「${label}」）已不再支持，不能运行，也不能保存。替换办法：${replacement}。删掉这个节点之后才能保存，它前后的节点会自动接上；${referenced}历史版本和历史运行里它照常显示。`}
			</p>
			{config !== undefined && (
				<>
					<SectionTitle>当时的配置</SectionTitle>
					<pre className="m-0 max-h-80 overflow-auto rounded-md bg-sunk p-2 font-mono text-xs leading-5 wrap-anywhere whitespace-pre-wrap text-fg-2">
						{config}
					</pre>
				</>
			)}
		</>
	);
}
