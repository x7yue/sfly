import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { compareVersions } from "#/canvas/catalog";
import { listPackages, type PackageSummary } from "#/lib/api";

export const Route = createFileRoute("/packages")({ component: PackagesPage });

function PackagesPage() {
	const { data, error, isPending } = useQuery({
		queryKey: ["packages"],
		queryFn: listPackages,
	});

	return (
		<div className="sf-page">
			<h1>节点包</h1>
			<p className="sf-page__sub">
				用 <code>sfly build</code> 构建、<code>sfly publish</code> 发布的节点包。
			</p>
			{isPending && <p className="sf-hint mt-6">加载中…</p>}
			{error && <p className="sf-err mt-6">加载失败：{error.message}</p>}
			{data && data.packages.length === 0 && <p className="sf-hint mt-6">还没有发布任何节点包。</p>}
			<ul className="mt-6 space-y-4 p-0">
				{data?.packages.map((pkg) => (
					<PackageCard key={pkg.name} pkg={pkg} />
				))}
			</ul>
		</div>
	);
}

function PackageCard({ pkg }: { pkg: PackageSummary }) {
	// “最新”按版本号比较（故事 39），不是发布时间。
	const sorted = [...pkg.versions].sort((a, b) => compareVersions(b.version, a.version));
	const [latest, ...older] = sorted;
	if (!latest) return null;
	return (
		<li className="sf-card">
			<div className="flex items-baseline justify-between gap-4">
				<h2 className="m-0 font-mono text-lg font-semibold">{pkg.name}</h2>
				<span className="text-sm text-[var(--sf-text-3)]">
					最新 <span className="font-mono">{latest.version}</span> · 发布于{" "}
					{new Date(latest.published_at).toLocaleString()}
				</span>
			</div>
			<table className="sf-table mt-3!">
				<thead>
					<tr>
						<th scope="col">节点类型</th>
						<th scope="col">标题</th>
					</tr>
				</thead>
				<tbody>
					{latest.nodes.map((node) => (
						<tr key={node.name}>
							<td className="font-mono">
								{pkg.name}/{node.name}
							</td>
							<td>{node.title}</td>
						</tr>
					))}
				</tbody>
			</table>
			<p className="sf-hint">
				sha256 <span className="font-mono">{latest.sha256}</span>
			</p>
			{older.length > 0 && (
				<p className="sf-hint">
					历史版本：<span className="font-mono">{older.map((v) => v.version).join("、")}</span>
				</p>
			)}
		</li>
	);
}
