import { Link } from "@tanstack/react-router";
import { INLINE_LINK } from "#/lib/inline-link";
import { OriginNotice } from "./OriginNotice";

/**
 * 登录页和初始化页的外框（全屏，不带侧边栏和顶栏）：居中的一张卡片，上面是标志和标题。
 * 页面内容（表单）由使用方给出；`footer` 放卡片下面的指路（去登录、去初始化）。
 */
export function AuthPage({
	title,
	description,
	children,
	footer,
}: {
	title: string;
	description?: React.ReactNode;
	children: React.ReactNode;
	footer?: React.ReactNode;
}) {
	return (
		<main className="fixed inset-0 grid place-items-center overflow-auto bg-bg px-4 py-10">
			<div className="flex w-full max-w-90 flex-col gap-5">
				<div className="flex items-center gap-2.5">
					<span className="grid size-8 flex-none place-items-center rounded-lg bg-primary font-mono text-sm font-semibold text-primary-foreground">
						sf
					</span>
					<div className="leading-tight">
						<span className="block text-base font-semibold">sfly</span>
						<span className="block text-xs text-fg-3">测试编排平台</span>
					</div>
				</div>
				<OriginNotice />
				<section
					aria-labelledby="auth-title"
					className="flex flex-col gap-4 rounded-xl border border-border-soft bg-surface p-5"
				>
					<div className="flex flex-col gap-1">
						<h1 id="auth-title" className="m-0 text-lg font-semibold text-fg-1">
							{title}
						</h1>
						{description && <p className="m-0 text-sm text-fg-2">{description}</p>}
					</div>
					{children}
				</section>
				{footer && <p className="m-0 text-sm text-fg-3">{footer}</p>}
			</div>
		</main>
	);
}

/** 卡片下面的指路链接。 */
export function AuthLink({ to, children }: { to: "/login" | "/setup"; children: React.ReactNode }) {
	return (
		<Link to={to} className={INLINE_LINK}>
			{children}
		</Link>
	);
}
