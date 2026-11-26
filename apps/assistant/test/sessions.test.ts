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
import { Code } from "@connectrpc/connect";
import type { PromptCommandBody } from "@sfly/schema";
import { afterEach, describe, expect, it } from "vitest";
import { connectAgent } from "../src/agent.js";
import { EventBus } from "../src/bus.js";
import { ABORT_MARK_LIMIT, ABORT_MARK_TTL_MS, SessionManager } from "../src/sessions.js";
import { mirrorSkillsLocally } from "../src/skills.js";
import { eventually } from "./support/eventually.js";
import { failingConnection, silentPort, systemError } from "./support/fake-workbench.js";
import { Harness, type HarnessOptions, SECRET } from "./support/harness.js";

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

/** 直接交给 SessionManager 的第 1 轮（不经 HTTP）。 */
const promptBody = (harness: Harness, text: string): PromptCommandBody => ({
	turn: 1,
	message_id: crypto.randomUUID(),
	text,
	session: { title: "测试", created_by: "tester" },
	workbench: {
		name: "fake-workbench",
		address: harness.workbench.address,
		workdir: harness.workdir,
	},
	env: {},
	secret_env: {},
});

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
		// 临时目录每个进程一个，在临时目录的根下（不在数据卷上；一轮结束时清空、进程退出时删掉）。
		const tmpDir = started.env.TMPDIR as string;
		expect(tmpDir.startsWith(join(harness.root, "tmp"))).toBe(true);
		expect(tmpDir.startsWith(harness.dataDir)).toBe(false);
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
		await eventually(() => expect(existsSync(tmpDir)).toBe(false));
		// 这一轮的配置（里面有 secret 环境变量）在这一轮结束时删掉。
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
	it("一轮开头写 skill 用的工作台连接用完就关；写不成时也关", async () => {
		// 写文件的期限放宽：机器忙的时候 300 毫秒写不完镜像里的 skill（不回话的端口卡在 mkdir 那一步，用不上它）。
		const harness = await start({
			agentDeadlines: { replySlackMs: 200, fileDeadlineMs: 3_000, probeDeadlineMs: 300 },
		});
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "settle" });
		const first = await harness.turnEnd(id);
		expect(first, first.reason).toMatchObject({ outcome: "completed" });
		// 三个：写 skill、一轮开始前整理工作区、一轮结束时提交（#546），各自用完就关。
		expect(harness.connections).toEqual({ opened: 3, closed: 3 });
		// 不只数 close() 被调用的次数：假工作台上的连接真的关了（#618 审查）。
		await eventually(() => expect(harness.workbench.openConnections).toBe(0));
		const port = await silentPort();
		try {
			const other = crypto.randomUUID();
			await harness.prompt(other, {
				text: "settle",
				workbench: { name: "silent", address: port.address, workdir: harness.workdir },
			});
			expect(await harness.turnEnd(other, 1, 40_000)).toMatchObject({ outcome: "failed" });
			// 写 skill 就失败了：这一轮没有开始（没有整理工作区，也没有提交）。
			expect(harness.connections).toEqual({ opened: 4, closed: 4 });
		} finally {
			await port.close();
		}
	}, 60_000);

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

	it("模型调用到了 40 次：第 41 次之前以 limit（model_calls）结束，走停止的那条路（clear_queue、abort），进程留着，下一轮接着用", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "loop" });
		const end = await harness.turnEnd(id);
		expect(end).toMatchObject({ outcome: "limit", limit_kind: "model_calls", model_calls: 40 });
		// 决定结束之后 pi 还在吐的事件不外传。
		const results = harness.events.of(id).filter((r) => r.event.type === "tool_result");
		expect(results.length).toBeLessThanOrEqual(40);
		const raw = rawEvents(harness, id).map((r) => r.type);
		expect(raw).toContain("fake_clear_queue");
		expect(raw.indexOf("fake_clear_queue")).toBeLessThan(raw.indexOf("fake_abort"));
		const pid = harness.sessions.pid(id);
		expect(pid).toBeDefined();
		await harness.prompt(id, { turn: 2, text: "settle" });
		expect(await harness.turnEnd(id, 2)).toMatchObject({ outcome: "completed" });
		expect(harness.sessions.pid(id)).toBe(pid);
	});

	it("用时到了上限：limit（duration）", async () => {
		const harness = await start({ limits: { modelCalls: 40, durationMs: 300 } });
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "hang" });
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "limit", limit_kind: "duration" });
	});

	it("停止：pi 不理 abort 时等满之后结束进程，先关 stdin，再 SIGTERM；都不理会的 pi 宽限期之后被 SIGKILL，这一轮以 stopped 结束", async () => {
		const harness = await start({ killGraceMs: 300, abortSettleMs: 300 });
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
		const harness = await start({ abortSettleMs: 300 });
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

	it("模型出错、重试用尽：model_unavailable，原因和 error_class 是助手服务自己的说法；重试有提示", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "error" });
		expect(await harness.turnEnd(id)).toMatchObject({
			outcome: "model_unavailable",
			// 不带「模型不可用」：页面按结局加这个前缀（#640）。
			reason: "上游出错（上游返回 503）",
			error_class: "upstream",
		});
		const notices = harness.events
			.of(id)
			.flatMap((r) => (r.event.type === "notice" ? [r.event] : []));
		expect(notices.map((n) => n.kind)).toEqual(["retry", "retry_end"]);
		expect(notices[0]).toMatchObject({ attempt: 1, max_attempts: 1, retry_delay_ms: 10 });
		// 两次模型调用失败，各记一次；重试的提示、重试用尽带的是同一段原文，不再记。
		expect(harness.logs.filter((line) => line.endsWith("上游模型出错：503 upstream"))).toHaveLength(
			2,
		);
	});

	it("压缩上下文失败：原文打码后记进日志，不进事件", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "compact-fail" });
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "completed" });
		expect(harness.logs.join("\n")).toContain(
			"压缩上下文失败：Auto-compaction failed: 401: Authorization: ******",
		);
		expect(harness.logs.join("\n")).not.toContain("sk-compact-1");
		expect(JSON.stringify(harness.events.of(id))).not.toContain("Auto-compaction");
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

