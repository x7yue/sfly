import type { OrchestrationWarning } from "@sfly/orchestration";
import type { OrchestrationDocument } from "@sfly/schema";
import { ApiError, apiGet, apiPost, type SavedVersion } from "#/lib/api";

/** 编排版本历史与冲突相关的控制面 API（#16）。 */

export interface VersionSummary {
	number: number;
	author: string;
	created_at: string;
}

export interface OrchestrationVersion extends VersionSummary {
	id: string;
	orchestration_id: string;
	document: OrchestrationDocument;
}

/** 保存冲突：别人在 base_version 之后先保存了新版本（HTTP 409 `version_conflict`）。 */
export interface VersionConflict {
	base_version: number;
	/** 当前最新版本；编排还没有版本时为 null。 */
	head: VersionSummary | null;
}

export const versionConflictOf = (error: unknown): VersionConflict | null =>
	error instanceof ApiError && error.status === 409 && error.code === "version_conflict"
		? (error.details as VersionConflict)
		: null;

/** 保存新版本；baseVersion 是编辑起点的版本号，不是最新版本时抛出 409 的 ApiError。 */
export const saveVersionFrom = (
	orchestrationId: string,
	baseVersion: number,
	document: OrchestrationDocument,
) =>
	apiPost<SavedVersion>(`/orchestrations/${orchestrationId}/versions`, {
		base_version: baseVersion,
		document,
	});

export const listVersions = (orchestrationId: string) =>
	apiGet<{ versions: VersionSummary[] }>(`/orchestrations/${orchestrationId}/versions`);

export const getVersion = (orchestrationId: string, number: number) =>
	apiGet<OrchestrationVersion>(`/orchestrations/${orchestrationId}/versions/${number}`);

/** 恢复历史版本：用它的内容生成一个新版本。 */
export const restoreVersion = (orchestrationId: string, number: number) =>
	apiPost<OrchestrationVersion & { warnings: OrchestrationWarning[] }>(
		`/orchestrations/${orchestrationId}/versions/${number}/restore`,
		{},
	);
