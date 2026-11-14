import { type DocPageView, docsApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { BookOpenIcon } from "lucide-react";
import { EmptyState, ErrorState, QueryView } from "#/components/feedback/states";
import { Page, PageHeader, Panel } from "#/components/page";
import { apiQuery, apiTextQuery } from "#/lib/api";
import { PAGE } from "#/lib/copy";
import { Skeleton } from "@/components/ui/skeleton";
import { Markdown } from "./Markdown";

/**
 * 「开发文档」页（ADR 0013）：左侧是文档目录（控制面 docs/guide/pages.json 的顺序），右侧渲染一页的
 * Markdown 原文（控制面已替换占位符，与 AI 编程助手用 curl 读到的相同）。`slug` 不传时显示第一页。
 */
export function DocsPage({ slug }: { slug?: string }) {
	const list = useQuery(apiQuery(docsApi.list));
	return (
		<Page>
			<PageHeader title={PAGE.docs} />
			<QueryView
				query={list}
				loading={<Skeleton className="h-60" />}
				errorTitle="无法加载文档目录"
				isEmpty={(d) => d.pages.length === 0}
				empty={
					<Panel>
						<EmptyState
							icon={<BookOpenIcon />}
							title="还没有文档"
							description="控制面没有找到用户文档目录（SFLY_DOCS_DIR）。"
						/>
					</Panel>
				}
			>
				{({ pages }) => {
					const current = slug ?? (pages[0] as DocPageView).slug;
					return (
						<div className="grid grid-cols-[180px_minmax(0,1fr)] items-start gap-5">
							<DocsNav pages={pages} current={current} />
							<DocArticle
								slug={current}
								title={pages.find((p) => p.slug === current)?.title ?? current}
							/>
						</div>
					);
				}}
			</QueryView>
		</Page>
	);
}

function DocsNav({ pages, current }: { pages: readonly DocPageView[]; current: string }) {
	return (
		<nav aria-label="文档目录" className="sticky top-5 flex flex-col gap-0.5">
			{pages.map((p) => (
				<Link
					key={p.slug}
					to="/docs/$page"
					params={{ page: p.slug }}
					aria-current={p.slug === current ? "page" : undefined}
					className={cn(
						"rounded-md px-2.5 py-1.5 text-sm text-fg-2 hover:bg-raised hover:text-fg-1",
						"aria-[current=page]:selected-row aria-[current=page]:text-fg-1 aria-[current=page]:hover:bg-selected-bg",
					)}
				>
					{p.title}
				</Link>
			))}
		</nav>
	);
}

function DocArticle({ slug, title }: { slug: string; title: string }) {
	const doc = useQuery(apiTextQuery(docsApi.page, { params: { page: slug } }));
	if (doc.data === undefined) {
		if (doc.isError) {
			return <ErrorState title="无法加载文档" error={doc.error} onRetry={() => doc.refetch()} />;
		}
		return <Skeleton className="h-60" />;
	}
	return (
		<Panel className="overflow-visible">
			<article aria-label={title} className="max-w-[820px] px-7 py-6">
				<Markdown source={doc.data} />
				<p className="mt-8 mb-0 border-t border-border-soft pt-3 text-xs text-fg-3">
					Markdown 原文：
					<a href={`/docs/${slug}.md`} className="font-mono text-fg-2 underline underline-offset-2">
						/docs/{slug}.md
					</a>
				</p>
			</article>
		</Panel>
	);
}
