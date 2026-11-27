// 模型出故障时的时间线（#548 验收标准）：重试提示写明第几次、什么类别，最后因为什么停下、这一轮已经做了几步。
// 真的 pi 接假的模型端点：429、503、成功；一直 503；402；连接被拒绝。每一类的类别和说法用假 pi 一次测完（不等重试的间隔）。
import { join } from "node:path";
import type { ErrorClass } from "@sfly/schema";
import { AssistantHealth } from "@sfly/schema";
import { afterEach, describe, expect, it } from "vitest";
import { modelsJson } from "./support/fake-model.js";
import { Harness, type HarnessOptions, SECRET } from "./support/harness.js";
import { closedPort } from "./support/ports.js";

const FAKE_PI = [process.execPath, join(import.meta.dirname, "support", "fake-pi.mjs")];
const SECRET_BODY =
	'{"error":{"message":"UPSTREAM-BODY-7f3c provider-acme account-42","type":"x","code":"y"}}';

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const notices = (harness: Harness, id: string) =>
	harness.events
		.of(id)
		.map((r) => r.event)
		.flatMap((e) => (e.type === "notice" ? [e] : []));

describe("真的 pi 接假的模型端点", () => {
	it("依次返回 429、503、成功：两条重试提示（第几次、类别），这一轮正常完成", async () => {
		h = await Harness.start();
		h.model.failures = [
			{ status: 429, body: SECRET_BODY },
			{ status: 503, body: SECRET_BODY },
		];
		const id = crypto.randomUUID();
		await h.prompt(id, { text: "说一句话" });
		expect(await h.turnEnd(id)).toMatchObject({ outcome: "completed" });
		const retries = notices(h, id).filter((n) => n.kind === "retry");
		expect(retries).toHaveLength(2);
		expect(retries[0]).toMatchObject({
			attempt: 1,
			error_class: "rate_limit",
			message: expect.stringMatching(
				/^模型暂时不可用（429 被限流），正在第 1\/\d 次重试，\d+ 秒后$/,
			),
		});
		expect(retries[1]).toMatchObject({
			attempt: 2,
			error_class: "upstream",
			message: expect.stringMatching(
				/^模型暂时不可用（503 模型端点出错），正在第 2\/\d 次重试，\d+ 秒后$/,
			),
		});
		expect(notices(h, id).at(-1)).toMatchObject({ kind: "retry_end", message: "重试成功" });
		expect(h.events.lines.join("\n")).not.toContain("UPSTREAM-BODY");
	}, 90_000);

	it("做了一步之后一直 503：以「模型不可用」结束，类别 upstream，原因里有状态码，写明已经做了 1 步", async () => {
		h = await Harness.start();
		h.model.scripts.set("剧本：先做一步", [
			{ tool: "write", args: { path: "a.txt", content: "x\n" } },
			{ text: "做完了。" },
		]);
		// 第 1 个请求照剧本（调用写工具），之后的请求一直 503。
		h.model.failWhen = (index) => (index >= 1 ? { status: 503, body: SECRET_BODY } : undefined);
		const id = crypto.randomUUID();
		await h.prompt(id, { text: "剧本：先做一步" });
		const end = await h.turnEnd(id, 1, 120_000);
		expect(end).toMatchObject({
			outcome: "model_unavailable",
			error_class: "upstream",
			reason: "模型端点出错（503）",
			steps: 1,
		});
		const all = notices(h, id);
		expect(all.filter((n) => n.kind === "retry").map((n) => n.attempt)).toEqual([1, 2, 3]);
		expect(all.at(-1)).toMatchObject({
			kind: "retry_end",
			error_class: "upstream",
			message: "重试用尽：模型端点出错（503）",
		});
		expect(h.events.lines.join("\n")).not.toContain("UPSTREAM-BODY");
	}, 120_000);

	it("402：不重试，这一轮以 quota 结束，原因里有状态码", async () => {
		h = await Harness.start();
		h.model.failures = [{ status: 402, body: SECRET_BODY }];
		const id = crypto.randomUUID();
		await h.prompt(id, { text: "说一句话" });
		expect(await h.turnEnd(id)).toMatchObject({
			outcome: "model_unavailable",
			error_class: "quota",
			reason: "额度不足（402）",
			steps: 0,
		});
		expect(notices(h, id).filter((n) => n.kind === "retry")).toEqual([]);
	}, 90_000);

	it("模型端点连接被拒绝：重试之后以 unreachable 结束（不检查就绪状态：这里要的是一轮里的失败）", async () => {
		const options: HarnessOptions = {
			modelsFile: modelsJson({ baseUrl: `http://127.0.0.1:${await closedPort()}/v1` }),
			noModelGate: true,
		};
		h = await Harness.start(options);
		const id = crypto.randomUUID();
		await h.prompt(id, { text: "说一句话" });
		expect(await h.turnEnd(id, 1, 120_000)).toMatchObject({
			outcome: "model_unavailable",
			error_class: "unreachable",
			reason: "连不上模型端点",
		});
		const retries = notices(h, id).filter((n) => n.kind === "retry");
		expect(retries.length).toBeGreaterThan(0);
		expect(retries[0]).toMatchObject({
			error_class: "unreachable",
			message: expect.stringMatching(
				/^模型暂时不可用（连不上模型端点），正在第 1\/\d 次重试，\d+ 秒后$/,
			),
		});
	}, 120_000);
});

