// 上传产物的请求体一律按原始的字节流存，不管 `Content-Type` 写的是什么（#665）。以前 `text/plain` 和 JSON 的请求体在到达存储之前就被
// 框架自带的解析器读成了字符串或对象：记的大小是字符数、存的是重新编码之后的字节（非法的 UTF-8 变成替换字符），所以记下的合计等于
// 上限时磁盘上可以是三倍，下载时只拿到一部分；JSON 请求体是对象或数时回 500，`null` 存成空文件；写得不成样子的 `Content-Type` 回 415。
// 真实的 Agent 用 `application/octet-stream` 上传，碰不到；不经 Agent、直接调上传接口的客户端会碰到（e2e 里用 `fetch(url,
// { method: "PUT", body: "<html>…" })` 上传就是 text/plain）。
// 这里各种 `Content-Type` × 各种内容（非 ASCII、不是合法文字的字节、像 JSON 的、空的、大的）× 声明长度和分块传输各一遍：
// 记下的大小、存下的字节数、下载时的长度三者一致，内容逐字节等于发来的；并发时存下来的合计不超过上限。
import { createHash, randomBytes } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
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

interface PutResult {
	status: number;
	body: string;
}

/** 上传产物带的凭据：这台 Agent 的（`agent.auth`，连上 Agent 时取）。默认的个人令牌不能上传。 */
let agentAuth: Record<string, string> = {};

/**
 * 上传一份请求体：`declare` 为真时带 Content-Length，否则分块传输；`contentType` 是 undefined 时不带这个请求头。
 * 请求体分两次发（先发前一半，隔 `gapMs` 毫秒再发后一半），让并发的几份在时间上重叠。
 */
function put(
	url: string,
	options: { contentType: string | undefined; body: Buffer; declare: boolean; gapMs?: number },
): Promise<PutResult> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const req = httpRequest(
			url,
			{
				method: "PUT",
				headers: {
					...agentAuth,
					...(options.contentType === undefined ? {} : { "content-type": options.contentType }),
					...(options.declare
						? { "content-length": String(options.body.length) }
						: { "transfer-encoding": "chunked" }),
				},
			},
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					body += chunk;
				});
				res.on("error", () => {});
				res.on("end", () => {
					settled = true;
					resolve({ status: res.statusCode ?? 0, body });
				});
			},
		);
		req.on("error", (error) => {
			if (!settled) reject(error);
		});
		const half = Math.floor(options.body.length / 2);
		if (options.body.length === 0) return void req.end();
		req.write(options.body.subarray(0, half));
		setTimeout(() => req.end(options.body.subarray(half)), options.gapMs ?? 0);
	});
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** 各种内容：非 ASCII、不是合法文字的字节、像 JSON 的（对象、数、null、数组、字符串）、空的、大的、每个字节值都有的。 */
const PAYLOADS: Array<[name: string, body: Buffer]> = [
	["非 ASCII 文字", Buffer.from("中文 ✓ émoji 😀 \u0000 end\r\n")],
	["非法的 UTF-8", Buffer.from([0xff, 0xfe, 0x00, 0xc0, 0x80, 0xed, 0xa0, 0x80, 0x41, 0xf5])],
	["UTF-8 BOM 加文字", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("bom")])],
	["JSON 对象", Buffer.from('{"a":1,"b":[true,null]}')],
	["JSON 数", Buffer.from("42")],
	["JSON null", Buffer.from("null")],
	["JSON 数组", Buffer.from("[1,2,3]")],
	["JSON 字符串", Buffer.from('"x"')],
	["不是 JSON 的大括号", Buffer.from("{not json")],
	["空", Buffer.alloc(0)],
	["每个字节值各一次", Buffer.from(Array.from({ length: 256 }, (_, i) => i))],
	["30 万个随机字节（分好几块到达）", randomBytes(300_000)],
];

/** 各种 `Content-Type`：框架自带解析器认的、认得但参数写错的、别的、没写、写得不成样子的（框架在解析之前就回 415 的）。 */
const CONTENT_TYPES: Array<string | undefined> = [
	"application/octet-stream",
	"text/plain",
	"text/plain; charset=utf-8",
	"text/plain; charset=latin1",
	"application/json",
	"APPLICATION/JSON; charset=utf-8",
	"application/json; charset=bogus",
	"application/x-www-form-urlencoded",
	"multipart/form-data; boundary=x",
	undefined,
	"garbage",
	"text/",
	"",
];

const describeType = (contentType: string | undefined) =>
	contentType === undefined ? "没有 Content-Type" : `Content-Type: ${JSON.stringify(contentType)}`;

