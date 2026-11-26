import type { SessionRef } from "@sfly/schema";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { UntrustedText } from "#/components/untrusted-text";
import { SESSION, viaLabel } from "#/lib/copy";
import { formatDateTime } from "#/lib/format";
import { INLINE_LINK } from "#/lib/inline-link";

/**
 * 跟在触发人、取消人、版本作者后面的「经 Claude Code」。没有经 AI 编程助手时什么都不渲染，
 * 所以人在浏览器里的操作显示和以前完全一样。前面带一个空格，直接接在名字后面。
 *
 * **经会话**（`session`，会话令牌的请求，#547）：写「经 会话「<标题>」」，标题链到会话页。这是控制面按请求带的会话令牌记下的，
 * 可信；`via` 是请求头里的标注，不经校验。有会话时只写会话（命令行在工作台上带的 `AI_AGENT=pi` 标注是同一件事，不再写一遍）。
 */
export function ViaTag({
	via,
	session,
	className,
}: {
	via: string | null;
	session?: SessionRef | undefined;
	className?: string;
}) {
	if (session) {
		return (
			<span data-slot="via" data-via="session" className={cn(className)}>
				{" "}
				{SESSION.via.prefix}
				<Link
					to="/sessions/$id"
					params={{ id: session.id }}
					title={SESSION.via.open}
					className={INLINE_LINK}
				>
					{/* 会话的标题是第一句话：别人写的文字。 */}
					<UntrustedText text={session.title} />
				</Link>
				{SESSION.via.suffix}
			</span>
		);
	}
	if (!via) return null;
	return (
		<span data-slot="via" className={cn(className)}>
			{" "}
			{/* 请求头里的名称不可信：viaLabel 已把看不见的字符写成文字，这里再把文字方向隔离在自己的范围里。 */}
			<UntrustedText text={viaLabel(via)} />
		</span>
	);
}

/** 「tester 经 Claude Code 触发 · 开始 01-01 09:05」：运行的触发人和开始时间（控制台的运行块、运行记录的卡片、运行监控页顶栏）。 */
export function TriggeredAt({
	by,
	via = null,
	session,
	at,
}: {
	by: string;
	via?: string | null;
	session?: SessionRef | undefined;
	at: string;
}) {
	return (
		<>
			{by}
			<ViaTag via={via} session={session} /> 触发 · 开始{" "}
			<span className="font-mono">{formatDateTime(at)}</span>
		</>
	);
}
