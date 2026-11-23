// 看管 pi 进程和一轮：用照 RPC 协议说话的假 pi（support/fake-pi.mjs），按 prompt 的文字决定这一轮怎么走。
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectAgent } from "../src/agent.js";
import { EventBus } from "../src/bus.js";
import { SessionManager } from "../src/sessions.js";
import { mirrorSkillsLocally } from "../src/skills.js";
import { eventually } from "./support/eventually.js";
import { silentPort } from "./support/fake-workbench.js";
import { Harness, type HarnessOptions } from "./support/harness.js";

const FAKE_PI = [process.execPath, join(import.meta.dirname, "support", "fake-pi.mjs")];

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const start = async (options: HarnessOptions = {}) => {
	h = await Harness.start({ piArgv: FAKE_PI, ...options });
	return h;
};

/** 这个会话的 pi 原始事件（`events.jsonl`）。 */
const rawEvents = (harness: Harness, id: string): Array<Record<string, unknown>> => {
	const path = join(harness.dataDir, "sessions", id, "events.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
};

describe("拉起 pi", () => {
	it("子进程的环境只有给它的几项：没有共享密钥、没有命令的环境变量、没有助手服务其余的环境", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		expect(
			(
				await harness.prompt(id, {
					text: "settle",
					secret_env: { SFLY_API_TOKEN: "tok-0123456789" },
				})
			).status,
		).toBe(202);
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "completed" });
		const started = rawEvents(harness, id).find((r) => r.type === "fake_env") as {
			env: Record<string, string>;
			argv: string[];
			agentDir: string[];
		};
		expect(started.agentDir).toEqual(["models.json"]);
		// macOS 给每个进程加 __CF_USER_TEXT_ENCODING（不是助手服务给的）。
		const keys = Object.keys(started.env).filter((k) => !k.startsWith("__CF_"));
		expect(keys.sort()).toEqual([
			"FAKE_MODEL_KEY",
			"HOME",
			"PATH",
			"PI_CODING_AGENT_DIR",
			"PI_TELEMETRY",
			"SFLY_ASSISTANT_TURN_CONFIG",
			"TMPDIR",
		]);
		// 临时目录每个进程一个，在数据目录下（一轮结束时清空、进程退出时删掉）。
		expect(started.env.TMPDIR?.startsWith(join(harness.dataDir, "tmp"))).toBe(true);
		expect(started.env.PI_TELEMETRY).toBe("0");
		// 设置目录每次启动新建，里面只有模型文件；进程退出后删掉。
		const agentDir = started.env.PI_CODING_AGENT_DIR as string;
		expect(agentDir.startsWith(join(harness.dataDir, "agents"))).toBe(true);
		expect(started.argv).toEqual(
			expect.arrayContaining([
				"--no-extensions",
				"--no-skills",
				"--no-context-files",
				"--no-prompt-templates",
				// 不传它时 APPEND_SYSTEM.md 可能进系统提示（#539 第 3 题测不出来）：一定要传。
				"--append-system-prompt",
			]),
		);
		expect(started.argv[started.argv.indexOf("--tools") + 1]).toBe("read,bash,edit,write");
		expect(started.argv[started.argv.indexOf("--session-id") + 1]).toBe(id);
		await harness.sessions.shutdown();
		await eventually(() => expect(existsSync(agentDir)).toBe(false));
		// 这一轮的配置（里面有保密的环境变量）在这一轮结束时删掉。
		expect(existsSync(join(harness.dataDir, "sessions", id, "turn.json"))).toBe(false);
	});

	it("先回应 prompt（202），再拉起 pi：拉起失败时这一轮以 failed 结束", async () => {
		const harness = await start({ piArgv: [join(import.meta.dirname, "no-such-pi")] });
		const id = crypto.randomUUID();
		expect((await harness.prompt(id, { text: "settle" })).status).toBe(202);
		const end = await harness.turnEnd(id);
		expect(end.outcome).toMatch(/^(failed|interrupted)$/);
	});

	it("pi 不接受这句话：failed", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "reject" });
		expect(await harness.turnEnd(id)).toMatchObject({
			outcome: "failed",
			reason: expect.stringContaining("不接受"),
		});
	});
});

