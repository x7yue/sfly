import { z } from "zod";
import {
	ChartView,
	NodeName,
	NodeTypeMetadata,
	PackageMetadata,
	PackageName,
} from "../package-metadata.js";
import { download, endpoint, Timestamp } from "./contract.js";

/** 节点包管理相关接口的契约（约定见 ./contract.ts）。 */

/** 查询 API 返回的节点类型：图表含控制面为没被引用的指标生成的默认图表（default=true）。 */
export const NodeTypeView = z.object({
	...NodeTypeMetadata.shape,
	charts: z.array(ChartView).optional(),
});

/** 一个已发布的版本（含完整元信息）。 */
export const PackageVersionView = z.object({
	name: z.string(),
	version: z.string(),
	sha256: z.string(),
	size: z.number().int(),
	published_at: Timestamp,
	metadata: z.object({ ...PackageMetadata.shape, nodes: z.array(NodeTypeView) }),
});

export const PackageVersionSummary = z.object({
	version: z.string(),
	sha256: z.string(),
	size: z.number().int(),
	published_at: Timestamp,
	nodes: z.array(z.object({ name: z.string(), title: z.string() })),
	/** 有多少个场景的最新版本锁定了这个版本。 */
	locked_orchestrations: z.number().int(),
});

export const PackageSummary = z.object({
	name: z.string(),
	/** 按发布时间从新到旧。 */
	versions: z.array(PackageVersionSummary),
});

const VersionParams = z.object({ name: PackageName, version: z.string().min(1) });

export const packagesApi = {
	/** 包列表（含各版本与节点类型摘要），按包名排序。 */
	list: endpoint({
		method: "GET",
		path: "/packages",
		client: true,
		key: ["packages", "list"],
		response: z.object({ packages: z.array(PackageSummary) }),
	}),
	/** 单个包的版本列表。 */
	get: endpoint({
		method: "GET",
		path: "/packages/:name",
		client: true,
		key: ["packages", "detail"],
		params: z.object({ name: PackageName }),
		response: PackageSummary,
	}),
	/** 版本详情（含完整元信息）。 */
	version: endpoint({
		method: "GET",
		path: "/packages/:name/versions/:version",
		client: true,
		key: ["packages", "version"],
		params: VersionParams,
		response: PackageVersionView,
	}),
	/** 某个版本里的一个节点类型。 */
	nodeType: endpoint({
		method: "GET",
		path: "/packages/:name/versions/:version/nodes/:node",
		client: true,
		key: ["packages", "node-type"],
		params: VersionParams.extend({ node: NodeName }),
		response: NodeTypeView,
	}),
	/**
	 * 发布：请求体是 .sflypkg 原始字节（application/octet-stream，不在契约里），返回 201；
	 * 其他 content-type 返回 415，元信息不合法 400 `invalid_package`，`包名@版本` 已存在 409 `conflict`。
	 */
	publish: endpoint({
		method: "POST",
		path: "/packages",
		client: false,
		key: ["packages", "publish"],
		upload: true,
		response: PackageVersionView,
	}),
	/** 下载归档（Agent 安装用；`x-sfly-sha256` 响应头是归档的 sha256）。 */
	archive: download({
		path: "/packages/:name/versions/:version/archive",
		client: false,
		params: z.object({ name: z.string(), version: z.string() }),
		contentType: "application/octet-stream",
	}),
};

export type NodeTypeView = z.infer<typeof NodeTypeView>;
export type PackageVersionView = z.infer<typeof PackageVersionView>;
export type PackageVersionSummary = z.infer<typeof PackageVersionSummary>;
export type PackageSummary = z.infer<typeof PackageSummary>;
