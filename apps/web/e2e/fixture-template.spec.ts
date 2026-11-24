import { createdFromTemplate } from "../../server/test/support/test-database.js";
import { expect, test } from "./fixtures";

// 每个用例的测试库从 global-setup.ts 建好的已迁移模板库复制（#613）。没有这一条，模板没有传到 worker、或者夹具不再用它，
// 每个用例都会悄悄退回到自己跑一遍迁移：用例照样通过，只是慢回去、机器忙的时候又会超过 30 秒。
test("测试库是从整个运行开始前建好的模板库复制来的，不是用例自己迁移出来的", async ({
	controlPlane,
}) => {
	expect(await createdFromTemplate(controlPlane.database)).toBe(true);
});
