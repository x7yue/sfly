// 切入点 A：产物与节点输出上限（#18）。假 Agent 收到 AssignTask 里的产物上传地址，经 HTTP 上传产物，
// 通过 HTTP 列出、下载产物；节点输出超过 1 MB 时任务以 node_error 失败。

import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import {
	clone,
	create,
	createFileRegistry,
	fromBinary,
	toBinary,
	toJson,
} from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema } from "@bufbuild/protobuf/wkt";
import { AssignTaskSchema, file_sfly_agent_v1_agent } from "@sfly/proto";
import { artifactsApi } from "@sfly/schema";
import { Agent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent, TaskStatus } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

interface ArtifactView {
	name: string;
	size: number;
	sha256: string;
	created_at: string;
	agent_modified_at: string | null;
	/** 下载地址（与 SDK 返回给节点、写进输出里的引用相同）。 */
	url: string;
}

interface ArtifactList {
	task_id: string;
	artifacts: ArtifactView[];
	expired: boolean;
}

const DOC = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "a", kind: "package", package: "stub", node: "echo" },
		{
			id: "b",
			kind: "package",
			package: "stub",
			node: "echo",
			inputs: { text: "${{ nodes.a.outputs.text }}" },
		},
	],
	edges: [
		{ from: "entry", to: "a", kind: "chain" },
		{ from: "a", to: "b", kind: "chain" },
	],
	packages: { stub: "1.0.0" },
};

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

