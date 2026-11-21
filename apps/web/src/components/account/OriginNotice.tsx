import { authApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { TriangleAlertIcon } from "lucide-react";
import { apiQuery } from "#/lib/api";
import { originProblem, originProblemText } from "#/lib/origin";

/**
 * 浏览器打开的地址和控制面认的公开地址不一致时的提示（登录页、初始化页和控制台的顶部）：
 * 「请用 <公开地址> 打开」。不一致时登录之后的写请求被当作没有登录，登出也不生效（ADR 0029「认证的几处细节」），
 * 不让人在一个什么都改不了的页面上干等。比较的规则在 `#/lib/origin`；开发服务器上页面的地址本来就和控制面的不同
 * （控制面用 `SFLY_DEV_ORIGINS` 认它），不提示。
 */
export function OriginNotice({ className }: { className?: string }) {
	const status = useQuery({ ...apiQuery(authApi.status), retry: false, staleTime: 60_000 });
	if (import.meta.env.DEV || !status.data) return null;
	const problem = originProblem(status.data, window.location);
	if (!problem) return null;
	return (
		<div
			role="alert"
			data-slot="origin-notice"
			className={cn(
				"flex items-start gap-2 rounded-lg border border-border-soft bg-sunk px-3 py-2 text-sm text-fg-1",
				className,
			)}
		>
			<TriangleAlertIcon aria-hidden className="mt-0.5 size-4 flex-none text-danger-fg" />
			<p className="m-0">{originProblemText(problem)}</p>
		</div>
	);
}
