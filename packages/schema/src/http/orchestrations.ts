import { z } from "zod";
import { OrchestrationDocument } from "../orchestration-document.js";
import { endpoint, Timestamp } from "./contract.js";

/**
 * 编排（场景）与编排版本相关接口的契约（约定见 ./contract.ts）。
 * 目前只有编排画布用到的接口（#35）；列表、新建、复制、版本历史等随各自页面迁入。
 *
 * 响应里的 `document` 用 OrchestrationDocument：控制面保存时已按它解析（默认值都已补齐），
 * 存储的文档再解析一次不会改变，满足「响应解析前后相同」的约定。
 */

const OrchestrationId = z.object({ id: z.string().min(1) });

export const OrchestrationView = z.object({
	id: z.string(),
	name: z.string(),
	/** 最新版本号；0 表示还没有保存过版本。 */
	head_version: z.number().int(),
	created_at: Timestamp,
});

/** 编辑起点：最新版本；还没有版本时是只含入口节点的初始文档（number 为 0，作者与时间为 null）。 */
export const OrchestrationHeadView = z.object({
	orchestration_id: z.string(),
	number: z.number().int(),
	author: z.string().nullable(),
	created_at: Timestamp.nullable(),
	document: OrchestrationDocument,
});

export const VersionSummaryView = z.object({
	number: z.number().int(),
	author: z.string(),
	created_at: Timestamp,
});

/** 保存时返回的静态检查警告（@sfly/orchestration 的 documentWarnings）；只提示，不阻止保存。 */
export const DocumentWarningView = z.object({
	code: z.string(),
	message: z.string(),
	node_id: z.string().optional(),
	input: z.string().optional(),
});

export const SavedVersionView = z.object({
	id: z.string(),
	orchestration_id: z.string(),
	number: z.number().int(),
	author: z.string(),
	created_at: Timestamp,
	document: OrchestrationDocument,
	warnings: z.array(DocumentWarningView),
});

/** 409 `version_conflict` 的 details：别人在 base_version 之后先保存了新版本（还没有版本时 head 为 null）。 */
export const VersionConflictDetails = z.object({
	base_version: z.number().int(),
	head: VersionSummaryView.nullable(),
});

export const orchestrationsApi = {
	/** 单个编排（名称、最新版本号）。 */
	get: endpoint({
		method: "GET",
		path: "/orchestrations/:id",
		key: ["orchestrations", "detail"],
		params: OrchestrationId,
		response: OrchestrationView,
	}),
	/** 编辑起点：最新版本的内容。 */
	head: endpoint({
		method: "GET",
		path: "/orchestrations/:id/head",
		key: ["orchestrations", "head"],
		params: OrchestrationId,
		response: OrchestrationHeadView,
	}),
	/**
	 * 保存（追加）一个版本，返回 201。需要昵称请求头。base_version 是编辑起点的版本号，
	 * 不是最新版本时返回 409 `version_conflict`（details 见 VersionConflictDetails）。
	 * 缺 base_version 返回 400 `base_version_required`、文档不合法返回 400 `invalid_document`
	 * （比通用的 `invalid_request` 更具体，测试与文档依赖），所以控制面没有用 contractRoute 注册这个接口，
	 * 而是用这里的 body schema 解析、响应在类型上受契约约束。
	 */
	saveVersion: endpoint({
		method: "POST",
		path: "/orchestrations/:id/versions",
		key: ["orchestrations", "save-version"],
		params: OrchestrationId,
		body: z.object({
			document: OrchestrationDocument,
			base_version: z.number().int().nonnegative(),
		}),
		response: SavedVersionView,
	}),
};

export type OrchestrationView = z.infer<typeof OrchestrationView>;
export type OrchestrationHeadView = z.infer<typeof OrchestrationHeadView>;
export type VersionSummaryView = z.infer<typeof VersionSummaryView>;
export type DocumentWarningView = z.infer<typeof DocumentWarningView>;
export type SavedVersionView = z.infer<typeof SavedVersionView>;
export type VersionConflictDetails = z.infer<typeof VersionConflictDetails>;
