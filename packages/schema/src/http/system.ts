import { z } from "zod";
import { download, endpoint, Timestamp } from "./contract.js";

/** 健康检查与 SDK 运行时下载的契约（约定见 ./contract.ts）。 */

const Health = z.enum(["ok", "unavailable"]);

/** 可下载的 SDK 运行时 wheel（Agent 装进共享 venv，docs/ARCHITECTURE.md §4.4）。 */
export const SdkWheelView = z.object({
	version: z.string(),
	filename: z.string(),
	sha256: z.string(),
	/** 对 Agent 可见的完整下载地址。 */
	url: z.string(),
});

export const systemApi = {
	/** 健康检查：数据库不可用时返回 503，响应体形状相同（status 与 database 为 unavailable）。 */
	health: endpoint({
		method: "GET",
		path: "/health",
		summary: "健康检查：控制面和数据库是否可用",
		effect: "read",
		resource: { kind: "system", target: "global" },
		client: true,
		key: ["system", "health"],
		response: z.object({
			/** 控制面整体：`ok` 或 `unavailable`（数据库不可用时返回 503，响应体形状相同）。 */
			status: Health,
			/** 数据库连得上吗。 */
			database: Health,
			/** 控制面的当前时间（控制面时间）。 */
			time: Timestamp,
		}),
	}),
};

export const sdkApi = {
	/** 控制面提供的 SDK 运行时 wheel。 */
	wheels: endpoint({
		method: "GET",
		path: "/sdk/python",
		summary: "列出控制面提供的 SDK 运行时 wheel",
		effect: "read",
		resource: { kind: "system", target: "global" },
		client: false,
		key: ["sdk", "wheels"],
		response: z.object({
			/** 控制面提供的 SDK 运行时 wheel，每个版本一个。 */
			wheels: z.array(SdkWheelView),
		}),
	}),
	/** 下载一个 wheel；版本或文件名不存在时 404。 */
	wheel: download({
		path: "/sdk/python/:version/:filename",
		summary: "下载一个 SDK 运行时 wheel",
		effect: "read",
		resource: { kind: "system", target: "global" },
		client: false,
		params: z.object({
			/** SDK 版本（`GET /sdk/python` 列出的）。 */
			version: z.string(),
			/** wheel 的文件名（`GET /sdk/python` 列出的）。 */
			filename: z.string(),
		}),
		contentType: "application/octet-stream",
	}),
	/**
	 * 控制面的包索引（PEP 503）的根页面：平台自己的两个包，`sfly`（SDK）和 `sfly-std`（标准节点包）。开发机从这里装 `sfly`
	 * （`install.sh --dev`、`sfly init` 写入的显式索引），Agent 装节点包的依赖时也用它（`sfly-std` 只从这里取），
	 * 都不会从 PyPI 镜像装到同名的其他包。不需要凭据（和 SDK wheel 的下载一样；ADR 0029 的「Python 索引」一行）。
	 */
	index: download({
		path: "/simple/",
		summary: "控制面的包索引（PEP 503）的根页面：sfly 和 sfly-std",
		effect: "read",
		resource: { kind: "system", target: "global" },
		raw: true,
		contentType: "text/html; charset=utf-8",
		client: false,
	}),
	/**
	 * `sfly init` 写进新项目 `pyproject.toml` 的配置：`sfly[cli]` 锁定的控制面版本、sfly 简单索引，
	 * 以及控制面统一配置的镜像（ADR 0012，未配置时为 null，项目用 uv 的默认来源）。
	 */
	projectSettings: endpoint({
		method: "GET",
		path: "/sdk/project-settings",
		summary: "sfly init 写进新项目的配置：控制面版本、sfly 索引和镜像",
		effect: "read",
		resource: { kind: "system", target: "global" },
		client: false,
		key: ["sdk", "project-settings"],
		response: z.object({
			version: z.string(),
			/** sfly 简单索引的完整地址（带末尾 `/`）。 */
			sfly_index_url: z.string(),
			/** PyPI 镜像（简单索引地址）。 */
			pypi_mirror: z.string().nullable(),
			/** uv 的 Python 下载镜像：GitHub Release 镜像上的 `astral-sh/python-build-standalone/`。 */
			python_install_mirror: z.string().nullable(),
		}),
	}),
	/**
	 * 索引的项目页（项目名按 PEP 503 规范化）：`sfly` 是与控制面同版本的 SDK wheel，`sfly-std` 是公共项目里已发布的标准节点包的
	 * wheel（还没有发布时是没有版本的页面，不是 404）；链接带 `#sha256=`。别的名字 404：索引只提供平台自己的这两个包。
	 */
	indexProject: download({
		path: "/simple/:package/",
		summary: "控制面的包索引的项目页：sfly 的 SDK wheel、sfly-std 的 wheel 的下载链接",
		effect: "read",
		resource: { kind: "system", target: "global" },
		client: false,
		raw: true,
		params: z.object({
			/** 索引里的包名（PEP 503 里叫项目）；只有 `sfly` 和 `sfly-std`。 */
			package: z.string(),
		}),
		contentType: "text/html; charset=utf-8",
	}),
	/** 下载索引里的一个 sfly-std wheel（项目页的链接指向这里）；文件名不在索引里时 404。 */
	stdWheel: download({
		path: "/simple/sfly-std/files/:filename",
		summary: "下载控制面的包索引里的一个 sfly-std wheel",
		effect: "read",
		resource: { kind: "system", target: "global" },
		client: false,
		params: z.object({
			/** wheel 的文件名（`/simple/sfly-std/` 列出的）。 */
			filename: z.string(),
		}),
		contentType: "application/octet-stream",
	}),
};

export type SdkWheelView = z.infer<typeof SdkWheelView>;
