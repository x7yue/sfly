import { cn } from "cn";
import type { completionGroups, ReferenceChoice } from "./reference-completion";

/**
 * 引用补全列表：按「入口参数」「前序节点」分组，鼠标点选；键盘的上下与确认由输入框处理（active 是当前项）。
 * 绝对定位在最近的 relative 祖先里，左右撑满；纵向位置由 className 给出。
 * 它是输入框下方的普通元素，不是模态浮层：打开时画布照常缩放、拖动，不锁定滚动。
 */
export function ReferenceList({
	id,
	className,
	choices,
	groups,
	ordered,
	active,
	onChoose,
}: {
	id: string;
	className?: string;
	/** 过滤之前的全部候选：区分「没有可引用的值」和「没有匹配的」。 */
	choices: readonly ReferenceChoice[];
	groups: ReturnType<typeof completionGroups>["groups"];
	ordered: readonly ReferenceChoice[];
	active: number;
	onChoose(choice: ReferenceChoice): void;
}) {
	return (
		<div
			id={id}
			role="listbox"
			aria-label="可引用的值"
			className={cn(
				"absolute right-0 left-0 z-20 max-h-65 overflow-auto rounded-lg border border-border-strong bg-raised p-1 shadow-pop",
				className,
			)}
		>
			{ordered.length === 0 ? (
				<p className="m-0 px-2 py-1.5 text-xs text-fg-3">
					{choices.length === 0 ? "本链上没有可引用的参数或前序节点的输出" : "没有匹配的引用"}
				</p>
			) : (
				groups.map(
					({ title, choices: items }) =>
						items.length > 0 && (
							// biome-ignore lint/a11y/useSemanticElements: listbox 里的分组用 role=group
							<div key={title} role="group" aria-label={title}>
								<div className="px-2 pt-1.5 pb-0.75 text-2xs text-fg-3">{title}</div>
								{items.map((c) => {
									const index = ordered.indexOf(c);
									return (
										<div
											key={c.expression}
											role="option"
											tabIndex={-1}
											aria-selected={index === active}
											className={cn(
												"flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-raised-2",
												index === active && "bg-raised-2",
											)}
											onMouseDown={(e) => e.preventDefault()}
											onClick={() => onChoose(c)}
											onKeyDown={() => {}}
										>
											<span className="min-w-0 flex-1 truncate font-mono" title={c.expression}>
												{c.expression}
											</span>
											<span className="flex-none text-2xs text-fg-3">{c.detail}</span>
										</div>
									);
								})}
							</div>
						),
				)
			)}
		</div>
	);
}