describe("产物", () => {
	let cp: TestControlPlane;
	const agents: FakeAgent[] = [];

	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	const setup = async (
		options: { artifactLimitBytes?: number; agentToken?: string; document?: unknown } = {},
	) => {
		cp = await startTestControlPlane(options);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		const agent = await FakeAgent.connect(cp.grpcUrl, {
			name: "agent-a",
			token: options.agentToken,
		});
		agents.push(agent);
		const api = new ApiClient(cp);
		const runId = await api.triggerOk(await api.orchestrationWith(options.document ?? DOC));
		const task = await agent.nextAssign();
		return { agent, task, runId, api };
	};

	/** 像 Agent 一样上传一个产物：PUT 到上传地址 + 按路径段编码的名称。 */
	const upload = (
		task: AssignedTask,
		name: string,
		body: string | Buffer,
		token?: string,
		headers: Record<string, string> = {},
	) =>
		fetch(`${task.artifactUploadUrl}${name.split("/").map(encodeURIComponent).join("/")}`, {
			method: "PUT",
			headers: {
				"content-type": "application/octet-stream",
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...headers,
			},
			body,
		});

	/** 带上文件在 Agent 上的修改时间（Agent 时间，Unix 毫秒）上传。 */
	const uploadModifiedAt = (task: AssignedTask, name: string, modifiedMs: string) =>
		upload(task, name, "x", undefined, { "x-sfly-agent-modified-ms": modifiedMs });

	const list = async (taskId: string): Promise<ArtifactList> => {
		const res = await cp.fetch(`/tasks/${taskId}/artifacts`);
		expect(res.status).toBe(200);
		return artifactsApi.list.response.parse(await res.json()) as ArtifactList;
	};

	it("派发的任务带产物上传地址；上传后可以列出和下载，下载地址可以写进输出交给后续节点", async () => {
		const { agent, task, runId, api } = await setup();
		expect(task.artifactUploadUrl).toBe(`${cp.httpUrl}/tasks/${task.taskId}/artifacts/`);

		const report = JSON.stringify({ ok: true });
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
		const put = await upload(task, "report.json", report);
		expect(put.status).toBe(201);
		expect(await put.json()).toMatchObject({ name: "report.json", size: report.length });
		expect((await upload(task, "截图/第 1 张.png", png)).status).toBe(201);

		const { artifacts } = await list(task.taskId);
		expect(artifacts.map((a) => [a.name, a.size, a.sha256])).toEqual([
			["report.json", report.length, sha256(report)],
			["截图/第 1 张.png", png.length, sha256(png)],
		]);
		const shot = artifacts[1] as ArtifactView;
		expect(shot.url).toBe(
			`${task.artifactUploadUrl}${encodeURIComponent("截图")}/${encodeURIComponent("第 1 张.png")}`,
		);

		const res = await fetch(shot.url);
		expect(res.status).toBe(200);
		expect(Buffer.from(await res.arrayBuffer())).toEqual(png);
		expect(res.headers.get("content-disposition")).toContain(
			`filename*=UTF-8''${encodeURIComponent("第 1 张.png")}`,
		);

		// 节点输出里引用产物：后续节点的输入就是下载地址。
		await agent.succeed(task, { text: shot.url });
		const next = await agent.nextAssign();
		expect(next.inputs).toEqual({ text: shot.url });
		await agent.succeed(next, { text: "done" });
		expect((await api.run(runId)).status).toBe("success");

		// 任务结束后仍可下载，但不能再上传。
		expect((await fetch(shot.url)).status).toBe(200);
		const late = await upload(task, "late.txt", "x");
		expect(late.status).toBe(409);
		expect(((await late.json()) as { error: { code: string } }).error.code).toBe(
			"task_not_running",
		);
	});

	// #171：Agent 修改时间是被测机器上的事实，原样保存、不做范围检查；上传时间是控制面时间。
	it("保存并返回文件在 Agent 上的修改时间，不管它离控制面时间多远", async () => {
		const { task } = await setup();
		const uploadedAt = cp.clock.now().toISOString();
		const put = await uploadModifiedAt(task, "2099.txt", "4070908800123");
		expect(put.status).toBe(201);
		expect(await put.json()).toMatchObject({
			agent_modified_at: "2099-01-01T00:00:00.123Z",
			created_at: uploadedAt,
		});
		expect((await uploadModifiedAt(task, "1970.txt", "0")).status).toBe(201);
		expect((await uploadModifiedAt(task, "1969.txt", "-1000")).status).toBe(201);

		const { artifacts } = await list(task.taskId);
		expect(artifacts.map((a) => [a.name, a.agent_modified_at, a.created_at])).toEqual([
			["1969.txt", "1969-12-31T23:59:59.000Z", uploadedAt],
			["1970.txt", "1970-01-01T00:00:00.000Z", uploadedAt],
			["2099.txt", "2099-01-01T00:00:00.123Z", uploadedAt],
		]);
	});

	it("旧版本 Agent 不带修改时间时照常上传，Agent 修改时间为空", async () => {
		const { task } = await setup();
		const put = await upload(task, "old.txt", "x");
		expect(put.status).toBe(201);
		expect(await put.json()).toMatchObject({ name: "old.txt", agent_modified_at: null });
		expect((await list(task.taskId)).artifacts.map((a) => [a.name, a.agent_modified_at])).toEqual([
			["old.txt", null],
		]);
	});

	it("修改时间不是整数毫秒时，上传成功但 Agent 修改时间为空", async () => {
		const { task } = await setup();
		for (const [name, value] of [
			["text.txt", "yesterday"],
			["float.txt", "1.5"],
		] as const) {
			expect((await uploadModifiedAt(task, name, value)).status, name).toBe(201);
		}
		expect((await list(task.taskId)).artifacts.map((a) => a.agent_modified_at)).toEqual([
			null,
			null,
		]);
	});

	it("修改时间超出能记录的范围（公元 100 年到 9999 年）时，上传成功，Agent 修改时间记成边界值", async () => {
		const { task } = await setup();
		for (const [name, value] of [
			["ancient.txt", "-99999999999999999999"],
			["huge.txt", "99999999999999999999"],
		] as const) {
			expect((await uploadModifiedAt(task, name, value)).status, name).toBe(201);
		}
		expect((await list(task.taskId)).artifacts.map((a) => a.agent_modified_at)).toEqual([
			"0100-01-01T00:00:00.000Z",
			"9999-12-31T23:59:59.999Z",
		]);
	});

	it("同名产物覆盖时 Agent 修改时间跟着更新", async () => {
		const { task } = await setup();
		await uploadModifiedAt(task, "a.txt", "1000");
		await uploadModifiedAt(task, "a.txt", "2000");
		expect((await list(task.taskId)).artifacts[0]?.agent_modified_at).toBe(
			"1970-01-01T00:00:02.000Z",
		);
		await upload(task, "a.txt", "x");
		expect((await list(task.taskId)).artifacts[0]?.agent_modified_at).toBeNull();
	});

	it("同名产物重复上传时覆盖", async () => {
		const { task } = await setup();
		await upload(task, "a.txt", "first");
		await upload(task, "a.txt", "second!");
		const { artifacts } = await list(task.taskId);
		expect(artifacts.map((a) => [a.name, a.size])).toEqual([["a.txt", 7]]);
		expect(await (await fetch(artifacts[0]?.url ?? "")).text()).toBe("second!");
	});

	// #12 × #18：Agent 先上传产物再报结果，被取消的任务也一样。
	it("优雅取消中的任务仍能上传产物，之后上报取消结果", async () => {
		const { agent, task, runId, api } = await setup();
		await api.cancelOk(runId);
		expect(await agent.nextCancel()).toMatchObject({ taskId: task.taskId, force: false });

		expect((await upload(task, "partial.txt", "half")).status).toBe(201);
		await agent.cancelled(task);
		expect((await api.run(runId)).status).toBe("cancelled");
		const { artifacts } = await list(task.taskId);
		expect(artifacts.map((a) => [a.name, a.size])).toEqual([["partial.txt", 4]]);
		expect(await (await fetch(artifacts[0]?.url ?? "")).text()).toBe("half");
	});

	it("强制取消后控制面先把任务记为 cancelled，Agent 稍后上传的产物仍被接受", async () => {
		const { agent, task, runId, api } = await setup();
		await api.cancelOk(runId);
		await agent.nextCancel();
		// 运行没结束时第二次取消 = 强制取消：任务立即 cancelled，运行立即结束。
		await api.cancelOk(runId);
		expect(await agent.nextCancel()).toMatchObject({ taskId: task.taskId, force: true });
		const run = await api.run(runId);
		expect(run.status).toBe("cancelled");
		expect((await api.node(runId, "a")).attempts.map((t) => t.status)).toEqual(["cancelled"]);

		expect((await upload(task, "dump/state.bin", Buffer.alloc(10))).status).toBe(201);
		await agent.cancelled(task);
		expect((await list(task.taskId)).artifacts.map((a) => [a.name, a.size])).toEqual([
			["dump/state.bin", 10],
		]);
	});

	it("非法的产物名称被拒绝", async () => {
		const { task } = await setup();
		// fetch 会按 URL 规范折叠 `..` 段，这里用 node:http 原样发送路径。
		for (const raw of ["../x", "%2E%2E/x", "a//b", "a%5Cb", ".", "a/../b", "a/%2e%2e/b"]) {
			const res = await rawPut(`${task.artifactUploadUrl}${raw}`, "x");
			expect(res.status, raw).toBe(400);
			expect((JSON.parse(res.body) as { error: { code: string } }).error.code).toBe(
				"invalid_artifact_name",
			);
		}
		expect((await list(task.taskId)).artifacts).toEqual([]);
	});

	it("单个任务的产物总大小超过上限时拒绝（413），已有的产物不受影响", async () => {
		const { task } = await setup({ artifactLimitBytes: 1000 });
		expect((await upload(task, "a.bin", Buffer.alloc(600))).status).toBe(201);
		const res = await upload(task, "b.bin", Buffer.alloc(600));
		expect(res.status).toBe(413);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"artifact_too_large",
		);
		// 覆盖同名产物时按新大小计算。
		expect((await upload(task, "a.bin", Buffer.alloc(900))).status).toBe(201);
		expect((await list(task.taskId)).artifacts.map((a) => [a.name, a.size])).toEqual([
			["a.bin", 900],
		]);
	});

	describe("产物上限（#477）", () => {
		const GIB = 1024 * 1024 * 1024;

		it("旧版本 Agent 连新控制面：按没有 artifact_limit_bytes 的旧协议解码控制面发出的任务，其余字段原样，认不得的字段被忽略", async () => {
			const { task } = await setup({ artifactLimitBytes: 5000 });
			expect(task.artifactLimitBytes).toBe(5000n);

			// 旧版本 Agent 手里的协议：同一个文件描述，AssignTask 里没有字段 15。
			const oldFile = clone(FileDescriptorProtoSchema, file_sfly_agent_v1_agent.proto);
			const message = oldFile.messageType.find((m) => m.name === "AssignTask");
			expect(message?.field.map((f) => f.number)).toContain(15);
			if (message) message.field = message.field.filter((f) => f.number !== 15);
			const registry = createFileRegistry(oldFile, (name) =>
				file_sfly_agent_v1_agent.dependencies.find((d) => d.name === name),
			);
			const OldAssignTask = registry.getMessage("sfly.agent.v1.AssignTask");
			if (!OldAssignTask) throw new Error("旧协议里没有 AssignTask");

			// 控制面发出的字节（Agent 收到的就是这些）：旧协议能解码，不认识的字段 15 被忽略，其余字段一个不少。
			const wire = toBinary(AssignTaskSchema, create(AssignTaskSchema, task));
			const old = toJson(OldAssignTask, fromBinary(OldAssignTask, wire));
			const current = toJson(AssignTaskSchema, create(AssignTaskSchema, task)) as Record<
				string,
				unknown
			>;
			const { artifactLimitBytes, ...withoutLimit } = current;
			expect(artifactLimitBytes).toBe("5000");
			expect(old).toEqual(withoutLimit);
			expect(old).toMatchObject({
				taskId: task.taskId,
				package: "stub",
				artifactUploadUrl: task.artifactUploadUrl,
			});
		});

		it("派发的任务带产物上限：配置的值；没配置时是默认的 1 GB", async () => {
			const configured = await setup({ artifactLimitBytes: 5000 });
			expect(configured.task.artifactLimitBytes).toBe(5000n);
			await agents.pop()?.disconnect();
			await cp.close();

			const { task } = await setup();
			expect(task.artifactLimitBytes).toBe(BigInt(GIB));
		});

		it("超限的错误信息是中文：写明这个文件多大、这个任务已经上传了多少、上限多少、是哪个设置", async () => {
			const { task } = await setup({ artifactLimitBytes: 1000 });
			expect((await upload(task, "a.bin", Buffer.alloc(600))).status).toBe(201);

			const res = await upload(task, "b.bin", Buffer.alloc(600));

			expect(res.status).toBe(413);
			const { error } = (await res.json()) as { error: { code: string; message: string } };
			expect(error.code).toBe("artifact_too_large");
			expect(error.message).toContain("b.bin");
			expect(error.message).toContain("600 字节");
			expect(error.message).toContain("已上传 600 字节");
			expect(error.message).toContain("上限 1000 字节");
			expect(error.message).toContain("SFLY_ARTIFACT_LIMIT_MB");
			// 超限的文件没有留下，已有的不受影响。
			expect((await list(task.taskId)).artifacts.map((a) => [a.name, a.size])).toEqual([
				["a.bin", 600],
			]);
		});

		it("请求带了长度时，在读请求体之前就拒绝：只发请求头、不发请求体，413 已经回来了", async () => {
			const { task } = await setup({ artifactLimitBytes: 1000 });
			expect((await upload(task, "a.bin", Buffer.alloc(600))).status).toBe(201);

			// 声明 5 GB、一个字节的请求体都不发：读了请求体才拒绝的话，这里会一直等。
			const res = await headersOnlyPut(`${task.artifactUploadUrl}huge.bin`, 5 * GIB);

			expect(res.status).toBe(413);
			const { error } = JSON.parse(res.body) as { error: { code: string; message: string } };
			expect(error.code).toBe("artifact_too_large");
			expect(error.message).toContain("huge.bin");
			expect(error.message).toContain(`${5 * GIB} 字节`);
			expect(error.message).toContain("已上传 600 字节");
			expect(error.message).toContain("上限 1000 字节");
			expect((await list(task.taskId)).artifacts.map((a) => a.name)).toEqual(["a.bin"]);
		});

		it("合计按一次尝试算：前一次尝试存的不算，重试的那次还能存满", async () => {
			const retrying = {
				...DOC,
				nodes: DOC.nodes.map((n) => (n.id === "a" ? { ...n, retries: 1 } : n)),
			};
			const { agent, task } = await setup({ artifactLimitBytes: 1000, document: retrying });
			// 名称和重试时存的不同：同名的文件本来就不算在已上传里，同名的话按「运行」合计也看不出来。
			expect((await upload(task, "first-attempt.bin", Buffer.alloc(600))).status).toBe(201);
			await agent.fail(task, "探测失败");

			const retry = await agent.nextAssign();
			expect(retry.attempt).toBe(2);
			expect(retry.taskId).not.toBe(task.taskId);
			// 第一次尝试存了 600，重试的这一次的上限还是整个 1000，不是 400。
			expect((await upload(retry, "a.bin", Buffer.alloc(1000))).status).toBe(201);
			expect((await upload(retry, "b.bin", Buffer.alloc(1))).status).toBe(413);
			expect((await list(task.taskId)).artifacts.map((a) => [a.name, a.size])).toEqual([
				["first-attempt.bin", 600],
			]);
			expect((await list(retry.taskId)).artifacts.map((a) => [a.name, a.size])).toEqual([
				["a.bin", 1000],
			]);
		});

		it("按声明的长度提前拒绝之后不再读请求体：响应带 connection: close，请求体写进去也没人读，连接随后关闭", async () => {
			const { task } = await setup({ artifactLimitBytes: 1000 });
			expect((await upload(task, "a.bin", Buffer.alloc(600))).status).toBe(201);

			const done = await rejectedEarlyThenSendBody(`${task.artifactUploadUrl}big.bin`, 5000);

			expect(done.status).toBe(413);
			expect(done.connection).toBe("close");
			expect(done.closed, "413 之后连接应该被关掉，控制面不去读剩下的请求体").toBe(true);
			// 请求体没有被收下：产物列表里仍然只有 a.bin。
			expect((await list(task.taskId)).artifacts.map((a) => a.name)).toEqual(["a.bin"]);
		});

		it("声明的长度刚好放得下的请求照常接受；同名的旧文件不算在已上传里", async () => {
			const { task } = await setup({ artifactLimitBytes: 1000 });
			expect((await upload(task, "a.bin", Buffer.alloc(600))).status).toBe(201);

			expect((await upload(task, "b.bin", Buffer.alloc(400))).status).toBe(201);
			expect((await upload(task, "a.bin", Buffer.alloc(600))).status).toBe(201);
			expect((await list(task.taskId)).artifacts.map((a) => [a.name, a.size])).toEqual([
				["a.bin", 600],
				["b.bin", 400],
			]);
		});

		it("没有带长度的请求（分块传输）也拒绝：读到超过时停下，错误信息写明上限和已上传的", async () => {
			const { task } = await setup({ artifactLimitBytes: 1000 });
			expect((await upload(task, "a.bin", Buffer.alloc(600))).status).toBe(201);

			const res = await chunkedPut(`${task.artifactUploadUrl}b.bin`, [
				Buffer.alloc(300),
				Buffer.alloc(300),
			]);

			expect(res.status).toBe(413);
			const { error } = JSON.parse(res.body) as { error: { message: string } };
			expect(error.message).toContain("b.bin");
			expect(error.message).toContain("已上传 600 字节");
			expect(error.message).toContain("上限 1000 字节");
			expect(error.message).toContain("SFLY_ARTIFACT_LIMIT_MB");
			expect((await list(task.taskId)).artifacts.map((a) => a.name)).toEqual(["a.bin"]);
		});
	});

	it("配置了 Agent 注册令牌时，上传必须带上令牌", async () => {
		const { task } = await setup({ agentToken: "s3cret" });
		expect((await upload(task, "a.txt", "x")).status).toBe(401);
		expect((await upload(task, "a.txt", "x", "wrong")).status).toBe(401);
		expect((await upload(task, "a.txt", "x", "s3cret")).status).toBe(201);
	});

	it("任务或产物不存在时 404", async () => {
		const { task } = await setup();
		const missing = "00000000-0000-4000-8000-000000000000";
		expect((await cp.fetch(`/tasks/${missing}/artifacts`)).status).toBe(404);
		expect((await cp.fetch(`/tasks/${task.taskId}/artifacts/nope.txt`)).status).toBe(404);
		const put = await fetch(`${cp.httpUrl}/tasks/${missing}/artifacts/a.txt`, {
			method: "PUT",
			headers: { "content-type": "application/octet-stream" },
			body: "x",
		});
		expect(put.status).toBe(404);
	});

	it("产物名里带 NUL 时按不存在处理，返回 404 而不是 500（#212）", async () => {
		const { task } = await setup();
		for (const name of ["a%00b", "%00"]) {
			const res = await cp.fetch(`/tasks/${task.taskId}/artifacts/${name}`);
			expect(res.status, name).toBe(404);
			expect(await res.json(), name).toMatchObject({ error: { code: "not_found" } });
		}
	});
});