describe("secret 环境变量按值打码", () => {
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
		// 上游的错误原文（里面有这个值）不进提示，只进日志，进日志之前打码（#640）：secret 环境变量的值、模型文件引用的环境变量的值、
		// 请求头和地址里的凭据都打码，截到上限；同一次失败（模型调用出错，接着是重试的提示）只记一次。
		expect(events.find((e) => e.type === "notice")?.type).toBe("notice");
		expect(JSON.stringify(events)).not.toContain("bad key");
		const logged = harness.logs.filter((line) => line.includes("上游模型出错："));
		expect(logged).toHaveLength(1);
		expect(logged[0]).toContain(
			"上游模型出错：bad key ****** (******) Authorization: ******\nvia https://******@proxy.example/ xxx",
		);
		for (const part of ["fake-key", "sk-shape-123", "pw-shape"])
			expect(logged[0]).not.toContain(part);
		expect(logged[0]).toMatch(/x…（后面截掉了 \d+ 个字符）$/);
	});
});

describe("中止带轮次：按这一轮的状态，不按时间猜", () => {
	const piStarted = (harness: Harness, id: string) =>
		rawEvents(harness, id).some((r) => r.type === "fake_env");

	it("空闲时收到针对上一轮的中止（用户在空闲的会话上点了停止）：记号提到 1，紧接着来的下一轮照常做", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "settle" });
		await harness.turnEnd(id);
		expect((await harness.abort(id, 1)).status).toBe(202);
		expect(harness.sessions.abortMarks).toBe(1);
		await harness.prompt(id, { turn: 2, text: "settle" });
		expect(await harness.turnEnd(id, 2)).toMatchObject({ outcome: "completed" });
	});

	it("针对还没到的那一轮的中止先到：那一轮到了先回 202、再以 stopped 结束，不拉起 pi；下一轮照常", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		expect((await harness.abort(id, 1)).status).toBe(202);
		expect((await harness.prompt(id, { text: "hang" })).status).toBe(202);
		expect(await harness.turnEnd(id)).toMatchObject({
			outcome: "stopped",
			steps: 0,
			model_calls: 0,
		});
		expect(piStarted(harness, id)).toBe(false);
		expect(harness.sessions.activeProcesses).toBe(0);
		await harness.prompt(id, { turn: 2, text: "settle" });
		expect(await harness.turnEnd(id, 2)).toMatchObject({ outcome: "completed" });
	});

	it("在做时收到针对别的轮次的中止：这一轮不受影响；针对它的中止才结束它；重复的中止不出错", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "settle" });
		await harness.turnEnd(id);
		await harness.prompt(id, { turn: 2, text: "hang" });
		await eventually(() =>
			expect(rawEvents(harness, id).filter((r) => r.type === "turn_start")).toHaveLength(2),
		);
		expect((await harness.abort(id, 1)).status).toBe(202);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(harness.events.of(id).filter((r) => r.event.type === "turn_end")).toHaveLength(1);
		for (let i = 0; i < 3; i += 1) expect((await harness.abort(id, 2)).status).toBe(202);
		expect(await harness.turnEnd(id, 2)).toMatchObject({ outcome: "stopped" });
		expect((await harness.abort(id, 2)).status).toBe(202);
		expect(harness.events.of(id).filter((r) => r.event.type === "turn_end")).toHaveLength(2);
	});

	it("第 1 轮还在做，收到带第 2 轮的中止（回过 409 之后控制面的轮次已经加了一）：第 1 轮被结束，第 2 轮的记号也在", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "hang" });
		await eventually(() =>
			expect(rawEvents(harness, id).filter((r) => r.type === "turn_start")).toHaveLength(1),
		);
		expect((await harness.abort(id, 2)).status).toBe(202);
		expect(await harness.turnEnd(id, 1)).toMatchObject({ outcome: "stopped" });
		expect(harness.sessions.abortMarks).toBe(1);
		expect((await harness.prompt(id, { turn: 2, text: "settle" })).status).toBe(202);
		expect(await harness.turnEnd(id, 2)).toMatchObject({ outcome: "stopped", model_calls: 0 });
		// 收到 prompt 不清掉记号。
		expect(harness.sessions.abortMarks).toBe(1);
		await harness.prompt(id, { turn: 3, text: "settle" });
		expect(await harness.turnEnd(id, 3)).toMatchObject({ outcome: "completed" });
	});

	it("助手服务重启后（不知道这个会话的轮次）收到中止：记号提到 4，轮次不大于它的都以 stopped 结束、不起 pi，更大的照常做；记号不因 prompt 清掉", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.abort(id, 4);
		expect(harness.sessions.abortMarks).toBe(1);
		await harness.prompt(id, { turn: 3, text: "settle" });
		expect(await harness.turnEnd(id, 3)).toMatchObject({ outcome: "stopped", model_calls: 0 });
		expect(piStarted(harness, id)).toBe(false);
		await harness.prompt(id, { turn: 5, text: "settle" });
		expect(await harness.turnEnd(id, 5)).toMatchObject({ outcome: "completed" });
		expect(harness.sessions.abortMarks).toBe(1);
		// 晚到的第 4 轮（控制面已经放弃了它）：在任何先后下都不再跑。
		await harness.prompt(id, { turn: 4, text: "settle" });
		expect(await harness.turnEnd(id, 4)).toMatchObject({ outcome: "stopped", model_calls: 0 });
	});

	it("记号有上限：针对还没到的轮次的中止再多，留着的记号也不超过上限（满了丢最早的）", async () => {
		const harness = await start();
		const first = crypto.randomUUID();
		await harness.abort(first, 1);
		for (let i = 0; i < ABORT_MARK_LIMIT; i += 1) harness.sessions.abort(crypto.randomUUID(), 1);
		expect(harness.sessions.abortMarks).toBe(ABORT_MARK_LIMIT);
		// 最早的那个被丢掉了：它的第 1 轮照常做。
		await harness.prompt(first, { text: "settle" });
		expect(await harness.turnEnd(first)).toMatchObject({ outcome: "completed" });
	});

	it("中止的请求体要有轮次：没有、不是 JSON、轮次不合法时 400，不记记号", async () => {
		const harness = await start();
		const send = (body?: string) =>
			fetch(`${harness.url}/sessions/${crypto.randomUUID()}/abort`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${SECRET}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				body,
			});
		for (const body of [undefined, "{}", '{"turn":0}', '{"turn":"1"}', '{"turn":1.5}']) {
			expect((await send(body)).status, String(body)).toBe(400);
		}
		expect(harness.sessions.abortMarks).toBe(0);
		expect((await send('{"turn":1}')).status).toBe(202);
	});

	it("撞上记号：先回 202，这一轮的结局在回应之后才发", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		harness.sessions.abort(id, 1);
		const lines: string[] = [];
		const unsubscribe = harness.bus.subscribe((line) => lines.push(line));
		try {
			// prompt 同步返回（服务器据此回 202）的那一刻，结局还没有发出去。
			const result = harness.sessions.prompt(id, promptBody(harness, "settle"));
			expect(result).toEqual({ ok: true });
			expect(lines.filter((l) => l.includes('"turn_end"'))).toEqual([]);
		} finally {
			unsubscribe();
		}
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "stopped" });
	});

	it("记号十分钟过期：过期之后这一轮照常做", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		const realNow = Date.now;
		try {
			// 记号是十分钟多以前记下的：只在这一次同步调用里把时间往前拨（不经 HTTP：fetch 自己也用 Date.now）。
			Date.now = () => realNow() - ABORT_MARK_TTL_MS - 1_000;
			harness.sessions.abort(id, 1);
		} finally {
			Date.now = realNow;
		}
		expect(harness.sessions.abortMarks).toBe(1);
		expect((await harness.prompt(id, { text: "settle" })).status).toBe(202);
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "completed" });
		expect(harness.sessions.abortMarks).toBe(0);
	});

	it("记号只增不减：先中止第 5 轮、再中止第 3 轮，记号还是 5：第 3 轮、第 5 轮到了都以 stopped 结束，第 6 轮照常（#618 固定的旧行为跟着协议改）", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.abort(id, 5);
		await harness.abort(id, 3);
		expect(harness.sessions.abortMarks).toBe(1);
		await harness.prompt(id, { turn: 3, text: "settle" });
		expect(await harness.turnEnd(id, 3)).toMatchObject({ outcome: "stopped", model_calls: 0 });
		await harness.prompt(id, { turn: 5, text: "settle" });
		expect(await harness.turnEnd(id, 5)).toMatchObject({ outcome: "stopped", model_calls: 0 });
		await harness.prompt(id, { turn: 6, text: "settle" });
		expect(await harness.turnEnd(id, 6)).toMatchObject({ outcome: "completed" });
	});

	it("撞上记号时更早的一轮还在退出：仍回 202、这一轮以 stopped 结束，更早的那一轮退出后也有结局", async () => {
		const harness = await start({ killGraceMs: 1_500, abortSettleMs: 300 });
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "ignore-term" });
		await eventually(() =>
			expect(rawEvents(harness, id).some((r) => r.type === "turn_start")).toBe(true),
		);
		// 停第 1 轮：pi 不理 SIGTERM，要等宽限到了才退出。这时控制面已经把轮次加了一、补发第 2 轮的中止。
		expect((await harness.abort(id, 1)).status).toBe(202);
		expect((await harness.abort(id, 2)).status).toBe(202);
		const res = await harness.prompt(id, { turn: 2, text: "settle" });
		expect(res.status, await res.clone().text()).toBe(202);
		expect(await harness.turnEnd(id, 2)).toMatchObject({ outcome: "stopped", model_calls: 0 });
		// 第 1 轮还在退出：直接结束的第 2 轮不动它的配置文件（它的 pi 还活着）。
		expect(existsSync(join(harness.dataDir, "sessions", id, "turn.json"))).toBe(true);
		expect(await harness.turnEnd(id, 1)).toMatchObject({ outcome: "stopped" });
		expect(existsSync(join(harness.dataDir, "sessions", id, "turn.json"))).toBe(false);
		await eventually(() => expect(harness.sessions.activeProcesses).toBe(0));
		// 之后照常：第 3 轮起新的 pi、做完。
		await harness.prompt(id, { turn: 3, text: "settle" });
		expect(await harness.turnEnd(id, 3)).toMatchObject({ outcome: "completed" });
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
		await harness.abort(id, 2);
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
		const harness = await start({ abortSettleMs: 300 });
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
		const end = await harness.turnEnd(id);
		expect(end).toMatchObject({
			outcome: "model_unavailable",
			error_class: "auth",
			reason: "上游拒绝了密钥（上游返回 401）",
		});
		expect(harness.logs.join("\n")).toContain("上游模型出错：401 unauthorized");
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
			// 给人看的原因里写工作台的名字，没有它的地址（#640）；地址在日志里。
			expect(end.reason).toContain("往工作台 silent 上写 skill 失败");
			expect(end.reason).not.toContain(port.address);
			expect(end.reason).not.toContain("127.0.0.1");
			expect(harness.logs.join("\n")).toContain(port.address);
		} finally {
			await port.close();
		}
	}, 60_000);

	it("一轮开头写 skill 时工作台主机不可达：原因里有工作台的名字，没有两端的地址和连接层的原文，原文进日志", async () => {
		const remote = "10.9.8.7:50052";
		const harness = await start({
			agentDeadlines: {
				probeDeadlineMs: 300,
				http2: {
					createConnection: failingConnection(
						systemError("EHOSTUNREACH", remote, "10.1.2.3:53118"),
					),
				},
			},
		});
		const id = crypto.randomUUID();
		await harness.prompt(id, {
			text: "settle",
			workbench: { name: "dev-root-dev", address: remote, workdir: harness.workdir },
		});
		const end = await harness.turnEnd(id);
		expect(end).toMatchObject({
			outcome: "failed",
			reason:
				"开始这一轮失败：往工作台 dev-root-dev 上写 skill 失败：工作台连不上：连接断了，之后也探不通",
		});
		const events = JSON.stringify(harness.events.of(id));
		for (const part of ["10.9.8.7", "10.1.2.3", "EHOSTUNREACH"]) expect(events).not.toContain(part);
		expect(harness.logs.join("\n")).toContain(
			`connect EHOSTUNREACH ${remote} - Local (10.1.2.3:53118)`,
		);
	});

	it("一轮开头写 skill 时出了不是工作台连接上的错误：原因里不放行它的原文，原文进日志", async () => {
		const harness = await start({
			wrapAgent: (client) => ({
				...client,
				writeFile: async () => {
					throw new Error("MARKER-local-31 at 10.9.8.7");
				},
			}),
		});
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "settle" });
		expect(await harness.turnEnd(id)).toMatchObject({
			outcome: "failed",
			reason:
				"开始这一轮失败：往工作台 fake-workbench 上写 skill 失败：助手服务内部出错（原文记在日志里）",
		});
		expect(JSON.stringify(harness.events.of(id))).not.toContain("MARKER");
		expect(harness.logs.join("\n")).toContain("MARKER-local-31");
	});

	it("一轮开头写 skill 之外的步骤出错（这里是读不到模型文件）：原因不放行本机的原文，原文进日志", async () => {
		const harness = await start();
		const models = join(harness.root, "config", "models.json");
		rmSync(models);
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "settle" });
		expect(await harness.turnEnd(id)).toMatchObject({
			outcome: "failed",
			reason: "开始这一轮失败：助手服务内部出错（原文记在日志里）",
		});
		const events = JSON.stringify(harness.events.of(id));
		expect(events).not.toContain("models.json");
		expect(events).not.toContain(harness.root);
		expect(harness.logs.join("\n")).toContain(models);
	});

	it("一轮开头写 skill 时工作台回了认不出的错误：特征串不出现在任何事件里，只进日志", async () => {
		const harness = await start();
		harness.workbench.fail = { code: Code.Internal, message: "MARKER-start-55 at 10.9.8.7" };
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "settle" });
		const end = await harness.turnEnd(id);
		expect(end).toMatchObject({
			outcome: "failed",
			reason:
				"开始这一轮失败：往工作台 fake-workbench 上写 skill 失败：工作台没能完成这次命令：它回了一个错误（工作台还连得上；原文只记在日志里）",
		});
		expect(JSON.stringify(harness.events.of(id))).not.toContain("MARKER");
		expect(harness.logs.join("\n")).toContain("MARKER-start-55");
	});

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
	it("设置目录、每一轮的配置文件（有 secret 环境变量的值的原文）、pi 的临时目录", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "sfly-leftover-"));
		const session = join(dataDir, "sessions", crypto.randomUUID());
		mkdirSync(session, { recursive: true });
		writeFileSync(join(session, "turn.json"), "{}");
		writeFileSync(join(session, "events.jsonl"), "");
		mkdirSync(join(dataDir, "agents", "old"), { recursive: true });
		const tmpRoot = join(dataDir, "pi-tmp");
		mkdirSync(join(tmpRoot, "old"), { recursive: true });
		new SessionManager({
			dataDir,
			modelsFile: "/nonexistent",
			model: undefined,
			piArgv: FAKE_PI,
			extension: "/nonexistent",
			skillsDir: "/nonexistent",
			hostEnv: {},
			bus: new EventBus(),
			connect: (address) => connectAgent(address),
			log: () => {},
			tmpRoot,
		});
		expect(existsSync(join(session, "turn.json"))).toBe(false);
		expect(existsSync(join(session, "events.jsonl"))).toBe(true);
		expect(existsSync(join(dataDir, "agents"))).toBe(false);
		expect(existsSync(tmpRoot)).toBe(false);
		rmSync(dataDir, { recursive: true, force: true });
	});

	it("没给临时目录时按数据目录分开：本机起两个助手服务，后起的不删先起的那个的临时目录", () => {
		const manager = (dataDir: string) =>
			new SessionManager({
				dataDir,
				modelsFile: "/nonexistent",
				model: undefined,
				piArgv: FAKE_PI,
				extension: "/nonexistent",
				skillsDir: "/nonexistent",
				hostEnv: {},
				bus: new EventBus(),
				connect: (address) => connectAgent(address),
				log: () => {},
			});
		const first = mkdtempSync(join(tmpdir(), "sfly-two-a-"));
		const second = mkdtempSync(join(tmpdir(), "sfly-two-b-"));
		try {
			mkdirSync(join(first, "sessions"));
			mkdirSync(join(second, "sessions"));
			const a = manager(first).tmpRoot;
			const b = manager(second).tmpRoot;
			expect(a.startsWith(join(tmpdir(), "sfly-assistant"))).toBe(true);
			expect(a).not.toBe(b);
			// 先起的那个正在用的临时文件：后起的启动时不动它。
			mkdirSync(join(a, "pi-1"), { recursive: true });
			writeFileSync(join(a, "pi-1", "pi-bash-0123456789abcdef.log"), "x");
			manager(second);
			expect(existsSync(join(a, "pi-1", "pi-bash-0123456789abcdef.log"))).toBe(true);
			// 同一个数据目录重启：上次留下的照样清掉。
			manager(first);
			expect(existsSync(a)).toBe(false);
			// 同一个数据目录，临时目录也一样（容器里重启后照样认得出上次的）。
			expect(manager(first).tmpRoot).toBe(a);
		} finally {
			for (const dir of [first, second]) rmSync(dir, { recursive: true, force: true });
		}
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
