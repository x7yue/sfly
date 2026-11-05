import {
	type NodeTypeView,
	type PackageSummary,
	type PackageVersionSummary,
	packagesApi,
} from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { cn } from "cn";
import { BoxIcon } from "lucide-react";
import { z } from "zod";
import { EmptyState, ErrorState, QueryView, TableSkeleton } from "#/components/feedback/states";
import { CodeBlock, Page, PageHeader, Panel, SectionHeading } from "#/components/page";
import { apiQuery } from "#/lib/api";
import { formatBytes, formatDateTime } from "#/lib/format";
import { compareVersions } from "#/lib/package-versions";
import { ChartsCell, MetricsCell } from "#/metrics/MetricDeclarations";
import { Badge } from "@/components/ui/badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

/** 选中的包与版本放在查询参数里，可以直接分享链接；不传时选第一个包的最新版本。 */
const PackagesSearch = z.object({
	name: z.string().optional(),
	version: z.string().optional(),
});

export const Route = createFileRoute("/_shell/packages")({
	staticData: { crumb: "节点包管理" },
	validateSearch: PackagesSearch,
	component: PackagesPage,
});

/** 「最新」按版本号比较（故事 39），不是发布时间。 */
const byVersionDesc = (versions: PackageVersionSummary[]) =>
	[...versions].sort((a, b) => compareVersions(b.version, a.version));

function PackagesPage() {
	const packages = useQuery(apiQuery(packagesApi.list));
	return (
		<Page>
			<PageHeader title="节点包管理" count={packages.data?.packages.length} />
			<QueryView
				query={packages}
				loading={
					<Panel>
						<TableSkeleton columns={4} />
					</Panel>
				}
				errorTitle="无法加载节点包"
				isEmpty={(d) => d.packages.length === 0}
				empty={
					<Panel>
						<EmptyState
							icon={<BoxIcon />}
							title="还没有发布节点包"
							description="用 SDK 写好节点后，在包目录里执行构建和发布。"
						>
							<CodeBlock code="sfly build && sfly publish" className="mx-auto w-fit" />
						</EmptyState>
					</Panel>
				}
			>
				{(data) => <PackagesView packages={data.packages} />}
			</QueryView>
		</Page>
	);
}

function PackagesView({ packages }: { packages: PackageSummary[] }) {
	const search = Route.useSearch();
	const selected = packages.find((p) => p.name === search.name) ?? packages[0];
	return (
		<div className="grid grid-cols-[300px_1fr] items-start gap-3.5">
			<Panel>
				<nav aria-label="节点包">
					<ul className="m-0 list-none p-0">
						{packages.map((pkg) => (
							<li key={pkg.name}>
								<PackageListItem pkg={pkg} selected={pkg === selected} />
							</li>
						))}
					</ul>
				</nav>
			</Panel>
			{selected && <PackageDetail pkg={selected} version={search.version} />}
		</div>
	);
}

function PackageListItem({ pkg, selected }: { pkg: PackageSummary; selected: boolean }) {
	const [latest] = byVersionDesc(pkg.versions);
	// 一个场景只锁定一个包的一个版本，各版本的锁定数相加就是锁定这个包的场景数。
	const locked = pkg.versions.reduce((n, v) => n + v.locked_orchestrations, 0);
	return (
		<Link
			to="/packages"
			search={{ name: pkg.name }}
			aria-current={selected ? "true" : undefined}
			className={cn(
				"block border-b border-border-soft px-3 py-2.5 text-fg-1 no-underline hover:bg-raised",
				// 选中为中性高亮：浅一级的表面 + 左侧白色短条
				selected && "bg-raised shadow-[inset_2px_0_0_var(--primary)]",
			)}
		>
			<span className="flex items-center gap-2">
				<span className="font-mono font-medium">{pkg.name}</span>
				{latest && <Badge className="ml-auto font-mono">{latest.version}</Badge>}
			</span>
			<span className="block text-xs text-fg-3">
				{latest?.nodes.length ?? 0} 个节点类型
				{locked > 0 && ` · ${locked} 个场景`}
			</span>
		</Link>
	);
}