/** 这个地址是否拒绝新连接（控制面关闭时 app.close() 已经开始）。 */
const refusesConnections = (httpUrl: string) =>
	new Promise<boolean>((resolve) => {
		const { hostname, port } = new URL(httpUrl);
		const socket = connect(Number(port), hostname);
		socket.once("connect", () => {
			socket.destroy();
			resolve(false);
		});
		socket.once("error", () => resolve(true));
	});

describe("控制面关闭时还在下载的产物", () => {
	// app.close() 只在开始时关掉当时空闲的 keep-alive 连接。还在发送的响应（产物下载）发完后连接成了空闲连接，
	// 没人关的话要等客户端或服务端的 keep-alive 超时（约 70 秒），控制面关闭一直等它。
	it("下载发完后连接随即关闭，控制面关闭不等 keep-alive 超时", async () => {
		const cp = await startTestControlPlane();
		const client = new Agent();
		let closing: Promise<void> | undefined;
		try {
			await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
			const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
			const api = new ApiClient(cp);
			await api.triggerOk(await api.orchestrationWith(DOC));
			const task = await agent.nextAssign();
			// 比内核和客户端的缓冲区都大：客户端不读响应体，控制面就发不完。
			const big = Buffer.alloc(32 * 1024 * 1024, 7);
			const put = await fetch(`${task.artifactUploadUrl}big.bin`, {
				method: "PUT",
				headers: { "content-type": "application/octet-stream" },
				body: big,
			});
			expect(put.status).toBe(201);
			await agent.disconnect();

			const res = await fetch(`${task.artifactUploadUrl}big.bin`, {
				dispatcher: client,
			} as RequestInit);
			expect(res.status).toBe(200);
			closing = cp.close();
			await eventually(async () => expect(await refusesConnections(cp.httpUrl)).toBe(true));
			expect((await res.arrayBuffer()).byteLength).toBe(big.length);
			const outcome = await Promise.race([
				closing.then(() => "closed"),
				sleep(10_000).then(() => "still waiting"),
			]);
			expect(outcome).toBe("closed");
		} finally {
			await client.destroy();
			await (closing ?? cp.close());
		}
	}, 30_000);
});

