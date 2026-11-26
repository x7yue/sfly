// 模型没有配置、或上次试连连不上：`GET /health` 报缺什么，`POST /sessions/:id/prompt` 在登记之前 503，不起 pi 进程（#548）。
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AssistantErrorBody, AssistantHealth } from "@sfly/schema";
import { afterEach, describe, expect, it } from "vitest";
import { MODEL_PROBE_INTERVAL_MS, type Probe } from "../src/model-health.js";
import { eventually } from "./support/eventually.js";
import { modelsJson } from "./support/fake-model.js";
import { Harness, type HarnessOptions, SECRET } from "./support/harness.js";
import { ManualClock } from "./support/manual-clock.js";
import { closedPort } from "./support/ports.js";

const FAKE_PI = [process.execPath, join(import.meta.dirname, "support", "fake-pi.mjs")];
const KEY = "sk-do-not-echo-0123456789";

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const start = async (options: HarnessOptions = {}) => {
	h = await Harness.start({ piArgv: FAKE_PI, ...options });
	return h;
};

const health = async (harness: Harness) =>
	AssistantHealth.parse(
		await (
			await fetch(`${harness.url}/health`, { headers: { authorization: `Bearer ${SECRET}` } })
		).json(),
	);

/** 被拒绝的 prompt：503、错误码和说明；这个会话没有登记（没有任何事件），没有起 pi（没有进程、没有设置目录）。 */
async function expectRejected(harness: Harness, code: string, reason: RegExp | string) {
	const id = crypto.randomUUID();
	const res = await harness.prompt(id, { text: "settle" });
	expect(res.status).toBe(503);
	const body = AssistantErrorBody.parse(await res.json());
	expect(body.code).toBe(code);
	expect(body.message).toMatch(reason);
	expect(harness.events.of(id)).toEqual([]);
	expect(harness.sessions.activeProcesses).toBe(0);
	const agents = join(harness.dataDir, "agents");
	expect(existsSync(agents) ? readdirSync(agents) : []).toEqual([]);
	// 没有登记：同一个会话马上再说一次，还是同样的 503（不是 409 turn_running）。
	expect((await harness.prompt(id, { text: "settle", turn: 2 })).status).toBe(503);
	return body;
}

describe("模型没有配置：照常启动，/health 写明缺什么，新的一轮 503 model_not_configured", () => {
	it("没有模型文件", async () => {
		const harness = await start({ modelsFile: null });
		expect(await health(harness)).toMatchObject({
			model: {
				configured: false,
				endpoint: null,
				reachable: null,
				reason: expect.stringContaining("models.json"),
			},
		});
		await expectRejected(harness, "model_not_configured", /没有模型文件.*models\.json/);
	});

	it("SFLY_ASSISTANT_MODEL 选的模型不在文件里", async () => {
		const harness = await start({ selectedModel: "fake/no-such-model" });
		expect((await health(harness)).model.reason).toContain("SFLY_ASSISTANT_MODEL");
		await expectRejected(harness, "model_not_configured", /SFLY_ASSISTANT_MODEL 选的模型不在/);
	});

	it("SFLY_ASSISTANT_MODEL 没设", async () => {
		const harness = await start({ selectedModel: undefined });
		await expectRejected(harness, "model_not_configured", /SFLY_ASSISTANT_MODEL 没有设置/);
	});

	it("引用的密钥变量没有值：只写变量名", async () => {
		const harness = await start({
			hostEnv: { PATH: process.env.PATH, SFLY_ASSISTANT_SECRET: SECRET },
		});
		const body = await expectRejected(
			harness,
			"model_not_configured",
			"模型文件引用了环境变量 FAKE_MODEL_KEY，助手服务的环境里没有值",
		);
		expect(body.message).not.toContain(KEY);
	});

	it("配好了（假模型、变量有值）：照常 202，一轮正常结束", async () => {
		const harness = await start();
		expect(await health(harness)).toMatchObject({ model: { configured: true } });
		const id = crypto.randomUUID();
		expect((await harness.prompt(id, { text: "settle" })).status).toBe(202);
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "completed" });
	});
});

describe("模型端点连不上：/health 报连不上，新的一轮 503 model_unreachable；之后连上了就恢复", () => {
	it("上次试连失败：503，不起 pi；下一次试连成功之后 202", async () => {
		const clock = new ManualClock();
		const results = [
			{ ok: false as const, errorClass: "unreachable" as const, cause: "连接被拒绝" },
			{ ok: true as const },
		];
		const probe: Probe = async () => results.shift() ?? { ok: true };
		const harness = await start({ modelClock: clock, probe });
		await eventually(async () => expect((await health(harness)).model.reachable).toBe(false));
		const snapshot = (await health(harness)).model;
		expect(snapshot).toMatchObject({
			configured: true,
			endpoint: { host: "127.0.0.1", port: harness.model.port },
			reachable: false,
			error_class: "unreachable",
			reason: `连不上模型端点 127.0.0.1:${harness.model.port}：连接被拒绝`,
			checked_at: new Date(clock.now()).toISOString(),
		});
		await expectRejected(
			harness,
			"model_unreachable",
			`连不上模型端点 127.0.0.1:${harness.model.port}`,
		);
		clock.advance(MODEL_PROBE_INTERVAL_MS);
		await eventually(async () => expect((await health(harness)).model.reachable).toBe(true));
		const id = crypto.randomUUID();
		expect((await harness.prompt(id, { text: "settle" })).status).toBe(202);
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "completed" });
	});

	it("真的连不上（端点那一端没有服务）：启动时的试连得到 unreachable", async () => {
		const port = await closedPort();
		const harness = await start({
			modelsFile: modelsJson({ baseUrl: `http://127.0.0.1:${port}/v1` }),
		});
		await eventually(async () =>
			expect((await health(harness)).model).toMatchObject({
				reachable: false,
				error_class: "unreachable",
			}),
		);
		await expectRejected(
			harness,
			"model_unreachable",
			`连不上模型端点 127.0.0.1:${port}：连接被拒绝`,
		);
	});
});
