import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import { createEditorScenario, editorDocument } from "./editor-support";

// 版本历史与保存冲突测试用的数据（versions.spec.ts 与视觉回归共用）。

/**
 * bob 在第 1 版之后保存的第 2 版：改了 fetch 的 url，删掉子流程里的 sub_ping，主链末尾加上 report。
 */
export const secondVersion = {
	...editorDocument,
	nodes: [
		...editorDocument.nodes
			.filter((n) => n.id !== "sub_ping")
			.map((n) => (n.id === "fetch" ? { ...n, inputs: { url: "https://example.test/v2" } } : n)),
		{
			id: "report",
			kind: "package",
			package: "demo-checks",
			node: "ping",
			position: { x: 1008, y: 0 },
			inputs: { host: "report.example.test" },
		},
	],
	edges: [
		...editorDocument.edges.filter((e) => e.to !== "sub_ping"),
		{ from: "ping", to: "report", kind: "chain" },
	],
};

/** 以第 1 版为编辑起点保存 secondVersion。 */
export async function saveSecondVersion(cp: TestControlPlane, id: string, author: string) {
	const res = await cp.fetch(`/orchestrations/${id}/versions`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-sfly-nickname": author },
		body: JSON.stringify({ base_version: 1, document: secondVersion }),
	});
	if (res.status !== 201) throw new Error(`保存失败：${res.status} ${await res.text()}`);
}

/** 第 1 版（tester，08:00）与第 2 版（bob，08:05）。 */
export async function twoVersions(cp: TestControlPlane, clock: { advance(ms: number): void }) {
	const id = await createEditorScenario(cp);
	clock.advance(5 * 60_000);
	await saveSecondVersion(cp, id, "bob");
	return id;
}
