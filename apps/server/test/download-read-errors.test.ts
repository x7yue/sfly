// 下载文件时文件读不了（权限、被清理到一半）：这一次请求以错误结束，控制面不受影响，别的请求照常（#647）。
// 把文件流接到响应上的每一处各一条：任务日志、按运行下载日志、产物、节点包归档、Agent 二进制、SDK wheel、API 客户端安装包。
// 控制面在测试进程里运行：源文件流的错误没有人接时是一次未处理的 `error` 事件，测试进程会报「未处理的错误」而失败；
// 真正让控制面进程退出的复现见 `process-stream-errors.test.ts`。
// 造「读不了」：stat 能过、打开能过、读时出错（文件被换成同名的目录，EISDIR），和权限、被清理到一半一样是读的时候才出错，
// 不依赖测试是不是以 root 运行；Agent 二进制的下载在响应之前会检查它是不是普通文件，所以那一条用没有读权限（EACCES）。
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { logsApi } from "@sfly/schema";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const DOC = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "a", kind: "package", package: "stub", node: "echo" },
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
};

/** 把文件换成同名的目录：打开能过，读时出错。 */
async function breakFile(file: string): Promise<void> {
	await rm(file, { recursive: true, force: true });
	await mkdir(file, { recursive: true });
}

describe("下载文件时文件读不了", () => {
	let cp: TestControlPlane;
	let dir: string;
	let agent: FakeAgent;
	let runId: string;
	let task: AssignedTask;
	// 版本取控制面自己的（假 Agent 的版本和它一致，派发任务才不绕到 Agent 更新）。
	const { version } = packageJson;
	const wheel = `sfly-${version}-py3-none-any.whl`;
	const tarball = `sfly-client-${version}.tgz`;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "sfly-dl-err-"));
		await mkdir(join(dir, "wheels"));
		await mkdir(join(dir, "client"));
		await writeFile(join(dir, "wheels", wheel), "wheel 的字节");
		await writeFile(join(dir, "client", tarball), "安装包的字节");
		await writeFile(join(dir, "agent-x86"), "Agent 二进制的字节");
		cp = await startTestControlPlane({
			sdkWheelDir: join(dir, "wheels"),
			clientPackageDir: join(dir, "client"),
			agentBinaries: { x86_64: join(dir, "agent-x86") },
		});
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		const api = new ApiClient(cp);
		runId = await api.triggerOk(await api.orchestrationWith(DOC));
		task = await agent.nextAssign();
		agent.logs(task, [
			[1, "第一行"],
			[2, "第二行"],
		]);
		await eventually(async () => {
			const page = await (await cp.fetch(`/tasks/${task.taskId}/logs?limit=1000`)).json();
			expect(logsApi.page.response.parse(page).last_seq).toBe(2);
		});
		const put = await fetch(`${task.artifactUploadUrl}report.json`, {
			method: "PUT",
			headers: { "content-type": "application/octet-stream" },
			body: "产物的字节",
		});
		expect(put.status).toBe(201);
	}, 60_000);

	afterAll(async () => {
		await agent?.disconnect();
		await cp?.close();
		await rm(dir, { recursive: true, force: true });
	});

	/**
	 * 下载 `path`，文件已经读不了：响应是 500（响应开始发送之前出的错）或者断开的连接，不是 200；之后别的请求照常。
	 * 控制面和测试在同一个进程里，源文件流的错误没人接时测试进程会报未处理的错误。
	 */
	const failsAlone = async (path: string) => {
		const res = await cp.fetch(path).catch(() => undefined);
		if (res) {
			expect(res.status, path).toBe(500);
			expect(await res.json(), path).toMatchObject({ error: { code: "internal_error" } });
			// 路由为那个文件设的头不留在错误响应上：不是「下载一个文件」（浏览器不会把一段错误 JSON 当成要下载的文件），没有那个读不出来的
			// 文件的哈希（节点包归档），也不能被缓存。
			expect(res.headers.get("content-type"), path).toMatch(/^application\/json/);
			expect(res.headers.get("content-disposition"), path).toBeNull();
			expect(res.headers.get("x-sfly-sha256"), path).toBeNull();
			expect(res.headers.get("cache-control"), path).toBe("no-store");
		}
		expect((await cp.fetch("/health")).status).toBe(200);
		expect((await cp.fetch("/orchestrations")).status).toBe(200);
	};

	it("任务日志", async () => {
		const path = `/tasks/${task.taskId}/logs/download`;
		const before = await cp.fetch(path);
		expect(before.status).toBe(200);
		expect((await before.text()).split("\n").filter(Boolean)).toHaveLength(2);
		await breakFile(join(cp.dataDir, "logs", runId, `${task.taskId}.jsonl`));
		await failsAlone(path);
	});

	it("按运行下载日志", async () => {
		// 自己把这个任务的日志文件换成目录（不依赖上一条用例造的文件，单独跑也成立）：按运行下载读它时出错。
		await breakFile(join(cp.dataDir, "logs", runId, `${task.taskId}.jsonl`));
		await failsAlone(`/runs/${runId}/logs/download`);
	});

	it("产物", async () => {
		const path = `/tasks/${task.taskId}/artifacts/report.json`;
		const before = await cp.fetch(path);
		expect(before.status).toBe(200);
		expect(await before.text()).toBe("产物的字节");
		await breakFile(join(cp.dataDir, "artifacts", runId, task.taskId, "report.json"));
		await failsAlone(path);
	});

	it("节点包归档", async () => {
		const path = "/packages/stub/versions/1.0.0/archive";
		expect((await cp.fetch(path)).status).toBe(200);
		const db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		try {
			const { rows } = await db.query("select file_path from node_packages where name = 'stub'");
			await breakFile(join(cp.dataDir, rows[0].file_path as string));
		} finally {
			await db.end();
		}
		await failsAlone(path);
	});

	it("SDK wheel", async () => {
		const path = `/sdk/python/${version}/${wheel}`;
		expect((await cp.fetch(path)).status).toBe(200);
		await breakFile(join(dir, "wheels", wheel));
		await failsAlone(path);
	});

	it("API 客户端安装包", async () => {
		const path = `/client/${version}/${tarball}`;
		expect((await cp.fetch(path)).status).toBe(200);
		await breakFile(join(dir, "client", tarball));
		await failsAlone(path);
	});

	it.skipIf(process.getuid?.() === 0)("Agent 二进制（文件没有读权限）", async () => {
		const path = `/agent/binaries/${version}/x86_64`;
		const file = join(dir, "agent-x86");
		expect((await cp.fetch(path)).status).toBe(200);
		await chmod(file, 0o000);
		try {
			await failsAlone(path);
		} finally {
			await chmod(file, 0o644);
		}
	});
});