describe("一轮的结局", () => {
	it("completed：带工具调用次数、模型调用次数、用时和用量", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "settle" });
		expect(await harness.turnEnd(id)).toMatchObject({
			outcome: "completed",
			steps: 0,
			model_calls: 1,
			usage: { input: 10, output: 2, cache_read: 1, cache_write: 0 },
			duration_ms: expect.any(Number),
		});
	});

	it("模型调用到了 40 次：第 41 次之前以 limit（model_calls）结束，进程被结束；会话还能接着说", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "loop" });
		const end = await harness.turnEnd(id);
		expect(end).toMatchObject({ outcome: "limit", limit_kind: "model_calls", model_calls: 40 });
		// 决定结束之后 pi 还在吐的事件不外传。
		const results = harness.events.of(id).filter((r) => r.event.type === "tool_result");
		expect(results.length).toBeLessThanOrEqual(40);
		await eventually(() => expect(harness.sessions.activeProcesses).toBe(0));
		await harness.prompt(id, { turn: 2, text: "settle" });
		expect(await harness.turnEnd(id, 2)).toMatchObject({ outcome: "completed" });
	});

	it("用时到了上限：limit（duration）", async () => {
		const harness = await start({ limits: { modelCalls: 40, durationMs: 300 } });
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "hang" });
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "limit", limit_kind: "duration" });
	});

	it("停止：先关 stdin，再 SIGTERM；都不理会的 pi 宽限期之后被 SIGKILL，这一轮以 stopped 结束", async () => {
		const harness = await start({ killGraceMs: 300 });
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "ignore-term" });
		await eventually(() => expect(harness.sessions.activeProcesses).toBe(1));
		await eventually(() =>
			expect(rawEvents(harness, id).some((r) => r.type === "turn_start")).toBe(true),
		);
		expect((await harness.abort(id)).status).toBe(202);
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "stopped" });
		// 两样都收到了（子进程里哪个先处理不一定）。events.jsonl 在进程退出后才写完，等它写完再看。
		await eventually(() => {
			const order = rawEvents(harness, id)
				.map((r) => r.type)
				.filter((t) => t === "fake_stdin_closed" || t === "fake_ignored_sigterm");
			expect(order.sort()).toEqual(["fake_ignored_sigterm", "fake_stdin_closed"]);
		});
		expect(harness.sessions.activeProcesses).toBe(0);
	});

	it("停止时 pi 收到 SIGTERM 以 143 退出：照样是 stopped，不当成出错", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "term-143" });
		await eventually(() =>
			expect(rawEvents(harness, id).some((r) => r.type === "turn_start")).toBe(true),
		);
		await harness.abort(id);
		const end = await harness.turnEnd(id);
		expect(end).toMatchObject({ outcome: "stopped", reason: "用户停止了这一轮" });
		expect(end.error_class).toBeUndefined();
		await eventually(() =>
			expect(rawEvents(harness, id).some((r) => r.type === "fake_exit_143")).toBe(true),
		);
	});

	it("pi 进程在一轮中途退出：interrupted，带退出码", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "exit" });
		expect(await harness.turnEnd(id)).toMatchObject({
			outcome: "interrupted",
			reason: expect.stringContaining("退出码 7"),
		});
	});

	it("模型出错、重试用尽：model_unavailable，error_class 先写 other；重试有提示", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "error" });
		expect(await harness.turnEnd(id)).toMatchObject({
			outcome: "model_unavailable",
			error_class: "other",
		});
		const notices = harness.events
			.of(id)
			.flatMap((r) => (r.event.type === "notice" ? [r.event] : []));
		expect(notices.map((n) => n.kind)).toEqual(["retry", "retry_end"]);
		expect(notices[0]).toMatchObject({ attempt: 1, max_attempts: 1, retry_delay_ms: 10 });
	});

	it("一轮在做时再开始一轮：409 turn_running", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "hang" });
		const res = await harness.prompt(id, { turn: 2, text: "settle" });
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: "turn_running" });
		await harness.abort(id);
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "stopped" });
	});
});