describe("节点输出上限", () => {
	let cp: TestControlPlane;
	let agent: FakeAgent;

	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	it("输出超过 1 MB 时任务以 node_error 失败，不推进后续节点", async () => {
		cp = await startTestControlPlane();
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		const api = new ApiClient(cp);
		const runId = await api.triggerOk(await api.orchestrationWith(DOC));
		const task = await agent.nextAssign();

		await agent.report({
			taskId: task.taskId,
			attempt: task.attempt,
			status: TaskStatus.SUCCESS,
			outputsJson: JSON.stringify({ text: "x".repeat(1024 * 1024) }),
		});

		const node = await api.node(runId, "a");
		expect(node.status).toBe("failed");
		expect(node.error?.kind).toBe("node_error");
		expect(node.error?.message).toContain("1 MB");
		expect(node.outputs).toBeNull();
		expect((await api.run(runId)).status).toBe("failed");
		await agent.expectNoAssign();
	});

	it("刚好 1 MB 的输出可以通过", async () => {
		cp = await startTestControlPlane();
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		const api = new ApiClient(cp);
		const runId = await api.triggerOk(await api.orchestrationWith(DOC));
		const task = await agent.nextAssign();
		const outputsJson = JSON.stringify({ text: "" });
		const text = "x".repeat(1024 * 1024 - outputsJson.length);

		await agent.succeed(task, { text });
		expect((await api.node(runId, "a")).status).toBe("success");
	});
});

