// API 客户端（@sfly/client）对着真实的测试控制面：用真实的 fetch，不替换；
// 请求头经 recording-proxy.ts、断线经 tcp-proxy.ts 观察时，把 baseUrl 指向代理。
import { type Client, type ClientOptions, createClient } from "@sfly/client";
import { expect } from "vitest";
import { ApiClient } from "./api-client.js";
import { eventually } from "./eventually.js";
import { FakeAgent } from "./fake-agent.js";
import { publishPackage } from "./package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./test-control-plane.js";

export interface ObservedClient {
	client: Client;
	/** 客户端交给时间回调的每个控制面时间，按收到的顺序。 */
	times: string[];
}

/** 创建 API 客户端，记下它交给回调的控制面时间；options 里给了回调时以 options 为准。 */
export function observedClient(options: ClientOptions): ObservedClient {
	const times: string[] = [];
	const client = createClient({ onControlPlaneTime: (time) => times.push(time), ...options });
	return { client, times };
}

/** 启动测试控制面，返回它和一个指向它的 API 客户端。 */
export async function startClientControlPlane(
	options: Parameters<typeof startTestControlPlane>[0] = {},
): Promise<ObservedClient & { cp: TestControlPlane }> {
	const cp = await startTestControlPlane(options);
	return { cp, ...observedClient({ baseUrl: cp.httpUrl }) };
}

export interface FinishedRun {
	scenarioId: string;
	runId: string;
	taskId: string;
	chainInstanceId: string;
	/** 产物目录内的相对路径和内容。 */
	artifact: { name: string; body: string };
	/** 任务写下的日志行。 */
	logLines: string[];
}

const SEED_AGENT = "agent-a";

/**
 * 准备一次结束了的运行，供查询读取：节点包 `probe@1.0.0`（声明指标 `tps`），
 * 场景「巡检」（入口参数 env，默认 staging）以 env=prod 触发，假 Agent 写日志、上报指标、上传产物后成功。
 * 经原始 HTTP 准备，不经过被测的 API 客户端。
 */
export async function seedFinishedRun(cp: TestControlPlane): Promise<FinishedRun> {
	const api = new ApiClient(cp);
	await publishPackage(cp, "probe", "1.0.0", {
		check: {
			outputs: ["ok"],
			metrics: [{ name: "tps", unit: "req/s", kind: "gauge" }],
			charts: [{ title: "TPS", type: "line", metrics: ["tps"] }],
		},
	});
	const scenarioId = await api.orchestrationWith(
		{
			default_agent: SEED_AGENT,
			nodes: [
				{
					id: "entry",
					kind: "entry",
					params: [{ name: "env", type: "string", default: "staging" }],
				},
				{ id: "check", kind: "package", package: "probe", node: "check" },
			],
			edges: [{ from: "entry", to: "check", kind: "chain" }],
			packages: { probe: "1.0.0" },
		},
		"巡检",
	);
	const agent = await FakeAgent.connect(cp.grpcUrl, { name: SEED_AGENT }, { clock: cp.clock });
	try {
		const runId = await api.triggerOk(scenarioId, { env: "prod" });
		const task = await agent.nextAssign();
		const logLines = ["开始巡检", "巡检通过"];
		agent.logs(
			task,
			logLines.map((text, i) => [i + 1, text]),
		);
		const second = Math.floor(cp.clock.now().getTime() / 1000);
		agent.metrics(task, [
			["tps", second, 10],
			["tps", second + 1, 20],
		]);
		const artifact = { name: "报告/结果 1.json", body: JSON.stringify({ ok: true }) };
		const put = await fetch(
			`${task.artifactUploadUrl}${artifact.name.split("/").map(encodeURIComponent).join("/")}`,
			{
				method: "PUT",
				headers: { "content-type": "application/octet-stream" },
				body: artifact.body,
			},
		);
		if (put.status !== 201) throw new Error(`upload artifact: ${await put.text()}`);
		await agent.succeed(task, { ok: true });
		await eventually(async () => {
			expect((await api.run(runId)).status).toBe("success");
			const logs = await api.getJson<{ lines: unknown[] }>(`/tasks/${task.taskId}/logs`);
			expect(logs.lines).toHaveLength(logLines.length);
		});
		const chainInstanceId = (await api.run(runId)).chains[0]?.id as string;
		return { scenarioId, runId, taskId: task.taskId, chainInstanceId, artifact, logLines };
	} finally {
		await agent.disconnect();
	}
}
