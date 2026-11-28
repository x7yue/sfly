import { z } from "zod";
import {
	ChartView,
	NodeName,
	NodeTypeMetadata,
	PackageMetadata,
	PackageName,
} from "../package-metadata.js";
import { download, endpoint, ProjectParams, Timestamp } from "./contract.js";

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
	/** 节点类型摘要，「添加节点」菜单用；`description` 是节点类型的完整说明，没有文档字符串时没有这个字段。 */
	nodes: z.array(
		z.object({ name: z.string(), title: z.string(), description: z.string().optional() }),
	),
	/** 有多少个场景的最新版本锁定了这个版本。 */
	locked_orchestrations: z.number().int(),
});

export const PackageSummary = z.object({
	name: z.string(),
	/**
	 * 在公共项目里（平台维护的标准节点包，任何项目都能用，只有平台管理员能发布，#501）；false 是本项目发布的。
	 * 公共项目和别的项目之间不能同名，所以一个包的版本都在同一边。
	 */
	public: z.boolean(),
	/**
	 * 最新版本（#434）：按版本号比较，不是发布时间（先发 1.10.0 再发 1.9.1，最新的是 1.10.0）；预发布版本排在同号正式版之前，
	 * 版本号相等（`1.0` 和 `1.0.0`）时取字符串排在后面的。比较规则只在 `@sfly/orchestration` 的 `newestVersion`，画布和命令行读这个字段。
	 */
	latest_version: z.string(),
	/** 按发布时间从新到旧。 */
	versions: z.array(PackageVersionSummary),
});

const NameParams = ProjectParams.extend({ name: PackageName });

const VersionParams = ProjectParams.extend({
	/** 节点包名。 */
	name: PackageName,
	/** 版本号。 */
	version: z.string().min(1),
});

export const packagesApi = {
	/** 包列表（含各版本与节点类型摘要），按包名排序。 */
	list: endpoint({
		method: "GET",
		path: "/projects/:project/packages",
		summary: "列出节点包，含各版本与节点类型的摘要",
		effect: "read",
		resource: { kind: "package", target: "collection" },
		client: true,
		key: ["packages", "list"],
		params: ProjectParams,
		response: z.object({ packages: z.array(PackageSummary) }),
	}),
	/** 单个包的版本列表。 */
	get: endpoint({
		method: "GET",
		path: "/projects/:project/packages/:name",
		summary: "列出一个节点包的全部版本",
		effect: "read",
		resource: { kind: "package", target: { params: "name" } },
		client: true,
		key: ["packages", "detail"],
		params: NameParams,
		response: PackageSummary,
	}),
	/** 版本详情（含完整元信息）。 */
	version: endpoint({
		method: "GET",
		path: "/projects/:project/packages/:name/versions/:version",
		summary: "读节点包一个版本的完整元信息",
		effect: "read",
		resource: { kind: "package", target: { params: "name" } },
		client: true,
		key: ["packages", "version"],
		params: VersionParams,
		response: PackageVersionView,
	}),
	/** 某个版本里的一个节点类型。 */
	nodeType: endpoint({
		method: "GET",
		path: "/projects/:project/packages/:name/versions/:version/nodes/:node",
		summary: "读节点包一个版本里的一个节点类型",
		effect: "read",
		resource: { kind: "package", target: { params: "name" } },
		client: true,
		key: ["packages", "node-type"],
		params: VersionParams.extend({
			/** 节点类型名。 */
			node: NodeName,
		}),
		response: NodeTypeView,
	}),
	/**
	 * 发布：请求体是 .sflypkg 原始字节（application/octet-stream，不在契约里），返回 201；
	 * 其他 content-type 返回 415，元信息不合法 400 `invalid_package`，`包名@版本` 已存在 409 `conflict`。
	 * 发布到路径里的项目；发布到公共项目（`/projects/public/packages`）只有平台管理员能这样做，别的凭据 403、不带凭据 401。
	 */
	publish: endpoint({
		method: "POST",
		path: "/projects/:project/packages",
		summary: "发布节点包：请求体是 .sflypkg 归档的原始字节",
		effect: "write",
		resource: { kind: "package", target: "upload" },
		client: false,
		key: ["packages", "publish"],
		upload: true,
		params: ProjectParams,
		response: PackageVersionView,
	}),
	/** 下载归档（Agent 安装用；`x-sfly-sha256` 响应头是归档的 sha256）。 */
	archive: download({
		path: "/projects/:project/packages/:name/versions/:version/archive",
		summary: "下载节点包一个版本的归档（Agent 安装用）",
		effect: "read",
		resource: { kind: "package", target: { params: "name" } },
		client: false,
		params: ProjectParams.extend({
			/** 节点包名。 */
			name: z.string(),
			/** 版本号。 */
			version: z.string(),
		}),
		contentType: "application/octet-stream",
	}),
};

export type NodeTypeView = z.infer<typeof NodeTypeView>;
export type PackageVersionView = z.infer<typeof PackageVersionView>;
export type PackageVersionSummary = z.infer<typeof PackageVersionSummary>;
export type PackageSummary = z.infer<typeof PackageSummary>;
