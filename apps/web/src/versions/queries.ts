import { orchestrationsApi, type VersionConflictDetails } from "@sfly/schema";
import { ApiError, apiQuery } from "#/lib/api";

/** 场景版本的查询与保存冲突（契约见 @sfly/schema 的 orchestrationsApi）。 */

/** 一个场景版本的内容；版本不可变，取到后不再重新获取。监控页、运行抽屉、画布运行状态共用同一份缓存。 */
export const versionQuery = (orchestrationId: string, number: number) => ({
	...apiQuery(orchestrationsApi.version, {
		params: { id: orchestrationId, number: String(number) },
	}),
	staleTime: Number.POSITIVE_INFINITY,
});

/** 保存冲突：别人在 base_version 之后先保存了新版本（HTTP 409 `version_conflict`）。 */
export const versionConflictOf = (error: unknown): VersionConflictDetails | null =>
	error instanceof ApiError && error.status === 409 && error.code === "version_conflict"
		? (error.details as VersionConflictDetails)
		: null;
