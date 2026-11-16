import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GUIDE } from "./InspectorActions";

const guide = join(import.meta.dirname, "../../../../docs/guide");

describe("上限说明指向的开发文档", () => {
	it("那一节在那一页的标题里", () => {
		const headings = readFileSync(join(guide, `${GUIDE.page}.md`), "utf8")
			.split("\n")
			.filter((line) => line.startsWith("#"));
		expect(headings).toContain(`### ${GUIDE.section}`);
	});
});