describe("关闭控制面", () => {
	it("关闭可以重复调用：第二次什么也不做，不拒绝（收到停止信号的处理函数被调用两次也不出错）", async () => {
		const cp = await startTestControlPlane();
		try {
			const first = cp.current.close();
			const second = cp.current.close();
			// 第二次拿到的是**同一个 promise**：和第一次同时落定，不会比它先完成（调用方不止一个时，一方不会在另一方还没关完时就当作
			// 「关完了」去退出进程）。
			expect(second).toBe(first);
			await expect(Promise.all([first, second])).resolves.toBeDefined();
			// 已经关完之后再调用也一样。
			expect(cp.current.close()).toBe(first);
			await expect(cp.current.close()).resolves.toBeUndefined();
		} finally {
			await cp.close();
		}
	}, 60_000);
});

describe("前端静态文件读不了", () => {
	it("500 和统一的错误体；不带一年的 immutable 缓存头（浏览器和代理不能把一次 500 当成那个文件缓存下来），也不留文件的内容类型", async () => {
		const webDir = await mkdtemp(join(tmpdir(), "sfly-web-err-"));
		await mkdir(join(webDir, "assets"));
		await writeFile(join(webDir, "index.html"), "<!doctype html><html></html>");
		await writeFile(join(webDir, "assets", "app-abc123.js"), "console.log('sfly');");
		const cp = await startTestControlPlane({ webDir });
		try {
			const ok = await cp.fetch("/assets/app-abc123.js");
			expect(ok.status).toBe(200);
			expect(ok.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
			// 启动时扫过的文件清单里有它，之后它被换成目录：读时出错。
			await breakFile(join(webDir, "assets", "app-abc123.js"));
			const res = await cp.fetch("/assets/app-abc123.js");
			expect(res.status).toBe(500);
			expect(await res.json()).toMatchObject({ error: { code: "internal_error" } });
			expect(res.headers.get("cache-control")).toBe("no-store");
			expect(res.headers.get("content-type")).toMatch(/^application\/json/);
			expect((await cp.fetch("/health")).status).toBe(200);
		} finally {
			await cp.close();
			await rm(webDir, { recursive: true, force: true });
		}
	}, 60_000);
});

// 日志文件的流出错（源流读到一半出错）：`normalizeLogStream` 把错误落到返回的流上，不留没人接的 `error` 事件。
describe("日志文件的流", () => {
	it("源流出错：已经读到的内容照常出来，之后返回的流以这个错误结束，源流被销毁；没有没人接的 error 事件", async () => {
		const { normalizeLogStream } = await import("../src/http/log-routes.js");
		const { NO_LOG_MASK } = await import("../src/logs/log-mask.js");
		const boom = new Error("读文件出错");
		let sourceDestroyed = false;
		let reads = 0;
		const source = new Readable({
			read() {
				// 先给一行，下一次读时出错。
				reads += 1;
				if (reads === 1) this.push(Buffer.from('{"seq":1}\n'));
				else this.destroy(boom);
			},
			destroy(error, callback) {
				sourceDestroyed = true;
				callback(error);
			},
		});
		const chunks: string[] = [];
		const result = await new Promise<Error | undefined>((resolve) => {
			const stream = normalizeLogStream(source, NO_LOG_MASK);
			stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
			stream.on("error", resolve);
			stream.on("end", () => resolve(undefined));
		});
		expect(result).toBe(boom);
		expect(chunks.join("")).toContain('"seq":1');
		expect(sourceDestroyed).toBe(true);
	});
});