describe("上传产物：请求体一律按原始字节存，不管 Content-Type", () => {
	let cp: TestControlPlane;
	let agent: FakeAgent;
	let task: AssignedTask;

	beforeAll(async () => {
		cp = await startTestControlPlane({ artifactLimitBytes: 64 * 1024 * 1024 });
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		agentAuth = agent.auth;
		const api = new ApiClient(cp);
		await api.triggerOk(await api.orchestrationWith(DOC));
		task = await agent.nextAssign();
	}, 60_000);
	afterAll(async () => {
		await agent?.disconnect();
		await cp?.close();
	});

	it.each(CONTENT_TYPES.map((contentType) => [describeType(contentType), contentType] as const))(
		"%s：每种内容、声明长度和分块传输各一遍，记下的大小、存下的字节、下载的长度和内容都和发来的一致",
		async (_, contentType) => {
			let index = 0;
			for (const declare of [true, false]) {
				for (const [payloadName, body] of PAYLOADS) {
					const label = `${payloadName}（${declare ? "声明长度" : "分块传输"}）`;
					const name = `${index++}-${declare ? "length" : "chunked"}.bin`;
					const url = `${task.artifactUploadUrl}${name}`;

					const res = await put(url, { contentType, body, declare });

					expect(res.status, `${label}：${res.body}`).toBe(201);
					const view = JSON.parse(res.body) as { name: string; size: number; sha256: string };
					expect(view.size, `${label} 记下的大小`).toBe(body.length);
					expect(view.sha256, `${label} 记下的哈希`).toBe(sha256(body));
					const download = await cp.fetch(`/tasks/${task.taskId}/artifacts/${name}`);
					expect(download.status, label).toBe(200);
					expect(download.headers.get("content-length"), `${label} 下载时的长度`).toBe(
						String(body.length),
					);
					const downloaded = Buffer.from(await download.arrayBuffer());
					expect(downloaded.length, `${label} 下载到的字节数`).toBe(body.length);
					expect(downloaded.equals(body), `${label} 内容逐字节等于发来的`).toBe(true);
				}
			}
		},
		120_000,
	);

	it("记下的大小、列表里的大小、磁盘上文件的字节数是同一个数（多字节的字符不按字符数记）", async () => {
		// 每个字符 3 个字节：300 个字符 900 字节。
		const body = Buffer.from("中".repeat(300));
		const name = "multibyte.txt";

		const res = await put(`${task.artifactUploadUrl}${name}`, {
			contentType: "text/plain; charset=utf-8",
			body,
			declare: true,
		});

		expect(res.status).toBe(201);
		expect(JSON.parse(res.body).size).toBe(900);
		const listed = (await (await cp.fetch(`/tasks/${task.taskId}/artifacts`)).json()) as {
			artifacts: Array<{ name: string; size: number }>;
		};
		expect(listed.artifacts.find((a) => a.name === name)?.size).toBe(900);
		const dir = join(cp.dataDir, "artifacts");
		const runs = await readdir(dir);
		const sizes: number[] = [];
		for (const run of runs) {
			const file = join(dir, run, task.taskId, name);
			sizes.push(
				await stat(file).then(
					(s) => s.size,
					() => -1,
				),
			);
		}
		expect(sizes).toContain(900);
	}, 60_000);
});

describe("上传产物：并发时存下来的合计不超过上限，不管 Content-Type", () => {
	const LIMIT = 1000;
	let cp: TestControlPlane;
	let agent: FakeAgent;

	afterEach(async () => {
		await agent?.disconnect();
		await cp?.close();
	});

	// 每份 399 个字节（133 个 3 字节的字符）：按字符数记是 133，三份加起来远不到上限；按字节记 399 × 3 > 1000，要拒绝一份。
	it.each([
		["text/plain", "text/plain; charset=utf-8"],
		["JSON", "application/json"],
		["写得不成样子的", "garbage"],
		["没有 Content-Type", undefined],
	] as const)(
		"%s：三份 399 字节的多字节文字同时上传，存下两份，第三份 413，合计 798 不超过 1000",
		async (_, contentType) => {
			cp = await startTestControlPlane({ artifactLimitBytes: LIMIT });
			await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
			agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
			agentAuth = agent.auth;
			const api = new ApiClient(cp);
			const runId = await api.triggerOk(await api.orchestrationWith(DOC));
			const task = await agent.nextAssign();
			const body = Buffer.from("中".repeat(133));
			expect(body.length).toBe(399);

			const results = await Promise.all(
				[0, 1, 2].map((i) =>
					put(`${task.artifactUploadUrl}f${i}.txt`, {
						contentType,
						body,
						declare: i % 2 === 0,
						gapMs: 200,
					}),
				),
			);

			expect(results.map((r) => r.status).sort()).toEqual([201, 201, 413]);
			const listed = (await (await cp.fetch(`/tasks/${task.taskId}/artifacts`)).json()) as {
				artifacts: Array<{ name: string; size: number }>;
			};
			const recorded = listed.artifacts.reduce((sum, a) => sum + a.size, 0);
			expect(recorded).toBe(798);
			// 磁盘上的字节数也是 798（记下的和存下的不会不一致）。
			const dir = join(cp.dataDir, "artifacts", runId, task.taskId);
			let onDisk = 0;
			for (const name of await readdir(dir)) {
				if (!name.startsWith(".")) onDisk += (await stat(join(dir, name))).size;
			}
			expect(onDisk).toBe(798);
			expect(recorded).toBeLessThanOrEqual(LIMIT);
		},
		60_000,
	);
});
