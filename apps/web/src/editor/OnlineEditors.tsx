import { cn } from "cn";
import { GroupDivider } from "#/components/canvas/CanvasDock";

const initials = (nickname: string): string => {
	const chars = [...nickname.trim()];
	const first = chars[0] ?? "?";
	return /^[a-z0-9]$/i.test(first) ? chars.slice(0, 2).join("").toUpperCase() : first;
};

/**
 * 在线编辑者（画布右上控件组最左侧）：同一份场景还有别人（或自己的其他标签页，显示为「你（其他标签页）」）
 * 打开着画布时显示头像与「X 正在编辑」，后面带一条分隔线；没有时不占位。
 *
 * 名单来自 `useOtherEditors`（#/lib/presence），由画布页调用一次、传给编辑与运行状态两种右上控件组，
 * 切换模式时在线状态不中断。
 */
export function OnlineEditors({ names }: { names: readonly string[] }) {
	if (names.length === 0) return null;
	const summary =
		names.length <= 2
			? `${names.join("、")} 正在编辑`
			: `${names[0]} 等 ${names.length} 人正在编辑`;
	return (
		<>
			<output
				aria-live="polite"
				title={`正在编辑：${names.join("、")}`}
				className="flex items-center gap-1.5 px-1.5"
			>
				<span className="flex">
					{names.slice(0, 3).map((name, i) => (
						<span
							key={name}
							aria-hidden
							className={cn(
								"grid size-5.5 place-items-center rounded-full border border-surface bg-raised-2 text-2xs font-semibold text-fg-1",
								i > 0 && "-ml-1.5",
							)}
						>
							{initials(name)}
						</span>
					))}
				</span>
				<span className="max-w-48 truncate text-xs text-fg-2">{summary}</span>
			</output>
			<GroupDivider />
		</>
	);
}
