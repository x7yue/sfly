import { useOtherEditors } from "#/lib/presence";

/** 头像里的缩写：中文取第一个字，其他取前两个字母（大写）。 */
const initials = (nickname: string): string => {
	const chars = [...nickname.trim()];
	const first = chars[0] ?? "?";
	return /^[a-z0-9]$/i.test(first) ? chars.slice(0, 2).join("").toUpperCase() : first;
};

const MAX_AVATARS = 3;

const summary = (names: string[]): string =>
	names.length <= 2 ? `${names.join("、")} 正在编辑` : `${names[0]} 等 ${names.length} 人正在编辑`;

/**
 * 在线编辑者提示：同一份编排还有别人（或自己的其他标签页）打开着编辑页面时，显示“某某正在编辑”。
 * 没有其他人时不显示。自带心跳与 SSE 订阅（见 lib/presence.ts），放进编辑页面即可。
 */
export function PresenceIndicator({ orchestrationId }: { orchestrationId: string }) {
	const names = useOtherEditors(orchestrationId);
	if (names.length === 0) return null;
	const shown = names.slice(0, MAX_AVATARS);
	return (
		<output
			className="flex h-7 items-center gap-2 rounded-[7px] border border-[var(--sf-border)] bg-[var(--sf-surface-muted)] py-0 pr-2.5 pl-1 text-xs text-[var(--sf-text)]"
			title={`正在编辑：${names.join("、")}`}
			aria-live="polite"
		>
			<span className="flex">
				{shown.map((name, i) => (
					<span
						key={name}
						className={`grid h-5 w-5 place-items-center rounded-full border border-[var(--sf-surface)] bg-[var(--sf-border)] text-[10px] font-semibold ${i > 0 ? "-ml-1.5" : ""}`}
					>
						{initials(name)}
					</span>
				))}
				{names.length > MAX_AVATARS && (
					<span className="-ml-1.5 grid h-5 min-w-5 place-items-center rounded-full border border-[var(--sf-surface)] bg-[var(--sf-surface)] px-1 font-mono text-[10px] text-[var(--sf-text-muted)]">
						+{names.length - MAX_AVATARS}
					</span>
				)}
			</span>
			<span className="max-w-64 truncate">{summary(names)}</span>
		</output>
	);
}
