import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import { repoRoot } from "./agent-binary.js";
import type { TestControlPlane } from "./test-control-plane.js";

/** 用真实的 sfly CLI 构建桩节点包（testdata/stub-package，sfly-stub@0.1.0），经 HTTP API 发布。 */
export async function publishStubPackage(cp: TestControlPlane): Promise<void> {
	const out = await mkdtemp(join(tmpdir(), "sfly-stub-pkg-"));
	try {
		await promisify(execFile)(
			"uv",
			["run", "--locked", "--quiet", "sfly", "build", "testdata/stub-package", "--out", out],
			{ cwd: repoRoot },
		);
		const archive = await readFile(join(out, "sfly-stub-0.1.0.sflypkg"));
		const res = await cp.fetch("/packages", {
			method: "POST",
			headers: { "content-type": "application/octet-stream" },
			body: archive,
		});
		expect(res.status).toBe(201);
	} finally {
		await rm(out, { recursive: true, force: true });
	}
}
