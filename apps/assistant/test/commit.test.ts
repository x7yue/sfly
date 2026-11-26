// 每一轮结束由平台提交工作区（#546）：真的 SessionManager、假的 pi（support/fake-pi.mjs 的 `run:` 先在工作区里执行一条命令再照剧本走）、
// 假的工作台（本机真的执行，真的 git）。事件的先后、提交的内容、提交不执行模型布下的东西、提交不成时这一轮照常结束。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Code } from "@connectrpc/connect";
import { ASSISTANT_STOP_WAIT_MS, type AssistantEvent, SESSION_EVENT_LIMITS } from "@sfly/schema";
import { afterEach, describe, expect, it } from "vitest";
import { COMMIT_BUDGET_MS } from "../src/sessions.js";
import { eventually } from "./support/eventually.js";
import { git, log, plantTraps, safeGit } from "./support/git.js";
import { Harness, type HarnessOptions } from "./support/harness.js";
import { ManualClock } from "./support/manual-clock.js";

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

type Platform = Extract<AssistantEvent, { type: "platform" }>;
const eventsOf = (harness: Harness, id: string) => harness.events.of(id).map((r) => r.event);
const commitsOf = (harness: Harness, id: string): Platform[] =>
	eventsOf(harness, id).filter((e): e is Platform => e.type === "platform");
const SESSION = { title: "给 http_check 加超时", created_by: "alice" };
const label = (id: string) => `${SESSION.title}（会话 ${id.slice(0, 8)}）`;

