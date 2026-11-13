import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@sfly/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "./support/agent-binary.js";
import { shellBlocks } from "./support/doc-commands.js";
import {
	typecheckPageExamples,
	typeScriptBlocks,
	workspaceClientProject,
} from "./support/doc-examples.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const PAGE = "api-client.md";

describe("API 客户端的文档页", () => {
	let source: string;
	let project: Awaited<ReturnType<typeof workspaceClientProject>>;

	beforeAll(async () => {
		source = await readFile(join(repoRoot, "docs", "guide", PAGE), "utf8");
		project = await workspaceClientProject();
	});
	afterAll(async () => {
		await project?.close();
	});

	describe("安装命令", () => {
		const version = "1.2.3";
		const tarball = Buffer.from("sfly-client tarball");
		let dir: string;
		let cp: TestControlPlane;

		beforeAll(async () => {
			dir = await mkdtemp(join(tmpdir(), "sfly-client-doc-"));
			await writeFile(join(dir, `sfly-client-${version}.tgz`), tarball);
			cp = await startTestControlPlane({
				docsDir: join(repoRoot, "docs", "guide"),
				clientPackageDir: dir,
				version,
			});
		});
		afterAll(async () => {
			await cp?.close();
			await rm(dir, { recursive: true, force: true });
		});

		it("控制面返回的原文里填好了控制面的地址和版本，下载到的就是控制面提供的安装包", async () => {
			const text = await (await cp.fetch(`/docs/${PAGE}`)).text();
			const installs = shellBlocks(text)
				.flatMap((block) => block.split("\n"))
				.filter((line) => /^(npm install|pnpm add) /.test(line));
			expect(installs.map((line) => line.split(" ")[0])).toEqual(["npm", "pnpm"]);

			const { tarballs } = (await (await cp.fetch("/client")).json()) as {
				tarballs: Array<{ url: string }>;
			};
			for (const line of installs) {
				const url = line.split(" ").at(-1) ?? "";
				expect(url, line).toBe(tarballs[0]?.url);
				expect(url, line).toBe(`${cp.httpUrl}/client/${version}/sfly-client-${version}.tgz`);
				const res = await fetch(url);
				expect(res.status, line).toBe(200);
				expect(Buffer.from(await res.arrayBuffer()).equals(tarball), line).toBe(true);
			}
		});
	});

	it("方法表列出的就是 API 客户端的全部领域和方法", () => {
		const client = createClient({ baseUrl: "http://sfly.invalid" });
		const domains = Object.fromEntries(
			Object.entries(client)
				.filter(([, value]) => typeof value === "object")
				.map(([domain, methods]) => [domain, Object.keys(methods as object).sort()]),
		);
		const table = Object.fromEntries(
			[...source.matchAll(/^\| `(\w+)`[^|]* \| (`.+`) \|$/gm)].map(([, domain, cell]) => [
				domain,
				[...(cell ?? "").matchAll(/`(\w+)`/g)].map(([, name]) => name).sort(),
			]),
		);
		expect(table).toEqual(domains);
	});

	it("每段示例代码按页面顺序拼成一个模块，对着 API 客户端通过类型检查", () => {
		expect(typeScriptBlocks(source).length).toBeGreaterThanOrEqual(8);
		expect(typecheckPageExamples(source, PAGE, project.dir)).toEqual([]);
	}, 60_000);

	it("示例里的方法名和 API 客户端对不上时，类型检查报错并指出页面上的行", () => {
		const call = "client.runs.trigger(";
		const line = source.split("\n").findIndex((l) => l.includes(call)) + 1;
		expect(line).toBeGreaterThan(0);
		const wrong = source.replace(call, "client.runs.start(");
		expect(typecheckPageExamples(wrong, PAGE, project.dir)).toEqual([
			expect.stringMatching(new RegExp(`^${PAGE}:${line}: Property 'start' does not exist`)),
		]);
	}, 60_000);
});
