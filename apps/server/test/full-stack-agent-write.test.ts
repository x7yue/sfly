// 全栈（#200，ADR 0019）：真实的控制面、两台真实 Rust Agent（同一台机器、不同的主目录和端口）和 SDK 执行器。
// fw-runner 上的节点用 ctx.agent(source) 往 fw-source 上写入（流式）、上传（fw-runner 本地的文件，由 fw-runner 直接传给
// fw-source，不经过节点进程）、删除文件；ctx.agent() 对 fw-runner 自己同样可用。另外覆盖：写到一半出错或运行被取消时
// 目标路径上不留下半截文件，文件不存在、没有权限时的错误。节点包是 testdata/agent-files-package（write.py）。
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logsApi } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentPair, startAgentPair } from "./support/agent-pair.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { publishTestPackage } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const PACKAGE = "sfly-agent-files";

/** 节点看到的文件属性（testdata/agent-files-package 的 _info）。 */
async function expected(path: string) {
	const s = await stat(path, { bigint: true });
	return {
		path,
		size: Number(s.size),
		mtime_ns: Number(s.mtimeNs),
		device: Number(s.dev),
		inode: Number(s.ino),
	};
}

describe("全栈：Agent 能力 files.write", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let pair: AgentPair;
	let dir: string;

	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishTestPackage(cp, "testdata/agent-files-package", `${PACKAGE}-0.1.0.sflypkg`);
		pair = await startAgentPair({ grpcUrl: cp.grpcUrl, runner: "fw-runner", source: "fw-source" });
		// fw-source 上的目录（两台 Agent 在同一台机器上，绝对路径相同）。
		dir = await mkdtemp(join(tmpdir(), "sfly-agent-write-"));
	}, 600_000);

	afterAll(async () => {
		await pair?.close();
		await cp?.close();
		if (dir) {
			await chmod(dir, 0o755).catch(() => {});
			await rm(dir, { recursive: true, force: true });
		}
	});

	/** 在 fw-runner 上触发一个只有这个节点的运行，返回运行 ID。 */
	const trigger = async (node: string, inputs: Record<string, unknown>) => {
		const id = await api.orchestrationWith({
			default_agent: "fw-runner",
			nodes: [
				{ id: "entry", kind: "entry", params: [] },
				{ id: "n", kind: "package", package: PACKAGE, node, inputs },
			],
			edges: [{ from: "entry", to: "n", kind: "chain" }],
			packages: { [PACKAGE]: "0.1.0" },
		});
		return api.triggerOk(id);
	};

	/** 运行一个节点，等运行结束，返回这个节点。 */
	const runNode = async (node: string, inputs: Record<string, unknown>) => {
		const runId = await trigger(node, inputs);
		await eventually(
			async () => expect(["success", "failed"]).toContain((await api.run(runId)).status),
			60_000,
		);
		return api.node(runId, "n");
	};

	/** 节点成功结束时的输出。 */
	const outputs = async (node: string, inputs: Record<string, unknown>) => {
		const n = await runNode(node, inputs);
		expect(n.status, JSON.stringify(n.error)).toBe("success");
		return n.outputs as Record<string, unknown>;
	};

	const sub = async (name: string) => {
		const path = join(dir, name);
		await mkdir(path);
		return path;
	};

	it("fw-runner 上的节点往 fw-source 上流式写入、上传、删除文件，ctx.agent() 对自己同样可用", async () => {
		const out = await sub("out");
		const text = "第一行\nsecond line\n".repeat(1000);

		const written = await outputs("write_file", {
			source: "fw-source",
			path: join(out, "result.txt"),
			text,
			pieces: 5,
		});
		expect(await readFile(join(out, "result.txt"), "utf8")).toBe(text);
		expect(written).toEqual({ file: await expected(join(out, "result.txt")), error: null });

		// 上传 fw-runner 任务目录里的 upload.txt（节点用相对路径）。
		const uploaded = await outputs("upload_file", {
			source: "fw-source",
			path: join(out, "uploaded.txt"),
			text: "uploaded from fw-runner\n",
		});
		expect(await readFile(join(out, "uploaded.txt"), "utf8")).toBe("uploaded from fw-runner\n");
		expect(uploaded).toEqual({ file: await expected(join(out, "uploaded.txt")), error: null });

		expect(
			await outputs("delete_file", { source: "fw-source", path: join(out, "result.txt") }),
		).toEqual({ error: null });
		expect(await readdir(out)).toEqual(["uploaded.txt"]);

		// 自己所在的 Agent：写入、上传、删除。
		const own = await outputs("write_file", { path: join(out, "own.txt"), text: "own\n" });
		expect(own).toEqual({ file: await expected(join(out, "own.txt")), error: null });
		await outputs("upload_file", { path: join(out, "own-copy.txt"), text: "own copy\n" });
		expect(await readFile(join(out, "own-copy.txt"), "utf8")).toBe("own copy\n");
		expect(await outputs("delete_file", { path: join(out, "own.txt") })).toEqual({ error: null });
		expect((await readdir(out)).sort()).toEqual(["own-copy.txt", "uploaded.txt"]);
	}, 240_000);

	it("删除不存在的文件是「文件不存在」，没有权限时是「没有权限」", async () => {
		const out = await sub("errors");
		const missing = join(out, "gone.log");
		expect(await outputs("delete_file", { source: "fw-source", path: missing })).toEqual({
			error: {
				type: "AgentFileNotFound",
				kind: "not_found",
				agent: "fw-source",
				message: `Agent fw-source：${missing} 不存在`,
			},
		});

		// root 不受文件权限限制。
		if (process.getuid?.() === 0) return;
		const locked = await sub("locked");
		await writeFile(join(locked, "app.log"), "keep\n");
		await chmod(locked, 0o555);
		try {
			const write = await outputs("write_file", {
				source: "fw-source",
				path: join(locked, "new.txt"),
				text: "x",
			});
			const del = await outputs("delete_file", {
				source: "fw-source",
				path: join(locked, "app.log"),
			});
			expect(write.error).toEqual({
				type: "AgentPermissionDenied",
				kind: "permission_denied",
				agent: "fw-source",
				message: `Agent fw-source：没有权限写入 ${join(locked, "new.txt")}`,
			});
			expect(del.error).toMatchObject({
				type: "AgentPermissionDenied",
				message: `Agent fw-source：没有权限删除 ${join(locked, "app.log")}`,
			});
		} finally {
			await chmod(locked, 0o755);
		}
		expect(await readdir(locked)).toEqual(["app.log"]);
	}, 180_000);

	it("写到一半出错、运行被取消时，目标路径上不留下半截文件", async () => {
		const out = await sub("broken");
		await writeFile(join(out, "existing.log"), "keep me\n");

		const failed = await runNode("write_then_fail", {
			source: "fw-source",
			path: join(out, "existing.log"),
		});
		expect(failed.status).toBe("failed");
		expect(JSON.stringify(failed.error)).toContain("生成内容失败");
		await eventually(async () => expect(await readdir(out)).toEqual(["existing.log"]));
		expect(await readFile(join(out, "existing.log"), "utf8")).toBe("keep me\n");

		const runId = await trigger("write_until_cancelled", {
			source: "fw-source",
			path: join(out, "never.log"),
		});
		const lines = async () => {
			const taskId = (await api.node(runId, "n")).attempts[0]?.task_id;
			if (!taskId) return [];
			const page = logsApi.page.response.parse(
				await api.getJson(`/tasks/${encodeURIComponent(taskId)}/logs`),
			);
			return page.lines.map((l) => l.text);
		};
		await eventually(async () => expect(await lines()).toContain("已发出第一段"), 60_000);
		// 第一段已经到了 fw-source：临时文件在目标所在的目录里。
		await eventually(async () =>
			expect((await readdir(out)).some((n) => n.startsWith(".never.log.sfly-"))).toBe(true),
		);

		await api.cancelOk(runId);
		await eventually(async () => expect((await api.run(runId)).status).toBe("cancelled"), 30_000);
		await eventually(async () => expect(await readdir(out)).toEqual(["existing.log"]));
	}, 240_000);
});
