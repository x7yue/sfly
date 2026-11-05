import {
	type OrchestrationDocument,
	orchestrationsApi,
	type VersionConflictDetails,
	type VersionSummaryView,
} from "@sfly/schema";
import { ApiError, callApi } from "#/lib/api";

/** 场景版本相关的接口调用（契约见 @sfly/schema 的 orchestrationsApi）。 */

export type VersionSummary = VersionSummaryView;

/** 保存冲突：别人在 base_version 之后先保存了新版本（HTTP 409 `version_conflict`）。 */
export type VersionConflict = VersionConflictDetails;

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
	callApi(orchestrationsApi.saveVersion, {
		params: { id: orchestrationId },
		body: { base_version: baseVersion, document },
	});

export const getVersion = (orchestrationId: string, number: number) =>
	callApi(orchestrationsApi.version, {
		params: { id: orchestrationId, number: String(number) },
	});

/** 恢复历史版本：用它的内容生成一个新版本。 */
export const restoreVersion = (orchestrationId: string, number: number) =>
	callApi(orchestrationsApi.restoreVersion, {
		params: { id: orchestrationId, number: String(number) },
	});

export const listVersions = (orchestrationId: string) =>
	callApi(orchestrationsApi.versions, { params: { id: orchestrationId } });
