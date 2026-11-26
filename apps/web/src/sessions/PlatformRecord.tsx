import { cn } from "cn";
import { SESSION } from "#/lib/copy";
import { formatClock, formatFullDateTime } from "#/lib/format";
import { ROW_KEY_ATTRIBUTE } from "./use-timeline-scroll";

/**
 * 平台记录的外框（#550）：**控制面收到并执行了的请求、平台自己做的提交**——它们是「它做了」，不是「它说它做了」。
 * 助手说的话和命令的输出是后者；两者混在同一种样式里，人就没法只看事实。所以平台记录和助手的话明显不同：
 * 左边一条竖线、一个「平台记录」的标签、整块是平台自己的措辞（不是模型写的）；助手的话没有外框、没有标签。
 * 提交、场景版本、运行三种共用这一个外框，各自写里面的内容。
 *
 * 右边是第几轮和发生的时间（时、分、秒；悬停是完整的日期时间）。
 */
export function PlatformRecord({
	rowKey,
	testId,
	kind,
	turn,
	at,
	children,
	body,
	className,
	attributes,
}: {
	rowKey: string;
	testId: string;
	/** `commit`、`run`、`version`：给测试和样式用。 */
	kind: string;
	/** 第几轮；不知道时不写。 */
	turn?: number;
	at: string;
	/** 一行的内容（图标、一句话、展开的按钮……）；整行放在标签后面。 */
	children: React.ReactNode;
	/** 展开后的内容：放在标签行下面、同一个外框里。 */
	body?: React.ReactNode;
	className?: string;
	/** 样式和测试用的 `data-*` 属性（值为 undefined 的不写）。 */
	attributes?: Record<string, string | true | undefined>;
}) {
	return (
		<li
			{...{ [ROW_KEY_ATTRIBUTE]: rowKey }}
			data-testid={testId}
			data-platform={kind}
			{...attributes}
			className={cn(
				"overflow-hidden rounded-lg border border-l-2 border-border-soft border-l-fg-3 bg-surface",
				className,
			)}
		>
			<div className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-xs text-fg-2">
				<span
					data-testid="platform-label"
					title={SESSION.platformRecordTitle}
					className="flex-none rounded-sm bg-raised px-1.5 py-px font-semibold text-fg-2"
				>
					{SESSION.platformRecord}
				</span>
				<div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
				{turn !== undefined && (
					<span className="flex-none text-fg-3">{SESSION.record.turn(turn)}</span>
				)}
				<time
					dateTime={at}
					title={formatFullDateTime(at)}
					className="flex-none font-mono text-fg-3"
				>
					{formatClock(at)}
				</time>
			</div>
			{body}
		</li>
	);
}
