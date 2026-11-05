import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import { type SdkWheel, sdkWheelUrl } from "../sdk/sdk-wheels.js";
import { attachment } from "./content-disposition.js";
import { sendError } from "./errors.js";

/**
 * SDK 运行时 wheel 的下载（Agent 安装进共享 venv，#1 评审）：
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
	app.get("/sdk/python", async () => ({
		wheels: deps.wheels.map((w) => ({
			version: w.version,
			filename: w.filename,
			sha256: w.sha256,
			url: sdkWheelUrl(deps.publicHttpUrl(), w),
		})),
	}));

	app.get<{ Params: { version: string; filename: string } }>(
		"/sdk/python/:version/:filename",
		async (request, reply) => {
			const { version, filename } = request.params;
			const wheel = deps.wheels.find((w) => w.version === version && w.filename === filename);
			if (!wheel) return sendError(reply, 404, "not_found", "SDK wheel not found");
			return reply
				.header("content-type", "application/octet-stream")
				.header("content-disposition", attachment(wheel.filename))
				.send(createReadStream(wheel.file));
		},
	);
}
