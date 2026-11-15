import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GUIDE } from "./InspectorActions";

const guide = join(import.meta.dirname, "../../../../docs/guide");

describe("上限说明指向的开发文档", () => {
	it("那一页和那一节都在文档里，页名与目录里的标题一致", () => {
		const { pages } = JSON.parse(readFileSync(join(guide, "pages.json"), "utf8")) as {
			pages: { slug: string; title: string }[];
		};
		expect(pages.find((p) => p.slug === GUIDE.page)?.title).toBe(GUIDE.title);
		const headings = readFileSync(join(guide, `${GUIDE.page}.md`), "utf8")
			.split("\n")
			.filter((line) => line.startsWith("#"));
		expect(headings).toContain(`### ${GUIDE.section}`);
	});
});