describe("同时活着的 pi 进程数的上限", () => {
	it("满了、都在做：503 process_limit；在做的那一轮的进程不关 stdin", async () => {
		const harness = await start({ maxProcesses: 1 });
		const a = crypto.randomUUID();
		await harness.prompt(a, { text: "hang" });
		await eventually(() =>
			expect(rawEvents(harness, a).some((r) => r.type === "turn_start")).toBe(true),
		);
		const res = await harness.prompt(crypto.randomUUID(), { text: "settle" });
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({ code: "process_limit" });
		expect(rawEvents(harness, a).some((r) => r.type === "fake_stdin_closed")).toBe(false);
		expect(harness.sessions.activeProcesses).toBe(1);
	});

	it("满了、有空闲的：关掉最久没用的空闲进程（关 stdin），新会话照常开始", async () => {
		const harness = await start({ maxProcesses: 1 });
		const a = crypto.randomUUID();
		await harness.prompt(a, { text: "settle" });
		await harness.turnEnd(a);
		const b = crypto.randomUUID();
		expect((await harness.prompt(b, { text: "settle" })).status).toBe(202);
		expect(await harness.turnEnd(b)).toMatchObject({ outcome: "completed" });
		await eventually(() =>
			expect(rawEvents(harness, a).some((r) => r.type === "fake_stdin_closed")).toBe(true),
		);
	});
});

describe("保密环境变量按值打码", () => {
	it("模型的话、工具的输出和结果、提示里出现的值（含跨两条增量、JSON 转义的）：事件、pi 原始事件、日志里都没有", async () => {
		const harness = await start();
		const value = 'tok-"9f3a\\b7c1-secret-value';
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: `secret:${value}`, secret_env: { SFLY_API_TOKEN: value } });
		await harness.turnEnd(id);
		const jsonForm = JSON.stringify(value).slice(1, -1);
		for (const text of [
			harness.events.lines.join("\n"),
			readFileSync(join(harness.dataDir, "sessions", id, "events.jsonl"), "utf8"),
			harness.logs.join("\n"),
		]) {
			expect(text).not.toContain(value);
			expect(text).not.toContain(jsonForm);
		}
		const events = harness.events.of(id).map((r) => r.event);
		const deltas = events.flatMap((e) => (e.type === "assistant_delta" ? [e.text] : [])).join("");
		expect(deltas).toBe("令牌是 ****** 。");
		const output = events.flatMap((e) => (e.type === "tool_output" ? [e.text] : [])).join("");
		expect(output).toContain("TOKEN=******");
		expect(events.find((e) => e.type === "tool_call")).toMatchObject({ title: "echo ******" });
		expect(events.find((e) => e.type === "notice")).toMatchObject({
			message: expect.stringContaining("******"),
		});
	});
});

describe("中止比这一轮先到（控制面等 prompt 的回应超时后补发的中止）", () => {
	const piStarted = (harness: Harness, id: string) =>
		rawEvents(harness, id).some((r) => r.type === "fake_env");

	it("没有在做的一轮时收到中止：记下来，紧接着到的那一轮直接以 stopped 结束，不拉起 pi", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		expect((await harness.abort(id)).status).toBe(202);
		expect((await harness.prompt(id, { text: "hang" })).status).toBe(202);
		expect(await harness.turnEnd(id)).toMatchObject({
			outcome: "stopped",
			steps: 0,
			model_calls: 0,
		});
		expect(piStarted(harness, id)).toBe(false);
		expect(harness.sessions.activeProcesses).toBe(0);
		// 只作用于一轮：下一轮照常。
		await harness.prompt(id, { turn: 2, text: "settle" });
		expect(await harness.turnEnd(id, 2)).toMatchObject({ outcome: "completed" });
	});

	it("中止之后、知道最近一轮时：只作用于紧接着的那一轮（那一轮没到，下一次是新的轮次，照常做）", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "settle" });
		await harness.turnEnd(id);
		await harness.abort(id);
		// 第 2 轮没到（丢了），控制面记了失败，用户再说的是第 3 轮。
		await harness.prompt(id, { turn: 3, text: "settle" });
		expect(await harness.turnEnd(id, 3)).toMatchObject({ outcome: "completed" });
	});

	it("中止之后过了时间窗才到的一轮照常做；一轮结束之后的重复中止不影响下一轮", async () => {
		const harness = await start({ earlyAbortWindowMs: 50 });
		const id = crypto.randomUUID();
		await harness.abort(id);
		await new Promise((resolve) => setTimeout(resolve, 100));
		await harness.prompt(id, { text: "settle" });
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "completed" });
	});
});

