import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * 用户文档（ADR 0013）：仓库 docs/guide/ 下的一组 Markdown，打包时复制到 main.mjs 旁边的 docs/。
 *
 * - 页面登记在目录里的 `pages.json`（`{ pages: [{ slug, title, description }] }`，顺序即导航顺序），
 *   每页的源文件是 `<slug>.md`。
 * - 文档里用 `{{名称}}` 表示控制面返回时才知道的值，可用的名称见 {@link PLACEHOLDERS}。
 *   出现未登记的名称时启动失败，拼错的占位符不会原样漏给用户。
 *
 * 启动时读取一次，返回时替换占位符（{@link renderDoc}）。
 */

/** 占位符 → 说明。新增占位符时在这里登记，并在 {@link DocValues} 里给出取值。 */
export const PLACEHOLDERS = {
	SFLY_URL: "控制面的 HTTP 地址（对 Agent 和开发机可见，即 SFLY_PUBLIC_URL），不带末尾的 /",
	SFLY_VERSION: "控制面版本号（Agent、SDK 与控制面同版本，ADR 0010）",
} as const;

export type DocValues = Record<keyof typeof PLACEHOLDERS, string>;

export interface UserDoc {
	slug: string;
	title: string;
	description: string;
	/** 未替换占位符的原文。 */
	source: string;
}

const PagesFile = z.object({
	pages: z.array(
		z.object({
			slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
			title: z.string().min(1),
			description: z.string().min(1),
		}),
	),
});

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** 读取文档目录；不设置目录时没有文档。 */
export async function loadUserDocs(dir: string | undefined): Promise<UserDoc[]> {
	if (!dir) return [];
	const manifest = PagesFile.parse(JSON.parse(await readFile(join(dir, "pages.json"), "utf8")));
	const docs: UserDoc[] = [];
	for (const page of manifest.pages) {
		const source = await readFile(join(dir, `${page.slug}.md`), "utf8");
		for (const [, name] of source.matchAll(PLACEHOLDER)) {
			if (!(name && name in PLACEHOLDERS)) {
				throw new Error(
					`docs/guide/${page.slug}.md: 未知的占位符 {{${name}}}（可用：${Object.keys(PLACEHOLDERS).join("、")}）`,
				);
			}
		}
		docs.push({ ...page, source });
	}
	return docs;
}

/** 把原文里的占位符替换成取值。 */
export const renderDoc = (source: string, values: DocValues) =>
	source.replace(PLACEHOLDER, (_, name: keyof DocValues) => values[name]);

/** 原文地址（对开发机可见）。 */
export const docUrl = (publicHttpUrl: string, slug: string) =>
	`${publicHttpUrl}/docs/${encodeURIComponent(slug)}.md`;

/** llms.txt（https://llmstxt.org）：标题、简介和每页原文的完整地址。 */
export function llmsTxt(docs: readonly UserDoc[], values: DocValues): string {
	const lines = [
		"# sfly 开发文档",
		"",
		`> sfly 测试编排平台的用户文档（控制面 ${values.SFLY_URL}，版本 ${values.SFLY_VERSION}）。每一页都是 Markdown 原文，可以直接用 curl 读取。`,
		"",
		"## 文档",
		"",
		...docs.map((d) => `- [${d.title}](${docUrl(values.SFLY_URL, d.slug)}): ${d.description}`),
	];
	return `${lines.join("\n")}\n`;
}
