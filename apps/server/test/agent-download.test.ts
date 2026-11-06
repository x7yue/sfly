// 切入点 A：控制面提供 Agent 二进制下载与一键安装脚本 install.sh（ADR 0011）。
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const sha256 = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

describe("Agent 下载与 install.sh", () => {
	let cp: TestControlPlane;
	let dir: string;
	const x86 = "x86_64 的 Agent 二进制";
	const arm = "aarch64 的 Agent 二进制";

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "sfly-agent-bin-"));
		await writeFile(join(dir, "x86"), x86);
		await writeFile(join(dir, "arm"), arm);
		cp = await startTestControlPlane({
			version: "1.2.3",
			agentBinaries: { x86_64: join(dir, "x86"), aarch64: join(dir, "arm") },
		});
	});
	afterAll(async () => {
		await cp?.close();
		await rm(dir, { recursive: true, force: true });
	});

	it("列出两个架构的 Agent，按版本和架构下载对应的二进制，sha256 正确", async () => {
		const base = `${cp.httpUrl}/agent/binaries/1.2.3`;
		expect(await (await cp.fetch("/agent/binaries")).json()).toEqual({
			version: "1.2.3",
			install_script_url: `${cp.httpUrl}/install.sh`,
			binaries: [
				{ arch: "x86_64", version: "1.2.3", sha256: sha256(x86), url: `${base}/x86_64` },
				{ arch: "aarch64", version: "1.2.3", sha256: sha256(arm), url: `${base}/aarch64` },
			],
		});
		for (const [arch, body] of [
			["x86_64", x86],
			["aarch64", arm],
		] as const) {
			const res = await fetch(`${base}/${arch}`);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("application/octet-stream");
			expect(Buffer.from(await res.arrayBuffer()).toString()).toBe(body);
		}
		expect((await cp.fetch("/agent/binaries/9.9.9/x86_64")).status).toBe(404);
		expect((await cp.fetch("/agent/binaries/1.2.3/riscv64")).status).toBe(404);
	});

	it("install.sh 填好了控制面的 HTTP 地址、gRPC 地址、版本号和两个架构的 sha256", async () => {
		const res = await cp.fetch("/install.sh");
		expect(res.status).toBe(200);
		const script = await res.text();
		expect(script.startsWith("#!/bin/sh\n")).toBe(true);
		expect(script).toContain(`SFLY_URL='${cp.httpUrl}'`);
		expect(script).toContain(`SFLY_GRPC_URL='${cp.grpcUrl}'`);
		expect(script).toContain("SFLY_VERSION='1.2.3'");
		expect(script).toContain(`SHA256_X86_64='${sha256(x86)}'`);
		expect(script).toContain(`SHA256_AARCH64='${sha256(arm)}'`);
		expect(script).not.toMatch(/\{\{/);
		// 语法正确。
		const file = join(dir, "install.sh");
		await writeFile(file, script);
		await promisify(execFile)("sh", ["-n", file]);
	});
});

describe("install.sh 的地址", () => {
	it("配置了对外地址时，HTTP 地址用它，gRPC 地址用同一主机加 Agent 网关的端口", async () => {
		const cp = await startTestControlPlane({ publicHttpUrl: "http://sfly.internal:8080/" });
		try {
			const script = await (await cp.fetch("/install.sh")).text();
			const grpcPort = new URL(cp.grpcUrl).port;
			expect(script).toContain("SFLY_URL='http://sfly.internal:8080'");
			expect(script).toContain(`SFLY_GRPC_URL='http://sfly.internal:${grpcPort}'`);
		} finally {
			await cp.close();
		}
	});

	it("显式配置的 gRPC 对外地址优先", async () => {
		const cp = await startTestControlPlane({
			publicHttpUrl: "https://sfly.example.com",
			publicGrpcUrl: "http://grpc.example.com:50051",
		});
		try {
			const script = await (await cp.fetch("/install.sh")).text();
			expect(script).toContain("SFLY_GRPC_URL='http://grpc.example.com:50051'");
		} finally {
			await cp.close();
		}
	});
});