describe("看管进程的边界", () => {
	it("pi 的标准错误写进 pi-stderr.log 之前也打码（值跨两块写也认得出）", async () => {
		const harness = await start();
		const value = "stderr-secret-0123456789";
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: `stderr:${value}`, secret_env: { SFLY_API_TOKEN: value } });
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "completed" });
		await harness.sessions.shutdown();
		// 最后留着的那一段在进程退出时才写下：等文件写完再看。
		const path = join(harness.dataDir, "sessions", id, "pi-stderr.log");
		await eventually(() =>
			expect(readFileSync(path, "utf8")).toContain("warning: token ****** rejected"),
		);
		expect(readFileSync(path, "utf8")).not.toContain(value);
	});

	it("换了工作区：空闲的旧进程关掉重起，旧进程退出不结束新的一轮", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "settle" });
		await harness.turnEnd(id);
		const other = join(harness.root, "workbench", "other");
		mkdirSync(other, { recursive: true });
		await harness.prompt(id, {
			turn: 2,
			text: "hang",
			workbench: { name: "fake-workbench", address: harness.workbench.address, workdir: other },
		});
		await eventually(() =>
			expect(rawEvents(harness, id).some((r) => r.type === "fake_stdin_closed")).toBe(true),
		);
		await eventually(() =>
			expect(rawEvents(harness, id).filter((r) => r.type === "turn_start")).toHaveLength(2),
		);
		// 旧进程已经退出：新的一轮还在做，没有被记成 interrupted。
		expect(harness.events.of(id).filter((r) => r.event.type === "turn_end")).toHaveLength(1);
		const started = rawEvents(harness, id).filter((r) => r.type === "fake_env") as Array<{
			argv: string[];
		}>;
		expect(started).toHaveLength(2);
		await harness.abort(id);
		expect(await harness.turnEnd(id, 2)).toMatchObject({ outcome: "stopped" });
	});

	it("写不了这一轮的配置：503 start_failed，会话没有卡在「这一轮在做」", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		const turnConfig = join(harness.dataDir, "sessions", id, "turn.json");
		mkdirSync(join(turnConfig, "blocked"), { recursive: true });
		const res = await harness.prompt(id, { text: "settle" });
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({ code: "start_failed" });
		rmSync(turnConfig, { recursive: true, force: true });
		expect((await harness.prompt(id, { text: "settle" })).status).toBe(202);
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "completed" });
	});
});

/** 一个起得很慢的假 pi：先等 `seconds` 秒再起来。 */
const slowPi = (harness: { root: string } | string, seconds: number): string[] => {
	const dir = typeof harness === "string" ? harness : harness.root;
	const path = join(dir, `slow-pi-${seconds}.sh`);
	writeFileSync(
		path,
		`#!/bin/sh\nsleep ${seconds}\nexec ${FAKE_PI.map((a) => JSON.stringify(a)).join(" ")} "$@"\n`,
		{
			mode: 0o755,
		},
	);
	return [path];
};