describe("一轮结束时提交", () => {
	it("改了文件：工作台上多一个提交（说明有会话标题、会话 ID 前 8 位、第几轮，作者是发起人）；platform 事件在 turn_end 之前，带提交号、文件和差异", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, {
			session: SESSION,
			text: "run:echo hello > a.txt; mkdir sub; printf 'x\\ny\\n' > sub/b.txt;;settle",
		});
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "completed" });

		const events = eventsOf(harness, id);
		const types = events.map((e) => e.type);
		expect(types.filter((t) => t === "platform")).toHaveLength(1);
		expect(types.indexOf("platform")).toBeLessThan(types.indexOf("turn_end"));
		// 在 turn_end 紧前面：这一轮的最后两件事是提交、结局。
		expect(types.at(-1)).toBe("turn_end");
		expect(types.at(-2)).toBe("platform");

		const [commit] = commitsOf(harness, id);
		expect(commit).toMatchObject({
			kind: "commit",
			turn: 1,
			files: [
				{ path: "a.txt", additions: 1, deletions: 0 },
				{ path: "sub/b.txt", additions: 2, deletions: 0 },
			],
			truncated: false,
		});
		expect(commit?.diff).toContain("+hello");
		expect(commit?.hash).toBe(safeGit(harness.workdir, "rev-parse", "HEAD").trim());
		expect(log(harness.workdir)).toEqual([
			`alice | sfly | ${label(id)}第 1 轮`,
			"sfly | sfly | 初始化工作区",
		]);
		// 事件是持久的：带 seq（控制面按它落库）。
		expect(harness.events.of(id).find((r) => r.event.type === "platform")?.seq).toBeGreaterThan(0);
	});

	it("没有改动的一轮：没有提交，也没有 platform 事件", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { session: SESSION, text: "settle" });
		await harness.turnEnd(id);
		expect(commitsOf(harness, id)).toEqual([]);
		expect(log(harness.workdir)).toEqual(["sfly | sfly | 初始化工作区"]);
		// 第二轮也没改：还是没有。
		await harness.prompt(id, { turn: 2, session: SESSION, text: "settle" });
		await harness.turnEnd(id, 2);
		expect(commitsOf(harness, id)).toEqual([]);
		expect(log(harness.workdir)).toHaveLength(1);
	});

	it("两轮：各一个提交，说明里是各自的轮次；第二轮的差异只有第二轮改的", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { session: SESSION, text: "run:echo one > a.txt;;settle" });
		await harness.turnEnd(id);
		await harness.prompt(id, {
			turn: 2,
			session: SESSION,
			text: "run:echo two >> a.txt; echo b > b.txt;;settle",
		});
		await harness.turnEnd(id, 2);
		expect(log(harness.workdir).slice(0, 2)).toEqual([
			`alice | sfly | ${label(id)}第 2 轮`,
			`alice | sfly | ${label(id)}第 1 轮`,
		]);
		const second = commitsOf(harness, id).find((c) => c.turn === 2);
		expect(second?.files).toEqual([
			{ path: "a.txt", additions: 1, deletions: 0 },
			{ path: "b.txt", additions: 1, deletions: 0 },
		]);
		expect(second?.diff).not.toContain("+one");
		expect(second?.diff).toContain("+two");
	});

	it("一轮以任何结局结束，已有的改动照样提交：已停止、到了上限、模型不可用、pi 进程退出", async () => {
		const scenarios: Array<{
			name: string;
			script: string;
			options?: HarnessOptions;
			outcome: string;
			finish?: (harness: Harness, id: string) => Promise<void>;
		}> = [
			{
				name: "stopped",
				script: "work",
				outcome: "stopped",
				finish: async (harness, id) => {
					await eventually(() => expect(existsSync(join(harness.workdir, "a.txt"))).toBe(true));
					await harness.abort(id);
				},
			},
			{
				name: "limit",
				script: "loop",
				options: { limits: { modelCalls: 3, durationMs: 60_000 } },
				outcome: "limit",
			},
			{ name: "model_unavailable", script: "error", outcome: "model_unavailable" },
			{ name: "interrupted", script: "exit", outcome: "interrupted" },
		];
		for (const scenario of scenarios) {
			const harness = await start(scenario.options);
			const id = crypto.randomUUID();
			await harness.prompt(id, {
				session: SESSION,
				text: `run:echo ${scenario.name} > a.txt;;${scenario.script}`,
			});
			await scenario.finish?.(harness, id);
			const end = await harness.turnEnd(id);
			expect(end.outcome, scenario.name).toBe(scenario.outcome);
			expect(commitsOf(harness, id), scenario.name).toHaveLength(1);
			expect(commitsOf(harness, id)[0]?.diff, scenario.name).toContain(`+${scenario.name}`);
			expect(log(harness.workdir)[0], scenario.name).toBe(`alice | sfly | ${label(id)}第 1 轮`);
			const types = eventsOf(harness, id).map((e) => e.type);
			expect(types.indexOf("platform"), scenario.name).toBeLessThan(types.indexOf("turn_end"));
			await harness.close();
			h = undefined;
		}
	}, 120_000);

	it("差异超过 64 KB：事件里只有统计和开头一段，写明被截断", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, {
			session: SESSION,
			text: "run:yes yyyyyyyy | head -n 20000 > big.txt;;settle",
		});
		await harness.turnEnd(id);
		const [commit] = commitsOf(harness, id);
		expect(commit?.files).toEqual([{ path: "big.txt", additions: 20000, deletions: 0 }]);
		expect(commit?.truncated).toBe(true);
		expect(Buffer.byteLength(commit?.diff ?? "")).toBeLessThanOrEqual(
			SESSION_EVENT_LIMITS.commitDiffBytes,
		);
		expect(commit?.diff).toContain("+++ b/big.txt");
		// 提交本身是完整的。
		expect(safeGit(harness.workdir, "show", "--format=", "--numstat", "HEAD").trim()).toBe(
			"20000\t0\tbig.txt",
		);
	});

	it("事件里 secret 的值打码，差异里也是", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, {
			session: SESSION,
			secret_env: { SFLY_API_TOKEN: "tok-0123456789abcdef" },
			text: "run:echo token=tok-0123456789abcdef > .env;;settle",
		});
		await harness.turnEnd(id);
		const [commit] = commitsOf(harness, id);
		expect(commit?.diff).toContain("token=");
		expect(JSON.stringify(harness.events.of(id))).not.toContain("tok-0123456789abcdef");
		// 仓库里是模型写的原样（平台不改工作区里的东西）。
		expect(safeGit(harness.workdir, "show", "HEAD:.env")).toBe("token=tok-0123456789abcdef\n");
	});
});

