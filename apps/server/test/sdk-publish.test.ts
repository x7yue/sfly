// 真实的 sfly CLI（Python，uv 运行）构建并发布节点包到测试控制面。
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const run = promisify(execFile);

async function sfly(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await run("uv", ["run", "--locked", "sfly", ...args], {
			cwd: repoRoot,
		});
		return { code: 0, stdout, stderr };
	} catch (error) {
		const e = error as { code?: number; stdout?: string; stderr?: string };
		return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
	}
}

describe("sfly publish → 控制面", () => {
	let cp: TestControlPlane;
	let project: string;

	beforeAll(async () => {
		cp = await startTestControlPlane();
		project = await mkdtemp(join(tmpdir(), "sfly-project-"));
		await mkdir(join(project, "src", "demo_e2e"), { recursive: true });
		await writeFile(
			join(project, "pyproject.toml"),
			'[project]\nname = "demo-e2e"\nversion = "0.1.0"\ndependencies = ["requests>=2"]\n',
		);
		await writeFile(join(project, "src", "demo_e2e", "__init__.py"), "");
		await writeFile(
			join(project, "src", "demo_e2e", "echo.py"),
			[
				"from sfly import Context, node",
				"",
				'@node(title="回显", outputs=["text"])',
				"def echo(ctx: Context, text: str, times: int = 1) -> dict:",
				'    return {"text": text * times}',
				"",
			].join("\n"),
		);
	}, 120_000);

	afterAll(async () => {
		await cp?.close();
		if (project) await rm(project, { recursive: true, force: true });
	});

	it("构建并发布后，控制面能查到节点类型元信息，sha256 与归档一致；重复发布被拒绝", async () => {
		const first = await sfly(["publish", project, "--server", cp.httpUrl]);
		expect(first.stderr).toBe("");
		expect(first.code).toBe(0);

		const version = (await (await cp.fetch("/packages/demo-e2e/versions/0.1.0")).json()) as {
			sha256: string;
			metadata: unknown;
		};
		expect(version.metadata).toEqual({
			name: "demo-e2e",
			version: "0.1.0",
			requires_python: ">=3.10",
			nodes: [
				{
					name: "echo",
					title: "回显",
					entry: "demo_e2e.echo:echo",
					inputs: {
						type: "object",
						properties: { text: { type: "string" }, times: { type: "integer", default: 1 } },
						required: ["text"],
						order: ["text", "times"],
					},
					outputs: { type: "object", properties: { text: {} } },
				},
			],
		});
		expect(first.stdout).toContain(`demo-e2e@0.1.0（sha256 ${version.sha256}）`);

		const archive = new Uint8Array(
			await (await cp.fetch("/packages/demo-e2e/versions/0.1.0/archive")).arrayBuffer(),
		);
		expect(createHash("sha256").update(archive).digest("hex")).toBe(version.sha256);

		const conflict = await sfly([
			"publish",
			join(project, "dist", "demo-e2e-0.1.0.sflypkg"),
			"--server",
			cp.httpUrl,
		]);
		expect(conflict.code).toBe(1);
		// 控制面的错误体 { error: { code, message } } 被解析成一行可读的错误。
		expect(conflict.stderr.trim()).toBe(
			"发布失败：控制面拒绝发布（HTTP 409 conflict）：" +
				"节点包 demo-e2e@0.1.0 已存在，不能覆盖已发布的版本",
		);
	}, 120_000);
});
