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
};

export type SdkWheelView = z.infer<typeof SdkWheelView>;
