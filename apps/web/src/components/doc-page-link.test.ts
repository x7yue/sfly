import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOC_PAGE } from "#/lib/copy";

const pagesJson = join(import.meta.dirname, "../../../../docs/guide/pages.json");

describe("界面引用的开发文档页", () => {
	it("每一页都在文档里，页名与目录里的标题一致", () => {
		const { pages } = JSON.parse(readFileSync(pagesJson, "utf8")) as {
			pages: { slug: string; title: string }[];
		};
		for (const [slug, title] of Object.entries(DOC_PAGE)) {
			expect(pages.find((p) => p.slug === slug)?.title, slug).toBe(title);
		}
	});
});
