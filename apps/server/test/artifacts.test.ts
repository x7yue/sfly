// 切入点 A：产物与节点输出上限（#18）。假 Agent 收到 AssignTask 里的产物上传地址，经 HTTP 上传产物，
// 通过 HTTP 列出、下载产物；节点输出超过 1 MB 时任务以 node_error 失败。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串

import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { artifactsApi } from "@sfly/schema";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { type AssignedTask, FakeAgent, TaskStatus } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

interface ArtifactView {
	name: string;
	size: number;
	sha256: string;
	created_at: string;
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

	const setup = async (options: { artifactLimitBytes?: number; agentToken?: string } = {}) => {
		cp = await startTestControlPlane(options);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		const agent = await FakeAgent.connect(cp.grpcUrl, {
			name: "agent-a",
			token: options.agentToken,
		});
		agents.push(agent);
		const api = new ApiClient(cp);
		const runId = await api.triggerOk(await api.orchestrationWith(DOC));
		const task = await agent.nextAssign();
		return { agent, task, runId, api };
	};

	/** 像 Agent 一样上传一个产物：PUT 到上传地址 + 按路径段编码的名称。 */
	const upload = (task: AssignedTask, name: string, body: string | Buffer, token?: string) =>
		fetch(`${task.artifactUploadUrl}${name.split("/").map(encodeURIComponent).join("/")}`, {
			method: "PUT",
			headers: {
				"content-type": "application/octet-stream",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body,
		});

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
