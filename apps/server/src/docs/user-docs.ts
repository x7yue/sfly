import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * 用户文档（ADR 0013）：仓库 docs/guide/ 下的一组 Markdown，打包时复制到 main.mjs 旁边的 docs/。
 *
 * - 页面登记在目录里的 `pages.json`（`{ pages: [{ slug, title, description }] }`，顺序即导航顺序），
 *   每页的源文件是 `<slug>.md`。
 * - 节点开发 skill（#59）：`skills/sfly-node-dev/SKILL.md`，同目录的 `reference.md` 就是 SDK 参考页
 *   `sdk-reference.md`（{@link SKILL}）。SDK wheel 里的 skill 是同一份源文件（sdk/python/src/sfly/cli/skills/
 *   下是指向这里的软链接），原样写进项目，所以这两个文件里不用占位符。
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

/** 节点开发 skill：名称、SKILL.md 的位置（相对文档目录）、作为 reference.md 的页面。 */
export const SKILL = {
	name: "sfly-node-dev",
	file: "skills/sfly-node-dev/SKILL.md",
	referencePage: "sdk-reference",
} as const;

export interface UserDocs {
	pages: UserDoc[];
	/** skill 的文件名 → 原文（SKILL.md、reference.md）；文档目录里没有 skill 时为空。 */
	skill: ReadonlyMap<string, string>;
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

function checkPlaceholders(file: string, source: string): void {
	for (const [, name] of source.matchAll(PLACEHOLDER)) {
		if (!(name && name in PLACEHOLDERS)) {
			throw new Error(
				`docs/guide/${file}: 未知的占位符 {{${name}}}（可用：${Object.keys(PLACEHOLDERS).join("、")}）`,
			);
		}
	}
}

const readIfExists = (path: string) =>
	readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});

/** 读取文档目录；不设置目录时没有文档。 */
export async function loadUserDocs(dir: string | undefined): Promise<UserDocs> {
	if (!dir) return { pages: [], skill: new Map() };
	const manifest = PagesFile.parse(JSON.parse(await readFile(join(dir, "pages.json"), "utf8")));
	const pages: UserDoc[] = [];
	for (const page of manifest.pages) {
		const source = await readFile(join(dir, `${page.slug}.md`), "utf8");
		checkPlaceholders(`${page.slug}.md`, source);
		pages.push({ ...page, source });
	}
	const skill = new Map<string, string>();
	const skillSource = await readIfExists(join(dir, SKILL.file));
	if (skillSource !== undefined) {
		checkPlaceholders(SKILL.file, skillSource);
		const reference = pages.find((p) => p.slug === SKILL.referencePage);
		if (!reference) {
			throw new Error(
				`docs/guide/${SKILL.file}: skill 的 reference.md 是 SDK 参考页 ${SKILL.referencePage}，但 pages.json 里没有登记它`,
			);
		}
		skill.set("SKILL.md", skillSource);
		skill.set("reference.md", reference.source);
	}
	return { pages, skill };
}

/** skill 文件的原文地址（对开发机可见）。 */
export const skillFileUrl = (publicHttpUrl: string, file: string) =>
	`${publicHttpUrl}/docs/skills/${SKILL.name}/${file}`;

/** 把原文里的占位符替换成取值。 */
export const renderDoc = (source: string, values: DocValues) =>
	source.replace(PLACEHOLDER, (_, name: keyof DocValues) => values[name]);

/** 原文地址（对开发机可见）。 */
export const docUrl = (publicHttpUrl: string, slug: string) =>
	`${publicHttpUrl}/docs/${encodeURIComponent(slug)}.md`;

/** llms.txt（https://llmstxt.org）：标题、简介和每页原文的完整地址。 */
export function llmsTxt({ pages, skill }: UserDocs, values: DocValues): string {
	const lines = [
		"# sfly 开发文档",
		"",
		`> sfly 测试编排平台的用户文档（控制面 ${values.SFLY_URL}，版本 ${values.SFLY_VERSION}）。每一页都是 Markdown 原文，可以直接用 curl 读取。`,
		"",
		"## 文档",
		"",
		...pages.map((d) => `- [${d.title}](${docUrl(values.SFLY_URL, d.slug)}): ${d.description}`),
	];
	if (skill.size > 0) {
		lines.push(
			"",
			"## 节点开发 skill",
			"",
			`给 AI 编程助手的 ${SKILL.name} skill（sfly init 已写进项目的 .agents/skills/${SKILL.name}/，两个文件放在同一目录下使用）：`,
			"",
			`- [SKILL.md](${skillFileUrl(values.SFLY_URL, "SKILL.md")}): 开发流程与节点代码规范`,
			`- [reference.md](${skillFileUrl(values.SFLY_URL, "reference.md")}): SDK 参考（与「${pages.find((p) => p.slug === SKILL.referencePage)?.title}」页相同）`,
		);
	}
	return `${lines.join("\n")}\n`;
}