describe("审查补的守护", () => {
	it("先回应 prompt（202），再拉起 pi：pi 起得很慢时 202 照样马上回来", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sfly-slowpi-"));
		const harness = await start({ piArgv: slowPi(dir, 3) });
		const id = crypto.randomUUID();
		const sent = Date.now();
		expect((await harness.prompt(id, { text: "settle" })).status).toBe(202);
		expect(Date.now() - sent).toBeLessThan(1_000);
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "completed" });
		rmSync(dir, { recursive: true, force: true });
	});

	it("进程数的上限算上正在起的：上限 1，一个还在起时另一个会话 503", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sfly-slowpi-"));
		const harness = await start({ piArgv: slowPi(dir, 2), maxProcesses: 1 });
		expect((await harness.prompt(crypto.randomUUID(), { text: "settle" })).status).toBe(202);
		const second = await harness.prompt(crypto.randomUUID(), { text: "settle" });
		expect(second.status).toBe(503);
		expect(await second.json()).toMatchObject({ code: "process_limit" });
		rmSync(dir, { recursive: true, force: true });
	});

	it("进程数的上限算上正在关的：被回收的空闲进程退出之前，它的位置还占着", async () => {
		const harness = await start({ maxProcesses: 2 });
		const a = crypto.randomUUID();
		await harness.prompt(a, { text: "settle-slow-close" });
		await harness.turnEnd(a);
		const b = crypto.randomUUID();
		await harness.prompt(b, { text: "hang" });
		// 满了：c 回收空闲的 a（关 stdin，a 要 2 秒才退出），c 照常开始。
		const c = crypto.randomUUID();
		expect((await harness.prompt(c, { text: "hang" })).status).toBe(202);
		// b 结束、退出了：活着的只有 c，但 a 还没退出，它的位置还占着。
		await harness.abort(b);
		await harness.turnEnd(b);
		expect(rawEvents(harness, a).some((r) => r.type === "fake_exiting")).toBe(false);
		const d = await harness.prompt(crypto.randomUUID(), { text: "settle" });
		expect(d.status).toBe(503);
		// a 退出之后就有位置了。
		await eventually(() =>
			expect(rawEvents(harness, a).some((r) => r.type === "fake_exiting")).toBe(true),
		);
		await eventually(() => expect(harness.sessions.activeProcesses).toBe(1));
		expect((await harness.prompt(crypto.randomUUID(), { text: "settle" })).status).toBe(202);
		await harness.abort(c);
	});

	it("同一个会话不同时有两个 pi：换了工作区时，旧进程退出之后才起新的；设置目录每次新建", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "settle-slow-close" });
		await harness.turnEnd(id);
		const other = join(harness.root, "workbench", "other");
		mkdirSync(other, { recursive: true });
		await harness.prompt(id, {
			turn: 2,
			text: "settle",
			workbench: { name: "fake-workbench", address: harness.workbench.address, workdir: other },
		});
		expect(await harness.turnEnd(id, 2)).toMatchObject({ outcome: "completed" });
		const raw = rawEvents(harness, id);
		const exiting = raw.find((r) => r.type === "fake_exiting") as { t: number };
		const starts = raw.filter((r) => r.type === "fake_env") as Array<{
			t: number;
			env: Record<string, string>;
		}>;
		expect(starts).toHaveLength(2);
		expect(starts[1]?.t).toBeGreaterThanOrEqual(exiting.t);
		expect(starts[1]?.env.PI_CODING_AGENT_DIR).not.toBe(starts[0]?.env.PI_CODING_AGENT_DIR);
		expect(starts[1]?.env.TMPDIR).not.toBe(starts[0]?.env.TMPDIR);
	});

	it("决定结束这一轮之后，pi 还在吐的事件不外传", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "chatty-term" });
		await eventually(() =>
			expect(rawEvents(harness, id).some((r) => r.type === "turn_start")).toBe(true),
		);
		await harness.abort(id);
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "stopped" });
		// pi 确实吐了（原始事件里有），但没有发出去。
		await eventually(() =>
			expect(rawEvents(harness, id).some((r) => r.toolCallId === "late")).toBe(true),
		);
		const events = harness.events.of(id).map((r) => r.event);
		expect(events.some((e) => e.type === "tool_call")).toBe(false);
		expect(events.some((e) => e.type === "assistant_message")).toBe(false);
	});

	it("最后一条助手消息出错（没有重试）：model_unavailable", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "error-once" });
		expect(await harness.turnEnd(id)).toMatchObject({
			outcome: "model_unavailable",
			error_class: "other",
			reason: expect.stringContaining("401 unauthorized"),
		});
	});

	it("工具结果里的 NUL、不成对的代理字符：发出之前换成看得见的占位（控制面存得进去）", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "nul" });
		await harness.turnEnd(id);
		const line = harness.events.lines.find((l) => l.includes('"tool_result"')) as string;
		expect(line).not.toMatch(/\\u0000|\\ud800/i);
		const result = harness.events.of(id).find((r) => r.event.type === "tool_result");
		expect(result?.event).toMatchObject({ text: "a␀b\ufffdc" });
	});

	it("工作台接了连接却不回话：这一轮开头写 skill 时在期限内以「工作台连不上」失败，不等到用时上限", async () => {
		const port = await silentPort();
		try {
			const harness = await start({
				agentDeadlines: { replySlackMs: 200, fileDeadlineMs: 300, probeDeadlineMs: 300 },
			});
			const id = crypto.randomUUID();
			await harness.prompt(id, {
				text: "settle",
				workbench: { name: "silent", address: port.address, workdir: harness.workdir },
			});
			const end = await harness.turnEnd(id, 1, 40_000);
			expect(end).toMatchObject({ outcome: "failed" });
			expect(end.reason).toContain("工作台连不上");
		} finally {
			await port.close();
		}
	}, 60_000);

	it("工作台上没有工作区目录：一轮开始时建好", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		const missing = join(harness.root, "workbench", "not-yet");
		await harness.prompt(id, {
			text: "settle",
			workbench: { name: "fake-workbench", address: harness.workbench.address, workdir: missing },
		});
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "completed" });
		expect(existsSync(join(missing, ".agents", "skills"))).toBe(true);
	});
});

