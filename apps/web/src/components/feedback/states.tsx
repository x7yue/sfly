import type { UseQueryResult } from "@tanstack/react-query";
import { cn } from "cn";
import { CopyIcon, RotateCwIcon } from "lucide-react";
import { ApiError } from "#/lib/api";
import { ACTION, MESSAGE } from "#/lib/copy";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "./notify";

/**
 * 统一的空状态、加载骨架、错误提示（docs/DESIGN-SYSTEM.md「状态」）。
 * 列表页用 QueryView 把一个查询的四种状态（加载 / 错误 / 空 / 有数据）接到这些组件上：
 *
 *   <QueryView query={agents} loading={<TableSkeleton columns={8} />}
 *     isEmpty={(d) => d.agents.length === 0} empty={<EmptyState … />} errorTitle="无法加载 Agent">
 *     {(data) => <AgentTable agents={data.agents} />}
 *   </QueryView>
 */

export function EmptyState({
	icon,
	title,
	description,
	children,
	className,
}: {
	icon?: React.ReactNode;
	title: string;
	description?: React.ReactNode;
	/** 下一步操作：按钮、命令示例等。 */
	children?: React.ReactNode;
	className?: string;
}) {
	return (
		<section
			aria-label={title}
			className={cn("px-5 py-14 text-center text-fg-2 [&_svg]:size-5", className)}
		>
			{icon && (
				<div className="mx-auto mb-3.5 grid size-11 place-items-center rounded-xl border border-border bg-raised text-fg-3">
					{icon}
				</div>
			)}
			<h3 className="m-0 mb-1.5 text-base font-semibold text-fg-1">{title}</h3>
			{description && <p className="m-0 mb-4 text-sm">{description}</p>}
			{children}
		</section>
	);
}

/** 表格形状的加载骨架（原型 stateBlock('loading')）：rows 行 × columns 列。 */
export function TableSkeleton({ columns, rows = 5 }: { columns: number; rows?: number }) {
	const widths = ["70%", "40%", "55%", "30%", "45%", "35%", "50%"];
	return (
		<output aria-label={MESSAGE.loading} aria-busy="true" className="block">
			<table className="w-full">
				<tbody>
					{Array.from({ length: rows }, (_, r) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: 骨架行没有标识
						<tr key={r} className="border-b border-border-soft last:border-0">
							{Array.from({ length: columns }, (_, c) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: 骨架列没有标识
								<td key={c} className="px-3 py-3">
									<Skeleton className="h-3" style={{ width: widths[c % widths.length] }} />
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</output>
	);
}

/** 错误的一行摘要，用于错误详情：`GET /api/agents → 503 internal_error`。 */
export function errorSummary(error: unknown): string {
	if (error instanceof ApiError) {
		const request = error.method && error.path ? `${error.method} /api${error.path} → ` : "";
		const status = error.status ? `${error.status} ` : "";
		return `${request}${status}${error.code}`;
	}
	return error instanceof Error ? error.message : String(error);
}

function errorDetailsText(error: unknown): string {
	const lines = [errorSummary(error)];
	if (error instanceof Error) lines.push(error.message);
	if (error instanceof ApiError && error.details !== undefined) {
		lines.push(JSON.stringify(error.details, null, 2));
	}
	return lines.join("\n");
}

/** 加载失败（原型 `.err`）：标题、原因、错误详情，「重试」与「复制错误详情」。 */
export function ErrorState({
	title,
	error,
	onRetry,
	className,
}: {
	title: string;
	error: unknown;
	onRetry?: () => void;
	className?: string;
}) {
	const message =
		error instanceof ApiError && error.status === 0
			? "无法连接控制面，请检查网络或控制面是否在运行。"
			: error instanceof Error
				? error.message
				: String(error);
	return (
		<div
			role="alert"
			className={cn(
				"mx-auto my-10 max-w-[520px] rounded-lg border border-danger-line bg-danger-soft px-4.5 py-4",
				className,
			)}
		>
			<h3 className="m-0 mb-1.5 text-base font-semibold text-danger-fg">{title}</h3>
			<p className="m-0 mb-2.5 text-sm text-fg-2">{message}</p>
			<code className="block font-mono text-xs break-all text-fg-2">{errorSummary(error)}</code>
			<div className="mt-3 flex gap-2">
				{onRetry && (
					<Button onClick={onRetry}>
						<RotateCwIcon />
						{ACTION.retry}
					</Button>
				)}
				<Button
					variant="ghost"
					onClick={() => {
						void navigator.clipboard
							.writeText(errorDetailsText(error))
							.then(() => notify.success("已复制错误详情"))
							.catch(() => notify.error("复制失败", { description: "浏览器不允许访问剪贴板" }));
					}}
				>
					<CopyIcon />
					{ACTION.copyErrorDetails}
				</Button>
			</div>
		</div>
	);
}

/** 把一个查询的加载 / 错误 / 空 / 有数据四种状态接到统一的组件上。 */
export function QueryView<T>({
	query,
	loading,
	errorTitle,
	isEmpty,
	empty,
	children,
}: {
	query: UseQueryResult<T>;
	loading: React.ReactNode;
	errorTitle: string;
	isEmpty?: (data: T) => boolean;
	empty?: React.ReactNode;
	children: (data: T) => React.ReactNode;
}) {
	// 已有数据时后台刷新失败不打断页面（数据保留），只在没有数据时显示错误。
	if (query.data === undefined) {
		if (query.isError) {
			return <ErrorState title={errorTitle} error={query.error} onRetry={() => query.refetch()} />;
		}
		return loading;
	}
	if (isEmpty?.(query.data)) return empty;
	return children(query.data);
}
