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
		key: ["system", "health"],
		response: z.object({ status: Health, database: Health, time: Timestamp }),
	}),
};

export const sdkApi = {
	/** 控制面提供的 SDK 运行时 wheel。 */
	wheels: endpoint({
		method: "GET",
		path: "/sdk/python",
		key: ["sdk", "wheels"],
		response: z.object({ wheels: z.array(SdkWheelView) }),
	}),
	/** 下载一个 wheel；版本或文件名不存在时 404。 */
	wheel: download({
		path: "/sdk/python/:version/:filename",
		params: z.object({ version: z.string(), filename: z.string() }),
		contentType: "application/octet-stream",
	}),
	/**
	 * sfly 简单索引（PEP 503）的根页面：只有 `sfly` 一个项目。开发机从这里装 `sfly`
	 * （`install.sh --dev`、`sfly init` 写入的显式索引），不会从 PyPI 镜像装到同名的其他包。
	 */
	index: download({ path: "/simple/", raw: true, contentType: "text/html; charset=utf-8" }),
	/**
	 * `sfly init` 写进新项目 `pyproject.toml` 的配置：`sfly[cli]` 锁定的控制面版本、sfly 简单索引，
	 * 以及控制面统一配置的镜像（ADR 0012，未配置时为 null，项目用 uv 的默认来源）。
	 */
	projectSettings: endpoint({
		method: "GET",
		path: "/sdk/project-settings",
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
	/** 索引的项目页：与控制面同版本的 SDK wheel（链接带 `#sha256=`）；`sfly` 以外的项目 404。 */
	indexProject: download({
		path: "/simple/:project/",
		raw: true,
		params: z.object({ project: z.string() }),
		contentType: "text/html; charset=utf-8",
	}),
};

export type SdkWheelView = z.infer<typeof SdkWheelView>;