describe("每一类错误：类别、说法和已经做了几步（假 pi，不等重试的间隔）", () => {
	const CASES: Array<[name: string, raw: string, errorClass: ErrorClass, reason: string]> = [
		["401", "aeval API error (401): unauthorized", "auth", "密钥被拒绝（401）"],
		["403", "403 Forbidden", "auth", "密钥被拒绝（403）"],
		["402", "aeval API error (402): insufficient_user_quota", "quota", "额度不足（402）"],
		["429", "429 Too Many Requests", "rate_limit", "被限流（429）"],
		["503", "503 Service Unavailable", "upstream", "模型端点出错（503）"],
		["504", "504 Gateway Timeout", "timeout", "模型端点超时（504）"],
		[
			"连接被拒绝",
			"Connection error.: connect ECONNREFUSED 10.0.0.5:8443",
			"unreachable",
			"连不上模型端点",
		],
		["连接超时", "Connection error.: connect ETIMEDOUT 10.0.0.5:8443", "timeout", "模型端点超时"],
		["请求超时", "Request timed out.", "timeout", "模型端点超时"],
		[
			"上下文超长",
			"aeval API error (400): prompt is too long for the context window",
			"context_overflow",
			"对话太长，模型装不下（400）",
		],
		["别的 400", "aeval API error (400): bad request", "other", "其他错误（400）"],
	];

	it.each(CASES)("%s", async (_name, raw, errorClass, reason) => {
		h = await Harness.start({ piArgv: FAKE_PI });
		const id = crypto.randomUUID();
		await h.prompt(id, { text: `model-error:7:${raw}` });
		expect(await h.turnEnd(id)).toMatchObject({
			outcome: "model_unavailable",
			error_class: errorClass,
			reason,
			steps: 7,
		});
		// 上游的原文（这里是错误里的地址和说法）不在事件里。
		expect(h.events.lines.join("\n")).not.toContain("10.0.0.5");
		expect(h.events.lines.join("\n")).not.toContain("insufficient_user_quota");
	});
});

describe("模型的密钥不外传", () => {
	const KEY = "sk-test-do-not-leak-9f8e7d6c5b4a";

	it("上游把密钥回显在错误里、一轮失败：会话事件、助手服务的日志、/health、接口的回应里都没有它", async () => {
		const env = { PATH: process.env.PATH, FAKE_MODEL_KEY: KEY, SFLY_ASSISTANT_SECRET: SECRET };
		h = await Harness.start({ hostEnv: env });
		const echoed = JSON.stringify({
			error: {
				message: `bad key ${KEY}; Authorization: Bearer ${KEY}; via http://u:${KEY}@gw.internal/v1`,
			},
		});
		h.model.failures = [{ status: 402, body: echoed }];
		const id = crypto.randomUUID();
		const responses: string[] = [];
		const first = await h.prompt(id, { text: "说一句话" });
		responses.push(await first.text());
		const end = await h.turnEnd(id);
		expect(end).toMatchObject({ outcome: "model_unavailable", error_class: "quota" });
		// 再说一句（第 2 轮）：模型端点这次回成功。
		const second = await h.prompt(id, { text: "再说一句", turn: 2 });
		responses.push(await second.text());
		await h.turnEnd(id, 2);
		const health = await fetch(`${h.url}/health`, {
			headers: { authorization: `Bearer ${SECRET}` },
		});
		const healthText = await health.text();
		AssistantHealth.parse(JSON.parse(healthText));
		const everything = [
			h.events.lines.join("\n"),
			h.logs.join("\n"),
			healthText,
			...responses,
			JSON.stringify(h.modelHealth.snapshot()),
		].join("\n");
		expect(everything).not.toContain(KEY);
	}, 90_000);

	it("没有配置时的 503 和 /health 也没有密钥（别的变量缺了、这个变量有值）", async () => {
		const env = {
			PATH: process.env.PATH,
			FAKE_MODEL_KEY: KEY,
			SFLY_ASSISTANT_SECRET: SECRET,
		};
		h = await Harness.start({
			hostEnv: env,
			modelsFile: JSON.stringify({
				providers: {
					fake: {
						baseUrl: "http://127.0.0.1:9/v1",
						api: "openai-completions",
						apiKey: "$FAKE_MODEL_KEY",
						headers: { "X-Org": "$MISSING_ORG" },
						models: [{ id: "fake" }],
					},
				},
			}),
		});
		const res = await h.prompt(crypto.randomUUID(), { text: "说一句话" });
		const health = await fetch(`${h.url}/health`, {
			headers: { authorization: `Bearer ${SECRET}` },
		});
		const text = `${res.status} ${await res.text()} ${await health.text()} ${h.logs.join("\n")}`;
		expect(text).toContain("MISSING_ORG");
		expect(text).not.toContain(KEY);
	});
});