describe("提交不执行模型能改的任何东西", () => {
	it("钩子、fsmonitor、过滤器、textconv、外部 diff、gpg、include 里的同样配置：一轮结束时的提交和下一轮开始前补的提交，标记文件都不存在", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		// 第 1 轮先让平台初始化出仓库，再布陷阱。
		await harness.prompt(id, { session: SESSION, text: "settle" });
		await harness.turnEnd(id);
		const traps = plantTraps(harness.workdir);
		await harness.prompt(id, {
			turn: 2,
			session: SESSION,
			text: "run:echo changed > a.txt;;settle",
		});
		await harness.turnEnd(id, 2);
		expect(traps.ran()).toEqual([]);
		expect(commitsOf(harness, id).map((c) => c.turn)).toEqual([2]);

		// 助手服务重启打断了一轮：下一轮开始前补的提交也不执行。
		await harness.prompt(id, {
			turn: 3,
			session: SESSION,
			text: "run:echo three > c.txt;;work",
		});
		await eventually(() => expect(existsSync(join(harness.workdir, "c.txt"))).toBe(true));
		const restarted = await harness.restart();
		expect(restarted.prompt(id, promptBody(harness, 4, "settle"))).toEqual({ ok: true });
		await harness.turnEnd(id, 4);
		expect(traps.ran()).toEqual([]);
		expect(commitsOf(harness, id).map((c) => c.turn)).toEqual([2, 3]);
		expect(log(harness.workdir)[0]).toBe(`alice | sfly | ${label(id)}第 3 轮被打断时留下的改动`);
	}, 60_000);

	it("提交的命令没有会话令牌：工作台收到的每条命令里都没有", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, {
			session: SESSION,
			secret_env: { SFLY_API_TOKEN: "tok-0123456789abcdef" },
			env: { SFLY_NICKNAME: "alice" },
			text: "run:echo a > a.txt;;settle",
		});
		await harness.turnEnd(id);
		expect(harness.workbench.runs.length).toBeGreaterThan(5);
		const all = JSON.stringify(harness.workbench.runs);
		expect(all).not.toContain("tok-0123456789abcdef");
		expect(all).not.toContain("SFLY_NICKNAME");
		expect(commitsOf(harness, id)).toHaveLength(1);
	});
});