describe("启动时清掉上次留下的东西", () => {
	it("设置目录、每一轮的配置文件（有保密值的原文）、pi 的临时目录", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "sfly-leftover-"));
		const session = join(dataDir, "sessions", crypto.randomUUID());
		mkdirSync(session, { recursive: true });
		writeFileSync(join(session, "turn.json"), "{}");
		writeFileSync(join(session, "events.jsonl"), "");
		mkdirSync(join(dataDir, "agents", "old"), { recursive: true });
		mkdirSync(join(dataDir, "tmp", "old"), { recursive: true });
		new SessionManager({
			dataDir,
			modelsFile: "/nonexistent",
			model: undefined,
			piArgv: FAKE_PI,
			extension: "/nonexistent",
			skillsDir: "/nonexistent",
			hostEnv: {},
			bus: new EventBus(),
			connect: connectAgent,
			log: () => {},
		});
		expect(existsSync(join(session, "turn.json"))).toBe(false);
		expect(existsSync(join(session, "events.jsonl"))).toBe(true);
		expect(existsSync(join(dataDir, "agents"))).toBe(false);
		expect(existsSync(join(dataDir, "tmp"))).toBe(false);
		rmSync(dataDir, { recursive: true, force: true });
	});
});

describe("事件流", () => {
	it("持久的事件带纪元内递增的序号，不持久的不带；每条带会话、轮次和产生的时间", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { turn: 3, text: "settle" });
		await harness.turnEnd(id, 3);
		const records = harness.events.of(id);
		expect(records.every((r) => r.turn === 3 && r.epoch === harness.events.hello?.epoch)).toBe(
			true,
		);
		const seqs = records.flatMap((r) => (r.seq === undefined ? [] : [r.seq]));
		expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
		expect(records.find((r) => r.event.type === "assistant_message")?.seq).toBeDefined();
	});

	it("扩展、skill 目录照镜像的内容；会话目录里有 events.jsonl 和 pi-stderr.log", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "settle" });
		await harness.turnEnd(id);
		expect(readdirSync(join(harness.dataDir, "sessions", id)).sort()).toEqual(
			expect.arrayContaining(["context.md", "events.jsonl", "pi-stderr.log"]),
		);
	});
});

describe("助手容器里放 skill 的目录（所有会话共用）", () => {
	it("内容已经一样时不动；不一样时换上镜像里的那份，不留镜像之外的东西，也不留中间目录", async () => {
		const root = mkdtempSync(join(tmpdir(), "sfly-skills-"));
		try {
			const image = join(root, "image");
			mkdirSync(join(image, "a"), { recursive: true });
			writeFileSync(join(image, "a", "SKILL.md"), "A\n");
			const workdir = join(root, "work");
			const target = mirrorSkillsLocally(image, workdir);
			const first = statSync(join(target, "a", "SKILL.md")).ino;
			mirrorSkillsLocally(image, workdir);
			expect(statSync(join(target, "a", "SKILL.md")).ino).toBe(first);
			writeFileSync(join(target, "stale.md"), "x");
			mirrorSkillsLocally(image, workdir);
			expect(readdirSync(target).sort()).toEqual(["a"]);
			expect(readdirSync(join(workdir, ".agents")).sort()).toEqual(["skills"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
