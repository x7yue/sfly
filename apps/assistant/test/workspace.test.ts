// 工作区的提交（#546）：助手服务经能力端口在工作台上做 git 初始化和每一轮结束时的提交。假工作台在本机真的执行命令，
// 所以这里跑的是真的 git：初始化、提交、模型布下陷阱时提交不执行它们、差异的截断和打码。
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_EVENT_LIMITS } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentClient, connectAgent } from "../src/agent.js";
import { Redactor } from "../src/redact.js";
import {
	type CommitResult,
	commitChanges,
	commitEventBody,
	ensureRepository,
	PLATFORM_IDENTITY,
} from "../src/workspace.js";
import { FakeWorkbench } from "./support/fake-workbench.js";
import { git, log, plantTraps, safeGit } from "./support/git.js";

let root: string;
let workdir: string;
let bench: FakeWorkbench;
let agent: AgentClient;

beforeEach(async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "sfly-workspace-")));
	workdir = join(root, "work");
	mkdirSync(workdir);
	bench = await FakeWorkbench.start();
	agent = connectAgent(bench.address, { log: () => {} });
});
afterEach(async () => {
	agent.close();
	await bench.close();
	rmSync(root, { recursive: true, force: true });
});

const ALICE = { name: "alice", email: "alice@sfly.invalid" };
const MESSAGE = "给 http_check 加超时（会话 0a1b2c3d）第 2 轮";
const commit = (message = MESSAGE) => commitChanges(agent, workdir, { message, author: ALICE });
const write = (path: string, content: string | Buffer) => {
	mkdirSync(join(workdir, path, ".."), { recursive: true });
	writeFileSync(join(workdir, path), content);
};
/** 当前提交里的文件（路径，排好序）。 */
const tracked = () =>
	safeGit(workdir, "ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean);

describe("初始化工作区", () => {
	it("不是 git 仓库：git init、写 .gitignore、初次提交只含 .gitignore 和已有文件，不含 .agents/skills，节点包里的 .venv/ 没被提交", async () => {
		write("notes/a.txt", "已有的文件\n");
		write(".agents/skills/s/SKILL.md", "skill\n");
		write("pkg/.venv/lib/x.py", "venv\n");
		write("pkg/__pycache__/m.pyc", "cache\n");
		write("pkg/dist/out.whl", "dist\n");
		write("pkg/node.py", "print(1)\n");

		expect(await ensureRepository(agent, workdir)).toBe(true);

		const ignore = readFileSync(join(workdir, ".gitignore"), "utf8").split("\n");
		for (const line of [".agents/skills/", ".venv/", "__pycache__/", "dist/"]) {
			expect(ignore).toContain(line);
		}
		expect(tracked()).toEqual([".gitignore", "notes/a.txt", "pkg/node.py"]);
		expect(log(workdir)).toEqual([
			`${PLATFORM_IDENTITY.name} | ${PLATFORM_IDENTITY.name} | 初始化工作区`,
		]);
		// 提交之后工作区是干净的。
		expect(safeGit(workdir, "status", "--porcelain", "--ignored=no")).toBe("");
	});

	it("已经是仓库：什么都不做（没有提交，.gitignore 不改）", async () => {
		git(workdir, "init", "-q", "-b", "main");
		write(".gitignore", "*.log\n");
		write("a.txt", "a\n");
		expect(await ensureRepository(agent, workdir)).toBe(false);
		expect(() => safeGit(workdir, "rev-parse", "-q", "--verify", "HEAD^{commit}")).toThrow();
		expect(readFileSync(join(workdir, ".gitignore"), "utf8")).toBe("*.log\n");
	});

	it("还不是仓库、已经有 .gitignore：补上缺的行（已有的那几行不重复），原来的行都在", async () => {
		write(".gitignore", "*.log\ndist/");
		await ensureRepository(agent, workdir);
		const lines = readFileSync(join(workdir, ".gitignore"), "utf8").split("\n").filter(Boolean);
		expect(lines).toContain("*.log");
		expect(lines.filter((l) => l === "dist/")).toHaveLength(1);
		expect(lines).toEqual(expect.arrayContaining([".agents/skills/", ".venv/", "__pycache__/"]));
		expect(tracked()).toEqual([".gitignore"]);
	});
});

describe("提交", () => {
	beforeEach(async () => {
		write("a.txt", "one\ntwo\n");
		write("gone.txt", "bye\n");
		await ensureRepository(agent, workdir);
	});

	it("改了、新增、删了文件：一个提交，作者是发起人、提交者是平台、说明照给的；文件有各自的增删行数，二进制是 null；差异是这个提交的", async () => {
		write("a.txt", "one\nTWO\nthree\n");
		write("sub/new.txt", "新文件\n");
		write("logo.png", Buffer.from([0, 1, 2, 0xff, 0]));
		rmSync(join(workdir, "gone.txt"));

		const result = await commit();
		expect(result).toBeDefined();
		const head = safeGit(workdir, "rev-parse", "HEAD").trim();
		expect(result?.hash).toBe(head);
		expect(log(workdir)[0]).toBe(`alice | ${PLATFORM_IDENTITY.name} | ${MESSAGE}`);
		expect(safeGit(workdir, "log", "-1", "--format=%ae|%ce").trim()).toBe(
			`${ALICE.email}|${PLATFORM_IDENTITY.email}`,
		);
		expect(result?.files).toEqual([
			{ path: "a.txt", additions: 2, deletions: 1 },
			{ path: "gone.txt", additions: 0, deletions: 1 },
			{ path: "logo.png", additions: null, deletions: null },
			{ path: "sub/new.txt", additions: 1, deletions: 0 },
		]);
		const diff = result?.diff.toString("utf8") ?? "";
		expect(result?.diffComplete).toBe(true);
		expect(diff).toContain("diff --git a/a.txt b/a.txt");
		expect(diff).toContain("+TWO");
		expect(diff).toContain("deleted file mode");
		expect(diff).toContain("+新文件");
		expect(diff).toContain("Binary files");
		// 事件里的差异就是这个提交的差异。
		expect(diff).toBe(
			safeGit(
				workdir,
				"-c",
				"core.quotePath=false",
				"diff-tree",
				"-p",
				"-r",
				"--no-commit-id",
				"--no-ext-diff",
				"--no-textconv",
				"HEAD",
			),
		);
		// 提交之后工作区是干净的：用户自己 git status 看不到没提交的东西。
		expect(safeGit(workdir, "status", "--porcelain")).toBe("");
	});

	it("没有改动：不提交（返回 undefined），已有的提交不变", async () => {
		const before = safeGit(workdir, "rev-parse", "HEAD");
		expect(await commit()).toBeUndefined();
		expect(safeGit(workdir, "rev-parse", "HEAD")).toBe(before);
		expect(log(workdir)).toHaveLength(1);
	});

	it("差异很大：只取上限加 diffExtraBytes 那么多字节，diffComplete 为 false；文件统计是完整的", async () => {
		write("big.txt", `${"y".repeat(99)}\n`.repeat(3000));
		const result = await commitChanges(agent, workdir, {
			message: MESSAGE,
			author: ALICE,
			diffExtraBytes: 50,
		});
		expect(result?.files).toEqual([{ path: "big.txt", additions: 3000, deletions: 0 }]);
		expect(result?.diffComplete).toBe(false);
		expect(result?.diff.length).toBe(SESSION_EVENT_LIMITS.commitDiffBytes + 50);
		expect(result?.diff.toString("utf8")).toContain("+++ b/big.txt");
	});

	it(".agents/skills 不提交，.gitignore 被改掉、删掉也一样；.gitignore 和 .git/info/exclude 里的不提交", async () => {
		rmSync(join(workdir, ".gitignore"));
		write(".agents/skills/x/SKILL.md", "skill\n");
		write(".agents/skills/y.txt", "skill\n");
		write("pkg/.venv/lib.py", "venv\n");
		write("keep.txt", "keep\n");
		write("ignored.log", "excluded\n");
		write(".git/info/exclude", "*.log\n");

		const result = await commit();
		expect(result?.files.map((f) => f.path)).toEqual([
			".gitignore",
			"keep.txt",
			"pkg/.venv/lib.py",
		]);
		expect(tracked().some((p) => p.startsWith(".agents/skills"))).toBe(false);
		expect(tracked()).not.toContain("ignored.log");
	});

	it(".gitignore 写了 !.agents/skills/（取消忽略）也不提交；已经被忽略时也不报错", async () => {
		write(".gitignore", "!.agents/skills/\n");
		write(".agents/skills/x/SKILL.md", "skill\n");
		write("keep.txt", "keep\n");
		const result = await commit();
		expect(result?.files.map((f) => f.path)).toEqual([".gitignore", "keep.txt"]);
		expect(tracked().some((p) => p.startsWith(".agents/skills"))).toBe(false);
		// 再来一次：.gitignore 里有 .agents/skills/ 时（初始化写的就是这样）git add 也不因为它报错。
		write(".gitignore", ".agents/skills/\n");
		write("more.txt", "more\n");
		expect((await commit("第二个"))?.files.map((f) => f.path)).toEqual([".gitignore", "more.txt"]);
	});

	it("取差异的一步失败：分支没动（仓库里看不出这次提交），再提交一次照样成功", async () => {
		write("a.txt", "changed\n");
		const before = safeGit(workdir, "rev-parse", "HEAD");
		const broken: AgentClient = {
			...agent,
			run: (argv, options) =>
				argv.includes("diff-tree") ? Promise.resolve(1) : agent.run(argv, options),
		};
		await expect(
			commitChanges(broken, workdir, { message: MESSAGE, author: ALICE }),
		).rejects.toThrow(/git diff-tree/);
		expect(safeGit(workdir, "rev-parse", "HEAD")).toBe(before);
		expect(log(workdir)).toHaveLength(1);
		// 索引里暂存的内容留着也不碍事：下一次提交把这些改动提交上。
		const retry = await commit();
		expect(retry?.files).toEqual([{ path: "a.txt", additions: 1, deletions: 2 }]);
		expect(log(workdir)).toHaveLength(2);
	});

	it("提交的命令不带会话令牌，也不带助手服务给 pi 的环境：只有 git 自己的设置", async () => {
		write("b.txt", "b\n");
		await commit();
		expect(bench.runs.length).toBeGreaterThan(3);
		for (const run of bench.runs) {
			for (const key of Object.keys(run.env)) {
				expect(key, run.argv.join(" ")).toMatch(/^(GIT_|LC_ALL$)/);
			}
		}
		// 每条命令都显式关掉了仓库里的配置能触发的执行：不靠 .git/config。
		const staging = bench.runs.find((run) => run.argv.includes("add"));
		expect(staging?.argv.join(" ")).toContain("core.hooksPath=/dev/null");
		expect(staging?.argv.join(" ")).toContain("core.fsmonitor=false");
	});
});

describe("模型布下的陷阱：提交不执行工作区里能被模型改的任何东西", () => {
	it("陷阱是真的布好了：直接 git add、git commit 会触发钩子、fsmonitor、过滤器（对照）", async () => {
		await ensureRepository(agent, workdir);
		const traps = plantTraps(workdir);
		write("b.txt", "b\n");
		const attempt = (...args: string[]) => {
			try {
				git(workdir, "-c", "user.name=t", "-c", "user.email=t@t", ...args);
			} catch {
				// 有的陷阱（gpg）会让提交失败：标记文件照样留下。
			}
		};
		attempt("add", "-A");
		attempt("commit", "-q", "-m", "直接提交");
		// core.hooksPath 指到别处时 .git/hooks 里的不用：再用它们提交一次。
		attempt(
			"-c",
			`core.hooksPath=${join(workdir, ".git", "hooks")}`,
			"commit",
			"-q",
			"-m",
			"再来一次",
			"--allow-empty",
		);
		expect(traps.ran()).toEqual(
			expect.arrayContaining([
				"filter",
				"fsmonitor",
				"gpg",
				"hook-pre-commit",
				"hooksPath-pre-commit",
			]),
		);
	});

	it("钩子、core.hooksPath、fsmonitor、过滤器（.gitattributes 和 .git/info/attributes 两处）、textconv、外部 diff、gpg、include.path、includeIf、gc.auto：标记文件都不存在，提交成功", async () => {
		await ensureRepository(agent, workdir);
		const traps = plantTraps(workdir);
		write("a.txt", "改了\n");
		write("sub/b.txt", "新的\n");

		const result = await commit();
		expect(result?.files.map((f) => f.path).sort()).toEqual([
			".gitattributes",
			"a.txt",
			"sub/b.txt",
		]);
		expect(traps.ran()).toEqual([]);
		// 提交确实在仓库里，分支指向它。
		expect(safeGit(workdir, "rev-parse", "HEAD").trim()).toBe(result?.hash);
		expect(log(workdir)[0]).toBe(`alice | ${PLATFORM_IDENTITY.name} | ${MESSAGE}`);
		// 过滤器没有改写内容：存进去的就是工作区里的字节。
		expect(safeGit(workdir, "show", "--no-textconv", "HEAD:sub/b.txt")).toBe("新的\n");
	});

	it("初始化也不执行：仓库已经布了陷阱、还没有任何提交", async () => {
		git(workdir, "init", "-q", "-b", "main");
		const traps = plantTraps(workdir);
		write("a.txt", "a\n");
		// 已经是仓库：初始化什么都不做；第一次提交（没有父提交）同样不触发。
		expect(await ensureRepository(agent, workdir)).toBe(false);
		const result = await commit("第一个提交");
		expect(result?.hash).toBeDefined();
		expect(traps.ran()).toEqual([]);
	});
});

describe("事件里的差异", () => {
	const LIMIT = SESSION_EVENT_LIMITS.commitDiffBytes;
	const result = (diff: string | Buffer, complete = true): CommitResult => ({
		hash: "a".repeat(40),
		files: [{ path: "a.txt", additions: 1, deletions: 0 }],
		diff: Buffer.from(diff),
		diffComplete: complete,
	});

	it("不超过上限：原样放进事件，不标截断", () => {
		const event = commitEventBody(3, result("diff --git a/a b/a\n+x\n"), new Redactor());
		expect(event).toMatchObject({
			type: "platform",
			kind: "commit",
			turn: 3,
			hash: "a".repeat(40),
			files: [{ path: "a.txt", additions: 1, deletions: 0 }],
			diff: "diff --git a/a b/a\n+x\n",
			truncated: false,
		});
	});

	it("超过上限：只留开头一段（在整行处截断），标截断；文件统计不受影响", () => {
		const line = `+${"x".repeat(98)}\n`;
		const diff = line.repeat(Math.ceil((LIMIT * 2) / line.length));
		const event = commitEventBody(1, result(diff.slice(0, LIMIT + 1000), false), new Redactor());
		expect(event.truncated).toBe(true);
		expect(Buffer.byteLength(event.diff)).toBeLessThanOrEqual(LIMIT);
		expect(Buffer.byteLength(event.diff)).toBeGreaterThan(LIMIT - 200);
		expect(event.diff.endsWith("\n")).toBe(true);
		expect(event.files).toHaveLength(1);
	});

	it("一行没有换行、全是多字节字符：不在字符中间截断", () => {
		const event = commitEventBody(1, result("汉".repeat(LIMIT), false), new Redactor());
		expect(event.truncated).toBe(true);
		expect(event.diff).not.toContain("�");
		expect(Buffer.byteLength(event.diff)).toBeLessThanOrEqual(LIMIT);
		expect(Buffer.byteLength(event.diff)).toBeGreaterThan(LIMIT - 4);
	});

	it("没取完整份（diffComplete 为 false）：即使取到的不到上限也标截断", () => {
		expect(commitEventBody(1, result("+x\n", false), new Redactor()).truncated).toBe(true);
	});

	it("secret 的值打码；落在截断点上的值不留下半截（先打码、后截断）", () => {
		const secret = "TOKEN-0123456789-abcdef";
		const redactor = new Redactor();
		redactor.add([secret]);
		const mask = commitEventBody(1, result(`+key=${secret}\n`), redactor);
		expect(mask.diff).not.toContain(secret);
		expect(mask.diff).toContain("+key=");
		// 值跨过上限：开头在上限前几个字节，其余在上限之后。取回的是「上限加最长的写法」那么多字节。
		const pad = "x".repeat(LIMIT - 8);
		const raw = `${pad}${secret}${"y".repeat(secret.length * 2)}`;
		const cut = commitEventBody(
			1,
			result(Buffer.from(raw).subarray(0, LIMIT + redactor.longestBytes), false),
			redactor,
		);
		expect(cut.truncated).toBe(true);
		expect(cut.diff).not.toContain("TOKEN");
		expect(cut.diff).not.toContain("TOK");
		expect(cut.diff).not.toContain(secret.slice(0, 5));
		expect(Buffer.byteLength(cut.diff)).toBeLessThanOrEqual(LIMIT);
	});
});