function PackageDetail({ pkg, version }: { pkg: PackageSummary; version: string | undefined }) {
	const versions = byVersionDesc(pkg.versions);
	const latest = versions[0];
	const current = versions.find((v) => v.version === version) ?? latest;
	const detail = useQuery({
		...apiQuery(packagesApi.version, {
			params: { name: pkg.name, version: current?.version ?? "" },
		}),
		enabled: current !== undefined,
		staleTime: Number.POSITIVE_INFINITY, // 已发布的版本不可变
	});
	if (!current) return null;

	return (
		<Panel aria-label={`${pkg.name} 详情`} className="px-4.5 py-4">
			<div className="flex flex-wrap items-center gap-2.5">
				<h2 className="m-0 font-mono text-base font-semibold">{pkg.name}</h2>
				<Badge className="font-mono">
					{current.version}
					{current === latest && " 最新"}
				</Badge>
				<span className="text-xs text-fg-3">
					发布于 {formatDateTime(current.published_at)} · {formatBytes(current.size)} ·{" "}
					{lockedText(current.locked_orchestrations)}
				</span>
			</div>
			<dl className="mt-2 mb-0 grid grid-cols-[64px_1fr] gap-x-3 text-xs">
				<dt className="text-fg-3">sha256</dt>
				<dd className="m-0 font-mono break-all text-fg-2">{current.sha256}</dd>
			</dl>

			<SectionHeading>节点类型</SectionHeading>
			{detail.data ? (
				<NodeTypeTable nodes={detail.data.metadata.nodes} />
			) : detail.isError ? (
				<ErrorState
					title="无法加载节点类型"
					error={detail.error}
					onRetry={() => detail.refetch()}
					className="my-4"
				/>
			) : (
				<TableSkeleton columns={5} rows={Math.max(1, current.nodes.length)} />
			)}

			<SectionHeading>版本</SectionHeading>
			<Table aria-label="版本">
				<TableHeader>
					<TableRow>
						<TableHead>版本</TableHead>
						<TableHead>发布时间</TableHead>
						<TableHead>sha256</TableHead>
						<TableHead>场景锁定</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{versions.map((v) => (
						<TableRow key={v.version} data-state={v === current ? "selected" : undefined}>
							<TableCell className="font-mono">
								<Link
									to="/packages"
									search={{ name: pkg.name, version: v.version }}
									aria-current={v === current ? "true" : undefined}
									className="text-fg-1 underline-offset-2 hover:underline"
								>
									{v.version}
								</Link>
							</TableCell>
							<TableCell className="font-mono text-xs text-fg-2">
								{formatDateTime(v.published_at)}
							</TableCell>
							<TableCell className="font-mono text-xs text-fg-3" title={v.sha256}>
								{v.sha256.slice(0, 12)}…
							</TableCell>
							<TableCell className="text-xs text-fg-2">
								{lockedText(v.locked_orchestrations)}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</Panel>
	);
}

const lockedText = (n: number) => (n > 0 ? `被 ${n} 个场景锁定` : "未被锁定");

/** 输入或输出的键，按 schema 里的 order（函数参数顺序）排列；必填的输入带 *。 */
function ioKeys(schema: NodeTypeView["inputs"]): { key: string; required: boolean }[] {
	const keys = schema.order ?? Object.keys(schema.properties);
	const required = new Set(schema.required ?? []);
	return keys.map((key) => ({ key, required: required.has(key) }));
}

function IoList({ schema }: { schema: NodeTypeView["inputs"] }) {
	const keys = ioKeys(schema);
	if (keys.length === 0) return <span className="text-fg-3">—</span>;
	return (
		<span className="font-mono text-xs text-fg-2">
			{keys.map(({ key, required }, i) => (
				<span key={key}>
					{i > 0 && " · "}
					{key}
					{required && (
						<span className="text-danger-fg" title="必填">
							*
						</span>
					)}
				</span>
			))}
		</span>
	);
}

function NodeTypeTable({ nodes }: { nodes: NodeTypeView[] }) {
	return (
		<Table aria-label="节点类型">
			<TableHeader>
				<TableRow>
					<TableHead>节点类型</TableHead>
					<TableHead>输入</TableHead>
					<TableHead>输出</TableHead>
					<TableHead>声明的指标</TableHead>
					<TableHead>图表</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{nodes.map((node) => (
					<TableRow key={node.name}>
						<TableCell>
							<span className="font-mono">{node.name}</span>
							<div className="text-xs text-fg-3">{node.title}</div>
						</TableCell>
						<TableCell>
							<IoList schema={node.inputs} />
						</TableCell>
						<TableCell>
							<IoList schema={node.outputs} />
						</TableCell>
						<TableCell>
							<MetricsCell info={node} />
						</TableCell>
						<TableCell>
							<ChartsCell info={node} />
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}
