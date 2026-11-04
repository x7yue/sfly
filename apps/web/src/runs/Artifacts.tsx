import { useQuery } from "@tanstack/react-query";
import { Section } from "#/canvas/Inspector";
import { apiGet } from "#/lib/api";

/** 任务的产物（#18）。字段与 apps/server/src/http/artifact-routes.ts 一致。 */
export interface ArtifactView {
	/** 产物目录内的相对路径（`/` 分隔）。 */
	name: string;
	size: number;
	sha256: string;
	created_at: string;
	/** 对 Agent 可见的下载地址（节点输出里的产物引用）；浏览器用 {@link artifactDownloadPath}。 */
	url: string;
}

interface ArtifactList {
	task_id: string;
	artifacts: ArtifactView[];
	expired: boolean;
}

/** 浏览器下载产物的同源地址。 */
export const artifactDownloadPath = (taskId: string, name: string) =>
	`/api/tasks/${taskId}/artifacts/${name.split("/").map(encodeURIComponent).join("/")}`;

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const units = ["KB", "MB", "GB"];
	let value = n / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * 节点详情里的产物列表：任务结束前由 Agent 上传，结束后可以下载。
 * 没有产物时不显示；运行过了保留期被清理后显示说明。
 */
export function TaskArtifacts({ taskId, status }: { taskId: string; status: string }) {
	// 状态变化（尤其是结束）时重新加载：产物在上报结果之前上传完。
	const query = useQuery({
		queryKey: ["artifacts", taskId, status],
		queryFn: () => apiGet<ArtifactList>(`/tasks/${taskId}/artifacts`),
	});
	const data = query.data;
	if (!data) return null;
	if (data.expired) {
		return (
			<Section title="产物">
				<p className="sf-hint">这次运行的产物已超过保留期，已被清理。</p>
			</Section>
		);
	}
	if (data.artifacts.length === 0) return null;
	const total = data.artifacts.reduce((n, a) => n + a.size, 0);
	return (
		<Section title="产物" aside={`${data.artifacts.length} 个 · ${formatBytes(total)}`}>
			<ul className="sf-artifacts">
				{data.artifacts.map((a) => (
					<li key={a.name}>
						<a
							href={artifactDownloadPath(taskId, a.name)}
							download
							title={`sha256 ${a.sha256}`}
							className="sf-artifacts__name"
						>
							{a.name}
						</a>
						<span className="sf-artifacts__size">{formatBytes(a.size)}</span>
						<a
							className="sf-btn sf-btn--ghost sf-btn--sm"
							href={artifactDownloadPath(taskId, a.name)}
							download
							aria-label={`下载 ${a.name}`}
						>
							下载
						</a>
					</li>
				))}
			</ul>
		</Section>
	);
}
