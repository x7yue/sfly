import { editorDocument } from "./editor-support";
import { expect, test } from "./fixtures";
import { createScenario, publishPackage } from "./support";

// 版本对比的差异（#341）：节点写「显示名称（节点 ID）」，入口参数只写变了的字段。

const named = (id: string, name: string) => (n: { id: string }) =>
	n.id === id ? { ...n, display_name: name } : n;

const first = {
	...editorDocument,
	nodes: editorDocument.nodes.map(named("fetch", "拉取快照")).map(named("sub_ping", "子流程探测")),
};

const second = {
	...first,
	nodes: [
		...first.nodes
			.filter((n) => n.id !== "sub_ping")
			.map(named("fetch", "拉取快照 v2"))
			.map((n) =>
				n.id === "entry"
					? {
							...n,
							params: [
								{ name: "biz_date", type: "string", required: true, description: "业务日期" },
								{ name: "api_token", type: "string", secret: true },
							],
						}
					: n,
			),
		{
			id: "report",
			kind: "package",
			package: "demo-checks",
			node: "ping",
			display_name: "生成报告",
			position: { x: 1200, y: 0 },
			inputs: { host: "report.example.test" },
		},
	],
	edges: [
		...first.edges.filter((e) => e.to !== "sub_ping"),
		{ from: "ping", to: "report", kind: "chain" },
	],
};

test("版本对比：新增、删除、改动的节点写显示名称和节点 ID；入口参数只写变了的字段", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "日终数据处理", first);
	const res = await controlPlane.fetch(`/orchestrations/${id}/versions`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-sfly-nickname": "bob" },
		body: JSON.stringify({ base_version: 1, document: second }),
	});
	expect(res.status).toBe(201);

	await page.goto(`/orchestrations/${id}/versions`);
	const diff = page.getByRole("region", { name: "差异" });
	await expect(diff).toContainText("+ 生成报告（report）（包节点）");
	await expect(diff).toContainText("− 子流程探测（sub_ping）（包节点）");
	// 改动的节点取修改后的显示名称。
	await expect(diff).toContainText("拉取快照 v2（fetch）（包节点）");
	await expect(diff).toContainText("显示名称 拉取快照 → 拉取快照 v2");

	// 只去掉了 secret 参数的默认值、只给另一个参数加了说明：各写一个字段，不把整条声明划掉再写一遍。
	await expect(diff).toContainText("参数 api_token 的默认值 ******（删除）");
	await expect(diff).toContainText("参数 biz_date 的说明 业务日期（新增）");
	await expect(diff).not.toContainText("string · 必填");
	await expect(diff).not.toContainText("string · 可选");
});
