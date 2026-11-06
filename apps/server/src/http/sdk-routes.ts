import { createReadStream } from "node:fs";
import { sdkApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import { type SdkWheel, sdkWheelUrl } from "../sdk/sdk-wheels.js";
import { attachment } from "./content-disposition.js";
import { contractDownload, contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";

/**
 * SDK 运行时 wheel 的下载（Agent 安装进共享 venv，#1 评审；契约见 @sfly/schema 的 sdkApi）：
 *
 * | 方法 | 路径 | 说明 |
 * |---|---|---|
 * | GET | `/sdk/python` | `{ wheels: [{ version, filename, sha256, url }] }` |
 * | GET | `/sdk/python/:version/:filename` | 下载 wheel |
 */
export function registerSdkRoutes(
	app: FastifyInstance,
	deps: { wheels: readonly SdkWheel[]; publicHttpUrl: () => string },
): void {
	contractRoute(app, sdkApi.wheels, async () => ({
		wheels: deps.wheels.map((w) => ({
			version: w.version,
			filename: w.filename,
			sha256: w.sha256,
			url: sdkWheelUrl(deps.publicHttpUrl(), w),
		})),
	}));

	contractDownload(app, sdkApi.wheel, async ({ params: { version, filename } }, reply) => {
		const wheel = deps.wheels.find((w) => w.version === version && w.filename === filename);
		if (!wheel) return sendError(reply, 404, "not_found", "SDK wheel not found");
		return reply
			.header("content-type", sdkApi.wheel.contentType)
			.header("content-disposition", attachment(wheel.filename))
			.send(createReadStream(wheel.file));
	});
}
