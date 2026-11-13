import { cn } from "cn";
import { InfoIcon, OctagonXIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * 页内横幅：需要立刻注意、而且要留在原处的页面状态（运行失败、连接断开、数据可能过期），
 * 放在它影响的区域顶部，状态解除时由页面移除，不自己计时消失。操作结果的回执用 `notify`。
 *
 *   <Banner tone="danger" title="运行失败" actions={<Button size="sm">查看失败节点</Button>}>
 *     失败于 submit（第 2 次）· 执行器异常退出
 *   </Banner>
 *
 * - 颜色之外靠图标形状区分：失败八边形、警告三角、信息圆形。
 * - `announce`：横幅出现时让读屏读一次（danger 用 alert，其余用 status）。页面已经有别的播报（例如运行状态的
 *   `<output>`）时不要打开，免得读两遍。
 * - `onDismiss`：给了才有关闭按钮；关闭只是收起，状态本身仍在页面别处可见。
 */
const TONE = {
	danger: {
		icon: OctagonXIcon,
		box: "border-danger-line bg-danger-soft",
		title: "text-danger-fg",
		role: "alert",
	},
	warn: {
		icon: TriangleAlertIcon,
		box: "border-warn-line bg-warn-soft",
		title: "text-warn-fg",
		role: "status",
	},
	info: { icon: InfoIcon, box: "border-border bg-raised", title: "text-fg-1", role: "status" },
} as const;

export type BannerTone = keyof typeof TONE;

export function Banner({
	tone,
	title,
	children,
	actions,
	onDismiss,
	announce = false,
	className,
}: {
	tone: BannerTone;
	title: string;
	/** 一两句说明：原因、影响或下一步。 */
	children?: React.ReactNode;
	/** 右侧的操作按钮（用 size="sm"）。 */
	actions?: React.ReactNode;
	onDismiss?: () => void;
	announce?: boolean;
	className?: string;
}) {
	const look = TONE[tone];
	const Icon = look.icon;
	return (
		<section
			aria-label={title}
			role={announce ? look.role : undefined}
			data-slot="banner"
			data-tone={tone}
			className={cn(
				"flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5",
				look.box,
				className,
			)}
		>
			<Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", look.title)} />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<p className={cn("m-0 text-sm font-semibold", look.title)}>{title}</p>
				{children && <div className="text-sm text-pretty text-fg-2">{children}</div>}
			</div>
			{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
			{onDismiss && (
				<Button variant="ghost" size="icon-sm" aria-label="收起" onClick={onDismiss}>
					<XIcon />
				</Button>
			)}
		</section>
	);
}
