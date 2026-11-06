// 切入点 A：控制面提供 SDK 运行时 wheel（#1 评审：Agent 只依赖 uv，共享 venv 里的 SDK 由 Agent 从控制面下载安装）。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "./support/agent-binary.js";
import { FakeAgent } from "./support/fake-agent.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("SDK 运行时 wheel", () => {
	let cp: TestControlPlane;
	let dir: string;
	let wheel: { name: string; bytes: Buffer; sha256: string; version: string };
	const agents: FakeAgent[] = [];

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "sfly-sdk-"));
		execFileSync("uv", ["build", "--wheel", "--quiet", "--out-dir", dir, "sdk/python"], {
			cwd: repoRoot,
		});
		const [name] = (await readdir(dir)).filter((f) => f.endsWith(".whl"));
		if (!name) throw new Error("uv build produced no wheel");
		const bytes = await readFile(join(dir, name));
		wheel = {
			name,
			bytes,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			version: name.split("-")[1] as string,
		};
		cp = await startTestControlPlane({ sdkWheelDir: dir });
	});
	afterAll(async () => {
		await Promise.all(agents.map((a) => a.disconnect()));
		await cp.close();
		await rm(dir, { recursive: true, force: true });
	});

	it("列出可下载的 SDK 版本，可以按版本下载 wheel", async () => {
		const url = `${cp.httpUrl}/sdk/python/${wheel.version}/${wheel.name}`;
		expect(await (await cp.fetch("/sdk/python")).json()).toEqual({
			wheels: [{ version: wheel.version, filename: wheel.name, sha256: wheel.sha256, url }],
		});
		const res = await fetch(url);
		expect(res.status).toBe(200);
		expect(Buffer.from(await res.arrayBuffer()).equals(wheel.bytes)).toBe(true);
		expect((await cp.fetch(`/sdk/python/9.9.9/${wheel.name}`)).status).toBe(404);
		expect((await cp.fetch(`/sdk/python/${wheel.version}/other.whl`)).status).toBe(404);
	});

	it("Welcome 给出与 Agent 版本一致的 SDK wheel；没有这个版本时为空", async () => {
		const matching = await FakeAgent.connect(cp.grpcUrl, {
			name: "agent-sdk",
			agentVersion: wheel.version,
		});
		agents.push(matching);
		expect(matching.welcome).toMatchObject({
			sdkWheelUrl: `${cp.httpUrl}/sdk/python/${wheel.version}/${wheel.name}`,
			sdkWheelSha256: wheel.sha256,
		});

		// 0.0.0 不会是发布版本（首个发布版本是 0.0.1），控制面里不会有这个版本的 wheel。
		const other = await FakeAgent.connect(cp.grpcUrl, { name: "agent-old", agentVersion: "0.0.0" });
		agents.push(other);
		expect(other.welcome).toMatchObject({ sdkWheelUrl: "", sdkWheelSha256: "" });
	});
});