describe("工作区的初始化", () => {
	it("第一轮之前 /work 变成 git 仓库：有 .gitignore 和初次提交（含已有的文件、不含 .agents/skills），不发 platform 事件；节点包里的 .venv/ 不提交", async () => {
		const harness = await start();
		writeFileSync(join(harness.workdir, "README.md"), "已有的\n");
		const id = crypto.randomUUID();
		await harness.prompt(id, {
			session: SESSION,
			text: "run:mkdir -p pkg/.venv/lib pkg/__pycache__; echo v > pkg/.venv/lib/x.py; echo c > pkg/__pycache__/m.pyc; echo p > pkg/node.py;;settle",
		});
		await harness.turnEnd(id);
		const tree = (rev: string) =>
			safeGit(harness.workdir, "ls-tree", "-r", "--name-only", rev).split("\n").filter(Boolean);
		expect(tree("HEAD~1")).toEqual([".gitignore", "README.md"]);
		expect(tree("HEAD")).toEqual([".gitignore", "README.md", "pkg/node.py"]);
		expect(readFileSync(join(harness.workdir, ".gitignore"), "utf8")).toContain(".venv/");
		// 平台把 skill 放进了工作区，它没有进任何提交。
		expect(existsSync(join(harness.workdir, ".agents", "skills"))).toBe(true);
		expect(
			safeGit(harness.workdir, "log", "--all", "--name-only", "--format=").includes(
				".agents/skills",
			),
		).toBe(false);
		// 只有这一轮的提交发了事件，初次提交没有。
		expect(commitsOf(harness, id)).toHaveLength(1);
		expect(commitsOf(harness, id)[0]?.files).toEqual([
			{ path: "pkg/node.py", additions: 1, deletions: 0 },
		]);
	});

	it("已经是仓库的工作区（有历史）：不重新初始化，也不另做初次提交", async () => {
		const harness = await start();
		git(harness.workdir, "init", "-q", "-b", "trunk");
		writeFileSync(join(harness.workdir, "a.txt"), "a\n");
		git(harness.workdir, "-c", "user.name=u", "-c", "user.email=u@u", "add", "-A");
		git(
			harness.workdir,
			"-c",
			"user.name=u",
			"-c",
			"user.email=u@u",
			"commit",
			"-q",
			"-m",
			"原来的历史",
		);
		const id = crypto.randomUUID();
		await harness.prompt(id, { session: SESSION, text: "run:echo b > b.txt;;settle" });
		await harness.turnEnd(id);
		expect(log(harness.workdir)).toEqual([
			`alice | sfly | ${label(id)}第 1 轮`,
			"u | u | 原来的历史",
		]);
		expect(safeGit(harness.workdir, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("trunk");
	});
});

describe("提交不成时这一轮照常结束，留给下一轮开始前", () => {
	it("工作台上的命令都出错：这一轮 completed、没有 platform 事件，日志里写了；下一轮开始前把留下的改动单独提交并发事件", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { session: SESSION, text: "settle" });
		await harness.turnEnd(id);

		harness.workbench.fail = { code: Code.Internal, message: "boom" };
		await harness.prompt(id, { turn: 2, session: SESSION, text: "run:echo two > two.txt;;settle" });
		expect(await harness.turnEnd(id, 2)).toMatchObject({ outcome: "completed" });
		expect(commitsOf(harness, id)).toEqual([]);
		expect(harness.logs.some((line) => line.includes("提交工作区") && line.includes("失败"))).toBe(
			true,
		);
		expect(log(harness.workdir)).toHaveLength(1);

		harness.workbench.fail = undefined;
		await harness.prompt(id, { turn: 3, session: SESSION, text: "settle" });
		await harness.turnEnd(id, 3);
		const left = commitsOf(harness, id);
		expect(left).toHaveLength(1);
		// 事件是第 2 轮的（那一轮留下的改动），在第 3 轮的事件流里发出，排在第 3 轮的 turn_end 之前。
		expect(left[0]).toMatchObject({
			turn: 2,
			files: [{ path: "two.txt", additions: 1, deletions: 0 }],
		});
		const stream = harness.events.of(id);
		const leftover = stream.find((r) => r.event.type === "platform");
		expect(leftover?.turn).toBe(3);
		expect(stream.indexOf(leftover as (typeof stream)[number])).toBeLessThan(
			stream.findIndex((r) => r.turn === 3 && r.event.type === "turn_end"),
		);
		expect(log(harness.workdir)[0]).toBe(`alice | sfly | ${label(id)}第 2 轮被打断时留下的改动`);
	});

	it("助手服务重启打断的一轮：留下的改动在下一轮开始前单独提交（说明写「第 N 轮被打断时留下的改动」），同样发 platform 事件", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { session: SESSION, text: "run:echo half > half.txt;;work" });
		await eventually(() => expect(existsSync(join(harness.workdir, "half.txt"))).toBe(true));
		const restarted = await harness.restart();
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "interrupted" });
		// 退出时不提交：改动还在工作区里，没有 platform 事件。
		expect(commitsOf(harness, id)).toEqual([]);
		expect(log(harness.workdir)).toHaveLength(1);

		expect(restarted.prompt(id, promptBody(harness, 2, "settle"))).toEqual({ ok: true });
		await harness.turnEnd(id, 2);
		const [left] = commitsOf(harness, id);
		expect(left).toMatchObject({
			turn: 1,
			files: [{ path: "half.txt", additions: 1, deletions: 0 }],
		});
		expect(log(harness.workdir)[0]).toBe(`alice | sfly | ${label(id)}第 1 轮被打断时留下的改动`);
		// 第 2 轮自己没有改动：没有第二个事件。
		expect(commitsOf(harness, id)).toHaveLength(1);
	}, 60_000);

	it("提交进行中助手服务退出：放弃提交，这一轮照原来的结局发 turn_end，不等", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { session: SESSION, text: "settle" });
		await harness.turnEnd(id);
		harness.workbench.hang = { marker: "write-tree", thenSilent: false };
		const before = harness.workbench.runs.length;
		await harness.prompt(id, { turn: 2, session: SESSION, text: "run:echo x > x.txt;;settle" });
		// 第 2 轮的提交走到了 write-tree（第 1 轮的不算）：它不回话，提交卡在这里。
		await eventually(() =>
			expect(harness.workbench.runs.slice(before).some((r) => r.argv.includes("write-tree"))).toBe(
				true,
			),
		);
		// 结局还没发：提交在等 write-tree。
		expect(harness.events.of(id).some((r) => r.turn === 2 && r.event.type === "turn_end")).toBe(
			false,
		);
		const started = Date.now();
		await harness.sessions.shutdown();
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(await harness.turnEnd(id, 2)).toMatchObject({ outcome: "completed" });
		expect(commitsOf(harness, id)).toEqual([]);
	}, 60_000);

	it("提交超过期限（工作台卡在 write-tree）：放弃，这一轮照原来的结局结束，没有 platform 事件；下一轮开始前补提交", async () => {
		const clock = new ManualClock();
		const harness = await start({ clock });
		const id = crypto.randomUUID();
		await harness.prompt(id, { session: SESSION, text: "settle" });
		await harness.turnEnd(id);
		harness.workbench.hang = { marker: "write-tree", thenSilent: false };
		const before = harness.workbench.runs.length;
		await harness.prompt(id, { turn: 2, session: SESSION, text: "run:echo x > x.txt;;settle" });
		await eventually(() =>
			expect(harness.workbench.runs.slice(before).some((r) => r.argv.includes("write-tree"))).toBe(
				true,
			),
		);
		clock.advance(COMMIT_BUDGET_MS);
		expect(await harness.turnEnd(id, 2)).toMatchObject({ outcome: "completed" });
		expect(commitsOf(harness, id)).toEqual([]);
		expect(harness.logs.some((line) => line.includes("提交工作区") && line.includes("放弃"))).toBe(
			true,
		);
		harness.workbench.hang = undefined;
		await harness.prompt(id, { turn: 3, session: SESSION, text: "settle" });
		await harness.turnEnd(id, 3);
		expect(commitsOf(harness, id).map((c) => [c.turn, c.files.map((f) => f.path)])).toEqual([
			[2, ["x.txt"]],
		]);
	}, 60_000);

	it("停止的期限快到了（pi 不理 abort 和 SIGTERM，等到硬上限）：不提交，同步结束，不等；改动在下一轮开始前补提交", async () => {
		const clock = new ManualClock();
		const harness = await start({ clock });
		const id = crypto.randomUUID();
		await harness.prompt(id, { session: SESSION, text: "run:echo x > x.txt;;ignore-term" });
		await eventually(() => expect(existsSync(join(harness.workdir, "x.txt"))).toBe(true));
		// 等 pi 拿到 prompt 再停（停止才会走 clear_queue、abort、等 agent_settled 那条路）。
		await eventually(() =>
			expect(readFileSync(join(harness.dataDir, "sessions", id, "events.jsonl"), "utf8")).toContain(
				"turn_start",
			),
		);
		await harness.abort(id);
		clock.advance(ASSISTANT_STOP_WAIT_MS);
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "stopped" });
		expect(commitsOf(harness, id)).toEqual([]);
		expect(harness.logs.some((line) => line.includes("离停止的期限太近"))).toBe(true);
		// 旧的进程退出之后下一轮开始：先把留下的改动单独提交。
		await harness.prompt(id, { turn: 2, session: SESSION, text: "settle" });
		clock.advance(ASSISTANT_STOP_WAIT_MS);
		await harness.turnEnd(id, 2);
		expect(commitsOf(harness, id).map((c) => c.turn)).toEqual([1]);
		expect(log(harness.workdir)[0]).toBe(`alice | sfly | ${label(id)}第 1 轮被打断时留下的改动`);
	}, 60_000);

	it("工作台不回话：先问一声、几秒内没有回应就放弃，不等提交的整个期限", async () => {
		const clock = new ManualClock();
		const harness = await start({
			clock,
			agentDeadlines: { probeDeadlineMs: 300 },
		});
		const id = crypto.randomUUID();
		await harness.prompt(id, { session: SESSION, text: "settle" });
		await harness.turnEnd(id);
		harness.workbench.silent = true;
		await harness.prompt(id, { turn: 2, session: SESSION, text: "run:echo x > x.txt;;settle" });
		// 时钟不动：不靠 30 秒的期限，靠「先问一声」的 300 毫秒。
		expect(await harness.turnEnd(id, 2)).toMatchObject({ outcome: "completed" });
		expect(commitsOf(harness, id)).toEqual([]);
		harness.workbench.silent = false;
	}, 60_000);
});

