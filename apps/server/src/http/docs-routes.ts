import { docsApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import { type DocValues, llmsTxt, renderDoc, type UserDocs } from "../docs/user-docs.js";
import { contractDownload, contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";

/**
 * 用户文档（ADR 0013；契约见 @sfly/schema 的 docsApi）。根路径给 AI 编程助手用 curl 读取，
 * 浏览器经 /api 前缀读取同一份内容：
 *
 * | 方法 | 路径 | 说明 |
 * |---|---|---|
 * | GET | `/docs` | 文档目录 `{ pages: [{ slug, title, description }] }` |
 * | GET | `/docs/:page.md` | 一页的 Markdown 原文，占位符已替换 |
 * | GET | `/docs/skills/:skill/:file` | skill（`sfly-node-dev`、`sfly-platform`）的 `SKILL.md`、`reference.md`（对应的一页文档：SDK 参考、命令行页），占位符已替换 |
 * | GET | `/llms.txt` | 索引：每一页原文和 skill 文件的完整地址 |
 */
export function registerDocsRoutes(
	app: FastifyInstance,
	deps: { docs: UserDocs; values: () => DocValues },
): void {
	contractRoute(app, docsApi.list, async () => ({
		pages: deps.docs.pages.map(({ slug, title, description }) => ({ slug, title, description })),
	}));

	contractDownload(app, docsApi.page, async ({ params }, reply) => {
		const doc = deps.docs.pages.find((d) => d.slug === params.page);
		if (!doc) return sendError(reply, 404, "not_found", `文档页 ${params.page} 不存在`);
		return reply
			.header("content-type", docsApi.page.contentType)
			.header("cache-control", "no-cache")
			.send(renderDoc(doc.source, deps.values()));
	});

	contractDownload(app, docsApi.skill, async ({ params }, reply) => {
		const source = deps.docs.skills.get(params.skill)?.get(params.file);
		if (source === undefined) {
			return sendError(reply, 404, "not_found", `skill 文件 ${params.skill}/${params.file} 不存在`);
		}
		return reply
			.header("content-type", docsApi.skill.contentType)
			.header("cache-control", "no-cache")
			.send(renderDoc(source, deps.values()));
	});

	contractDownload(app, docsApi.llms, async (_request, reply) =>
		reply
			.header("content-type", docsApi.llms.contentType)
			.header("cache-control", "no-cache")
			.send(llmsTxt(deps.docs, deps.values())),
	);
}
