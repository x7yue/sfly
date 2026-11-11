// 全栈（#199，ADR 0019）：真实的控制面、两台真实 Rust Agent（同一台机器、不同的主目录和端口）和 SDK 执行器。
// rd-runner 上的节点用 ctx.agent(source) 读取 rd-source 上的文件、把它下载到 rd-runner 本地；
// 下载的数据由 rd-runner 直接写到本地路径，不经过节点进程和控制面。ctx.agent() 对 rd-runner 自己有相同的结果；
// 运行被取消时下载立即结束。节点包是 testdata/agent-files-package（sfly_agent_files.read）。
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logsApi } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type AgentPair,
	type BrokenPeers,
	registerBrokenPeers,
	startAgentPair,
} from "./support/agent-pair.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { publishTestPackage } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const PACKAGE = "sfly-agent-files";

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

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

describe("全栈：Agent 能力 files.read", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let pair: AgentPair;
	let broken: BrokenPeers;
	let dir: string;
	let log: string;
	let body: Buffer;

	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishTestPackage(cp, "testdata/agent-files-package", `${PACKAGE}-0.1.0.sflypkg`);
		pair = await startAgentPair({ grpcUrl: cp.grpcUrl, runner: "rd-runner", source: "rd-source" });
		broken = await registerBrokenPeers(cp.grpcUrl, { gone: "rd-gone", silent: "rd-silent" });
		// rd-source 上的日志（两台 Agent 在同一台机器上，绝对路径相同）：开头是一行文本，之后是几 MB 的任意字节。
		dir = await mkdtemp(join(tmpdir(), "sfly-agent-read-"));
		log = join(dir, "app.log.1");
		// 没有 0 字节：读到的第一行会进节点输出，输出里的 NUL 字符目前会让控制面存不下任务结果。
		const noise = Buffer.alloc(5 * 1024 * 1024 + 11);
		for (let i = 0; i < noise.length; i++)
			noise[i] = 1 + ((((i * 2_654_435_761) >>> 24) % 255) | 0);
		body = Buffer.concat([Buffer.from("2026-11-11 第一行日志\n"), noise]);
		await writeFile(log, body);
	}, 600_000);

	afterAll(async () => {
		await broken?.close();
		await pair?.close();
		await cp?.close();
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	/** 在 rd-runner 上运行一个节点，等运行结束，返回这个节点。 */
	const runNode = async (node: string, inputs: Record<string, unknown>) => {
		const id = await api.orchestrationWith({
			default_agent: "rd-runner",
			nodes: [
				{ id: "entry", kind: "entry", params: [] },
				{ id: "n", kind: "package", package: PACKAGE, node, inputs },
			],
			edges: [{ from: "entry", to: "n", kind: "chain" }],
			packages: { [PACKAGE]: "0.1.0" },
		});
		const runId = await api.triggerOk(id);
		await eventually(
			async () => expect(["success", "failed"]).toContain((await api.run(runId)).status),
			60_000,
		);
		const n = await api.node(runId, "n");
		expect(n.status, JSON.stringify(n.error)).toBe("success");
		return n.outputs as Record<string, unknown>;
	};

	it("rd-runner 上的节点流式读取 rd-source 上的文件，可以指定偏移和长度；ctx.agent() 读本机的结果相同", async () => {
		const whole = await runNode("read_file", { source: "rd-source", path: log });
		expect(whole).toMatchObject({ size: body.length, sha256: sha256(body) });
		expect(whole.first_line).toBe("2026-11-11 第一行日志");

		const part = body.subarray(1_000, 2_001_000);
		expect(
			await runNode("read_file", {
				source: "rd-source",
				path: log,
				offset: 1_000,
				length: 2_000_000,
			}),
		).toMatchObject({ size: part.length, sha256: sha256(part) });

		const own = await runNode("read_file", { path: log, offset: body.length - 100 });
		expect(own).toMatchObject({ size: 100, sha256: sha256(body.subarray(body.length - 100)) });
	}, 180_000);

	it("rd-runner 上的节点把 rd-source 上的文件下载到本地路径，内容一致；ctx.agent() 是本机上的复制", async () => {
		const local = await mkdtemp(join(tmpdir(), "sfly-agent-read-local-"));
		try {
			const target = join(local, "pulled", "app.log.1");
			expect(
				await runNode("download_file", { source: "rd-source", path: log, local_path: target }),
			).toEqual({ file: await expected(log), size: body.length, sha256: sha256(body) });
			expect(sha256(await readFile(target))).toBe(sha256(body));
			// 先写临时文件再改名：目录里只有下载好的文件。
			expect(await readdir(join(local, "pulled"))).toEqual(["app.log.1"]);

			const copy = join(local, "copy.log");
			expect(await runNode("download_file", { path: log, local_path: copy })).toMatchObject({
				file: await expected(log),
				sha256: sha256(body),
			});
		} finally {
			await rm(local, { recursive: true, force: true });
		}
	}, 180_000);

	it("运行被取消时，等着另一台 Agent 回应的下载立即结束并抛出取消", async () => {
		const local = await mkdtemp(join(tmpdir(), "sfly-agent-read-cancel-"));
		try {
			const id = await api.orchestrationWith({
				default_agent: "rd-runner",
				nodes: [
					{ id: "entry", kind: "entry", params: [] },
					{
						id: "n",
						kind: "package",
						package: PACKAGE,
						node: "wait_download",
						inputs: { source: "rd-silent", path: "/x", local_path: join(local, "x") },
					},
				],
				edges: [{ from: "entry", to: "n", kind: "chain" }],
				packages: { [PACKAGE]: "0.1.0" },
			});
			const runId = await api.triggerOk(id);
			const lines = async () => {
				const taskId = (await api.node(runId, "n")).attempts[0]?.task_id;
				if (!taskId) return [];
				const page = logsApi.page.response.parse(
					await api.getJson(`/tasks/${encodeURIComponent(taskId)}/logs`),
				);
				return page.lines.map((l) => l.text);
			};
			await eventually(async () => expect(await lines()).toContain("开始下载"), 60_000);

			await api.cancelOk(runId);
			await eventually(async () => expect((await api.run(runId)).status).toBe("cancelled"), 30_000);
			expect(await lines()).toContain("下载被取消");
			expect(await readdir(local)).toEqual([]);
		} finally {
			await rm(local, { recursive: true, force: true });
		}
	}, 180_000);
});