describe("提交是平台做的", () => {
	it("时间线上没有对应的工具调用，发给模型的内容里也没有这次提交（真的 pi，假模型端点）", async () => {
		h = await Harness.start();
		const harness = h;
		harness.model.scripts.set("剧本：写一个文件", [
			{ tool: "write", args: { path: "notes/a.txt", content: "hello\n" } },
			{ text: "写好了。" },
		]);
		const id = crypto.randomUUID();
		await harness.prompt(id, { session: SESSION, text: "剧本：写一个文件" });
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "completed", steps: 1 });
		const [commit] = commitsOf(harness, id);
		expect(commit?.files).toEqual([{ path: "notes/a.txt", additions: 1, deletions: 0 }]);

		// 时间线上只有模型自己的那一次写，没有谁调了 git。
		const calls = eventsOf(harness, id).filter((e) => e.type === "tool_call");
		expect(calls.map((e) => e.type === "tool_call" && [e.tool, e.title])).toEqual([
			["write", "notes/a.txt"],
		]);
		// 第二轮（同一个 pi 会话，带着第一轮的对话）：发给模型的所有请求里都没有这次提交的任何痕迹。
		await harness.prompt(id, { turn: 2, session: SESSION, text: "你好，接着做" });
		await harness.turnEnd(id, 2);
		const sent = JSON.stringify(harness.model.requests);
		expect(harness.model.requests.length).toBeGreaterThanOrEqual(3);
		expect(sent).not.toContain(commit?.hash as string);
		expect(sent).not.toContain((commit?.hash as string).slice(0, 7));
		expect(sent).not.toContain("初始化工作区");
		expect(sent).not.toContain(`会话 ${id.slice(0, 8)}`);
		expect(sent).not.toContain('"kind":"commit"');
		expect(sent).not.toContain("git commit");
		// 没有 git 的工具：模型能用的还是读、写、编辑、命令。
		const tools = harness.model.requests.flatMap((r) => r.tools ?? []).map((t) => t.function?.name);
		expect(new Set(tools)).toEqual(new Set(["read", "write", "edit", "bash"]));
	}, 120_000);

	it("事后在工作台上改写 git 历史（reset、commit --amend）：已经发出的事件里的提交号和差异不变", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { session: SESSION, text: "run:echo one > a.txt;;settle" });
		await harness.turnEnd(id);
		const before = JSON.stringify(commitsOf(harness, id));
		const original = commitsOf(harness, id)[0]?.hash as string;

		safeGit(harness.workdir, "reset", "--hard", "HEAD~1");
		writeFileSync(join(harness.workdir, "other.txt"), "rewritten\n");
		git(harness.workdir, "add", "-A");
		git(
			harness.workdir,
			"-c",
			"user.name=m",
			"-c",
			"user.email=m@m",
			"commit",
			"-q",
			"--amend",
			"-m",
			"改写了",
		);
		expect(safeGit(harness.workdir, "rev-parse", "HEAD").trim()).not.toBe(original);
		// amend 保留原来那个提交（初次提交）的作者。
		expect(log(harness.workdir)).toEqual(["sfly | m | 改写了"]);

		// 事件里是提交那一刻的差异本身，不是指向仓库的引用：改写之后它不变。
		expect(JSON.stringify(commitsOf(harness, id))).toBe(before);
		expect(commitsOf(harness, id)[0]?.diff).toContain("+one");
		expect(commitsOf(harness, id)[0]?.hash).toBe(original);
	});
});

/** 直接交给 SessionManager 的第 `turn` 轮（不经 HTTP）。 */
function promptBody(harness: Harness, turn: number, text: string) {
	return {
		turn,
		message_id: crypto.randomUUID(),
		text,
		session: SESSION,
		workbench: {
			name: "fake-workbench",
			address: harness.workbench.address,
			workdir: harness.workdir,
		},
		env: {},
		secret_env: {},
	};
}
