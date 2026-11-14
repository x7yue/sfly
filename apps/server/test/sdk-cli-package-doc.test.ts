// sfly package show 的「说明」列显示输入的说明（#303）：真实的 sfly 进程查询测试控制面，
// 节点包的元信息和 `sfly build` 写出的一样，输入 schema 的 description 就是 `Doc` 写的说明。
import { strToU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packageArchive, packageMetadata, publishInit } from "./support/package-archive.js";
import { sfly } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const cells = (line: string) => line.trim().split(/ {2,}/);
const lines = (stdout: string) => stdout.trimEnd().split("\n");

describe("sfly package show：输入的说明", () => {
	let cp: TestControlPlane;
	const cli = (...args: string[]) => sfly([...args, "--server", cp.httpUrl]);

	beforeAll(async () => {
		cp = await startTestControlPlane();
		const metadata = packageMetadata({
			name: "documented",
			version: "1.0.0",
			nodes: [
				{
					name: "fetch",
					title: "抓取",
					entry: "documented.fetch:fetch",
					inputs: {
						type: "object",
						properties: {
							url: { type: "string", description: "请求地址，带协议" },
							retries: { type: "integer", description: "失败后重试几次", default: 3 },
							note: { type: "string", description: "第一行\n第二行" },
							plain: { type: "string" },
						},
						required: ["url"],
						order: ["url", "retries", "note", "plain"],
					},
					outputs: { type: "object", properties: { status: { type: "integer" } } },
				},
			],
		});
		const res = await cp.fetch(
			"/packages",
			publishInit(
				packageArchive(metadata, { "documented-1.0.0-py3-none-any.whl": strToU8("wheel") }),
			),
		);
		expect(res.status, await res.clone().text()).toBe(201);
	});

	afterAll(async () => {
		await cp?.close();
	});

	it("「说明」列写输入的说明，排在必填和默认值后面；多行说明合成一行；没有说明的输入只有必填或默认值", async () => {
		const result = await cli("package", "show", "documented");
		expect(result.code, result.stderr).toBe(0);
		const rows = lines(result.stdout)
			.filter((line) => line.startsWith("    ") && !line.startsWith("    输出"))
			.map(cells);
		expect(rows).toEqual([
			["参数", "类型", "说明"],
			["url", "string", "必填，请求地址，带协议"],
			["retries", "integer", "默认 3，失败后重试几次"],
			["note", "string", "第一行 第二行"],
			["plain", "string"],
			["status", "integer"],
		]);
	});

	it("--json 里输入带 description 字段，没有说明的输入没有这个字段", async () => {
		const result = await cli("package", "show", "documented", "--json");
		expect(result.code, result.stderr).toBe(0);
		const { nodes } = JSON.parse(result.stdout);
		expect(nodes[0].inputs).toEqual([
			{ name: "url", type: "string", required: true, description: "请求地址，带协议" },
			{
				name: "retries",
				type: "integer",
				required: false,
				default: 3,
				description: "失败后重试几次",
			},
			{ name: "note", type: "string", required: false, description: "第一行\n第二行" },
			{ name: "plain", type: "string", required: false },
		]);
	});
});