/** 不做 URL 规范化的 PUT（路径原样发送）。 */
function rawPut(url: string, body: string): Promise<{ status: number; body: string }> {
	const { host, pathname } = new URL(url.replace(/\/artifacts\/.*$/, "/artifacts/"));
	const path = pathname + url.slice(url.indexOf("/artifacts/") + "/artifacts/".length);
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{
				host: host.split(":")[0],
				port: Number(host.split(":")[1]),
				path,
				method: "PUT",
				headers: { "content-type": "application/octet-stream" },
			},
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (c: string) => {
					text += c;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
			},
		);
		req.on("error", reject);
		req.end(body);
	});
}

/**
 * 声明了 `length` 字节的请求体、先只发请求头：收到响应之后再把请求体写进去，看控制面有没有关掉连接。
 * 返回响应的状态码、`connection` 头，和写完请求体之后连接有没有在 3 秒内被关掉。
 */
function rejectedEarlyThenSendBody(
	url: string,
	length: number,
): Promise<{ status: number; connection: string | undefined; closed: boolean }> {
	const { hostname, port, pathname } = new URL(url);
	return new Promise((resolve) => {
		const socket = connect(Number(port), hostname);
		let received = "";
		let answered: { status: number; connection: string | undefined } | undefined;
		let closed = false;
		const finish = (closedInTime: boolean) => {
			if (!answered) return resolve({ status: 0, connection: undefined, closed: closedInTime });
			resolve({ ...answered, closed: closedInTime });
			socket.destroy();
		};
		socket.on("error", () => {});
		socket.on("close", () => {
			closed = true;
			if (answered) finish(true);
		});
		socket.on("data", (chunk: Buffer) => {
			received += chunk.toString("latin1");
			const end = received.indexOf("\r\n\r\n");
			if (answered || end < 0) return;
			const head = received.slice(0, end).split("\r\n");
			const status = Number(head[0]?.split(" ")[1]);
			const connectionHeader = head
				.slice(1)
				.find((line) => line.toLowerCase().startsWith("connection:"));
			answered = { status, connection: connectionHeader?.split(":")[1]?.trim().toLowerCase() };
			// 把声明的请求体写进去（连接已被对方关掉时写会失败，忽略）。
			for (let sent = 0; sent < length; sent += 1000) {
				socket.write(Buffer.alloc(Math.min(1000, length - sent)), () => {});
			}
			setTimeout(() => {
				if (!closed) finish(false);
			}, 3000);
		});
		socket.on("connect", () => {
			socket.write(
				`PUT ${pathname} HTTP/1.1\r\nhost: ${hostname}:${port}\r\n` +
					`content-type: application/octet-stream\r\ncontent-length: ${length}\r\n\r\n`,
			);
		});
	});
}

/** 只发请求头（声明了 `length` 字节的请求体）、不发请求体的 PUT：控制面在读请求体之前回了响应，就能收到。 */
function headersOnlyPut(url: string, length: number): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			url,
			{
				method: "PUT",
				headers: { "content-type": "application/octet-stream", "content-length": String(length) },
			},
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (c: string) => {
					text += c;
				});
				res.on("end", () => {
					req.destroy();
					resolve({ status: res.statusCode ?? 0, body: text });
				});
			},
		);
		req.on("error", reject);
		// 不调用 req.end()：请求头发出去、请求体一个字节也没有。
		req.flushHeaders();
		setTimeout(() => {
			req.destroy();
			reject(new Error("控制面没有在读请求体之前回响应"));
		}, 5000).unref();
	});
}

/** 分块传输（没有 content-length）的 PUT。 */
function chunkedPut(url: string, chunks: Buffer[]): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			url,
			{
				method: "PUT",
				headers: { "content-type": "application/octet-stream", "transfer-encoding": "chunked" },
			},
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (c: string) => {
					text += c;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
			},
		);
		req.on("error", reject);
		for (const chunk of chunks) req.write(chunk);
		req.end();
	});
}
