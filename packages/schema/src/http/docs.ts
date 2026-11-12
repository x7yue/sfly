import { z } from "zod";
import { download, endpoint } from "./contract.js";

/**
 * 用户文档（ADR 0013）的契约（约定见 ./contract.ts）。源文件在仓库的 docs/guide/，
 * 控制面返回原文时把占位符替换成控制面地址和版本号（apps/server/src/docs/user-docs.ts）。
 * 原文和 /llms.txt 供 AI 编程助手用 curl 读取；前端「开发文档」页经 /api 读取同一份内容。
 */

/** 文档目录中的一页（docs/guide/pages.json 里登记的顺序）。 */
export const DocPageView = z.object({
	/** 页面标识：原文地址是 `/docs/<slug>.md`。 */
	slug: z.string(),
	title: z.string(),
	/** 一句话说明（/llms.txt 里列在链接后面）。 */
	description: z.string(),
});

export const docsApi = {
	/** 文档目录。 */
	list: endpoint({
		method: "GET",
		path: "/docs",
		key: ["docs", "list"],
		response: z.object({ pages: z.array(DocPageView) }),
	}),
	/** 一页的 Markdown 原文（占位符已替换）；未知页 404。 */
	page: download({
		path: "/docs/:page.md",
		raw: true,
		params: z.object({ page: z.string() }),
		contentType: "text/markdown; charset=utf-8",
	}),
	/**
	 * 给 AI 编程助手的 skill（`sfly-node-dev`、`sfly-platform`）的一个文件（占位符已替换）：`SKILL.md`，
	 * 以及同目录的 `reference.md`（对应的一页文档：SDK 参考页、「用命令行操作平台」页）。
	 * 与 SDK wheel 里 `sfly init` 写进项目的内容出自同一份源文件；未知的 skill 或文件 404。
	 */
	skill: download({
		path: "/docs/skills/:skill/:file",
		raw: true,
		params: z.object({ skill: z.string(), file: z.string() }),
		contentType: "text/markdown; charset=utf-8",
	}),
	/** llms.txt 索引：列出每一页原文的完整地址。 */
	llms: download({ path: "/llms.txt", raw: true, contentType: "text/plain; charset=utf-8" }),
};

export type DocPageView = z.infer<typeof DocPageView>;
