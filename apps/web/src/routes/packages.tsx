import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { listPackages, type PackageSummary } from "#/lib/api";

export const Route = createFileRoute("/packages")({ component: PackagesPage });

function PackagesPage() {
	const { data, error, isPending } = useQuery({
		queryKey: ["packages"],
		queryFn: listPackages,
	});

	return (
		<div className="mx-auto max-w-5xl p-8">
			<h1 className="text-2xl font-bold">节点包</h1>
			<p className="mt-1 text-sm text-gray-500">
				用 <code>sfly build</code> 构建、<code>sfly publish</code> 发布的节点包。
			</p>
			{isPending && <p className="mt-6 text-gray-500">加载中…</p>}
			{error && <p className="mt-6 text-red-600">加载失败：{error.message}</p>}
			{data && data.packages.length === 0 && (
				<p className="mt-6 text-gray-500">还没有发布任何节点包。</p>
			)}
			<ul className="mt-6 space-y-4">
				{data?.packages.map((pkg) => (
					<PackageCard key={pkg.name} pkg={pkg} />
				))}
			</ul>
		</div>
	);
}

function PackageCard({ pkg }: { pkg: PackageSummary }) {
	const [latest, ...older] = pkg.versions;
	if (!latest) return null;
	return (
		<li className="rounded border border-gray-200 p-4">
			<div className="flex items-baseline justify-between gap-4">
				<h2 className="font-mono text-lg font-semibold">{pkg.name}</h2>
				<span className="text-sm text-gray-500">
					最新 <span className="font-mono">{latest.version}</span> · 发布于{" "}
					{new Date(latest.published_at).toLocaleString()}
				</span>
			</div>
			<table className="mt-3 w-full text-left text-sm">
				<thead className="text-gray-500">
					<tr>
						<th className="py-1 font-normal">节点类型</th>
						<th className="py-1 font-normal">标题</th>
					</tr>
				</thead>
				<tbody>
					{latest.nodes.map((node) => (
						<tr key={node.name} className="border-t border-gray-100">
							<td className="py-1 font-mono">
								{pkg.name}/{node.name}
							</td>
							<td className="py-1">{node.title}</td>
						</tr>
					))}
				</tbody>
			</table>
			<p className="mt-3 text-xs text-gray-500">
				sha256 <span className="font-mono">{latest.sha256}</span>
			</p>
			{older.length > 0 && (
				<p className="mt-1 text-xs text-gray-500">
					历史版本：
					<span className="font-mono">{older.map((v) => v.version).join("、")}</span>
				</p>
			)}
		</li>
	);
}
