import { posix } from "node:path";
import { Code } from "@connectrpc/connect";
import { type AssistantEvent, type CommitFile, SESSION_EVENT_LIMITS } from "@sfly/schema";
import { AgentAnswer, type AgentClient } from "./agent.js";
import type { Redactor } from "./redact.js";

/**
 * 工作区的 git（#546）：工作区（`/work`）是工作台上的一个 git 仓库，每一轮结束时由**平台**（助手服务，不经 pi、不经模型）提交，
 * 提交号、改了哪些文件、差异在这一刻记进会话的时间线（`platform` 事件，`kind` 是 `commit`）。命令都经能力端口在工作台上执行
 * （`AgentClient.run`），**不带会话令牌**：这里只传 git 自己的几个环境变量，调用方不给 `secret_env`。
 *
 * ## 提交不执行工作区里能被模型改的任何东西
 *
 * 工作区和它的 `.git/` 都在模型手里：它能往 `.git/hooks/` 放脚本，能改 `.git/config`（`core.hooksPath`、`core.fsmonitor`、
 * `filter.<名>.clean`、`diff.<名>.textconv`、`diff.external`、`gpg.program`、`include.path`、`includeIf`……），能写 `.gitattributes`
 * 和 `.git/info/attributes`。普通的 `git add -A && git commit` 会执行其中好几样，所以提交的做法是：
 *
 * 1. **每条 git 命令都在命令上显式关掉**会执行东西的配置（{@link GIT_FLAGS}），不靠仓库里的配置：命令行上的 `-c` 比所有配置文件
 *    （含 `include.path`、`includeIf` 引进来的）都优先。`core.hooksPath=/dev/null` 让所有钩子（含 `reference-transaction`、
 *    `post-index-change`）都找不到（`/dev/null/<钩子名>` 不是文件）；`core.fsmonitor=false`；`gc.auto=0`、`maintenance.auto=false`；
 *    `commit.gpgsign=false`。全局和系统的配置、全局的属性文件也去掉（{@link GIT_ENV}）。
 * 2. **过滤器（`filter`）整体绕开，不靠关掉它**：`filter.<名>.clean` 的名字是任意的，命令行上没法逐个覆盖；而 `.gitattributes` 引用它、
 *    `.git/config` 定义它，两处都在模型手里。只把属性来源设成空树（`GIT_ATTR_SOURCE`，`--attr-source`）**不够**：它只换掉工作区里的
 *    `.gitattributes`，`.git/info/attributes` 照样读（在 git 2.47 上实测，`* filter=…` 写在那里过滤器照样执行）。所以暂存这一步**不用模型的
 *    仓库当 `GIT_DIR`**：在工作台上新建一个只有平台写过的临时仓库（`mktemp -d` 出来的、名字不可预测的目录），用它作 `GIT_DIR`
 *    （配置、`info/attributes`、钩子目录都是它的，空的），而索引（`GIT_INDEX_FILE`）和对象目录（`GIT_OBJECT_DIRECTORY`）指到真的仓库里，
 *    `GIT_WORK_TREE` 是工作区：暂存、`write-tree`、`commit-tree` 全在这个环境里做，读不到模型的 `config` 和 `info/attributes`。
 *    工作区里的 `.gitattributes` 另用 `GIT_ATTR_SOURCE`（空树）绕开，存进去的就是工作区里的字节（不做换行转换、不展开 `$Id$`）。
 *    `.git/info/exclude` 是数据，用 `core.excludesFile` 指过来照常生效。
 *    只有读 `HEAD`、更新分支（`rev-parse`、`update-ref`）在真的仓库里做：它们不碰属性和过滤器，钩子在命令上关了，
 *    `reference-transaction` 也在内。**更新分支排在最后**：差异和文件统计在分支动之前就取好了，中途失败时仓库里看不出任何变化（只多了
 *    索引里暂存的内容和没人引用的对象）。
 * 3. 取差异用 `diff-tree`（提交对提交，不读工作区），带 `--no-ext-diff --no-textconv`：外部 diff 和 textconv 不执行。
 * 4. **每次暂存之后都显式把 `.agents/skills` 从索引里拿掉**（助手服务每次拉起 pi 都把 skill 复制进去，不能进用户的仓库），
 *    不靠 `.gitignore`：`.gitignore` 在模型手里，它删了、改了、写了 `!.agents/skills/` 都一样。
 *
 * 没做到的：模型在提交进行的同时还有进程在往 `.git/` 里写（它起的后台进程）时，上面的「读不到」不保证；提交不会在命令结束之后还被什么执行。
 * 经过滤器管理的文件（git-lfs 一类）按工作区里的原样提交，不经过滤器。
 *
 * 连不上工作台、git 不在、仓库坏了：抛 {@link WorkspaceError} 或工作台的错误，由调用方记日志；这一轮照常结束，留给下一轮开始前再试
 * （sessions.ts）。
 */

/** 平台自己的提交身份：初次提交的作者、每个提交的提交者。 */
export const PLATFORM_IDENTITY = { name: "sfly", email: "noreply@sfly.invalid" } as const;

/** 初次提交的说明。 */
export const INITIAL_COMMIT_MESSAGE = "初始化工作区";

/** 写进 `.gitignore` 的行（至少这些：uv 把虚拟环境建在节点包目录里，不忽略就会被提交）。 */
export const GITIGNORE_LINES = [".agents/skills/", ".venv/", "__pycache__/", "dist/"] as const;

/** 暂存时显式排除的路径：不靠 `.gitignore`。 */
export const EXCLUDED_FROM_COMMITS = ".agents/skills";

/** 空树的对象号（SHA-1）：属性来源、没有父提交时的「父树」。 */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** 每条 git 命令的开头：会执行仓库配置里的东西的几项，在命令行上关掉（见文件头）。 */
const GIT_FLAGS = [
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.untrackedCache=false",
	"-c",
	"core.attributesFile=/dev/null",
	"-c",
	"core.quotePath=false",
	"-c",
	"commit.gpgsign=false",
	"-c",
	"tag.gpgsign=false",
	"-c",
	"gc.auto=0",
	"-c",
	"maintenance.auto=false",
];

/** 每条 git 命令的环境：去掉全局和系统的配置、全局的属性文件，不弹提示、不开编辑器和分页。 */
const GIT_ENV: Record<string, string> = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_ATTR_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
	GIT_OPTIONAL_LOCKS: "0",
	GIT_EDITOR: "true",
	GIT_PAGER: "cat",
	// 提示和路径按字节原样：说明里的中文不被当地的编码改写。
	LC_ALL: "C",
};

/** 一条 git 命令最长等多久（整个提交另有自己的期限）。 */
const STEP_TIMEOUT_MS = 60_000;

/** 临时仓库的位置：工作台上 `/tmp` 一定在、谁都能写。 */
const SCRATCH_TEMPLATE = "/tmp/sfly-commit.XXXXXXXX";
const SCRATCH_PREFIX = "/tmp/sfly-commit.";

/** 文件统计（`--numstat`）最多读这么多字节。 */
const NUMSTAT_LIMIT_BYTES = 16 * 1024 * 1024;

/** git 命令失败：消息给日志（带 git 的标准错误），不给模型和页面。 */
export class WorkspaceError extends Error {}

/** 提交里要用的几样工作台能力：经能力端口执行命令、读写文件。 */
export type WorkspaceAgent = Pick<AgentClient, "run" | "readFile" | "writeFile">;

export interface Identity {
	name: string;
	email: string;
}

export interface CommitInput {
	/** 提交说明（一行）。 */
	message: string;
	author: Identity;
	signal?: AbortSignal;
	/**
	 * 差异取到「事件的上限加这么多」字节：打码要先于截断，值的最长写法跨过上限时要有完整的一份来认（{@link commitEventBody}），
	 * 调用方给 `Redactor.longestBytes`。默认 0。
	 */
	diffExtraBytes?: number;
	/** 初次提交不要文件统计和差异（没有人看）。默认要。 */
	summary?: boolean;
}

/** 一个提交的结果：{@link commitEventBody} 把它做成事件。 */
export interface CommitResult {
	hash: string;
	files: CommitFile[];
	/** 差异的开头一段：最多上限加 `diffExtraBytes` 字节。 */
	diff: Buffer;
	/** 差异就是全部（没有被截在读的时候）。 */
	diffComplete: boolean;
}

interface Repository {
	gitDir: string;
	objects: string;
	index: string;
	exclude: string;
}

interface GitCall {
	args: string[];
	cwd: string;
	env?: Record<string, string>;
	/** 标准输出最多留这么多字节：多出来的不要（读够了就结束这条命令），结果里 `cut` 为 true。 */
	keep?: number;
	signal?: AbortSignal;
}

interface GitResult {
	code: number;
	stdout: Buffer;
	stderr: string;
	/** 标准输出被截了（多于 `keep`）。 */
	cut: boolean;
}

/** 标准错误只留这么多字节（给日志用）。 */
const STDERR_KEEP = 4096;

async function execute(
	agent: WorkspaceAgent,
	argv: string[],
	call: Pick<GitCall, "cwd" | "env" | "keep" | "signal">,
): Promise<GitResult> {
	const out: Buffer[] = [];
	let size = 0;
	let cut = false;
	let stderr = "";
	const reading = new AbortController();
	const signal = call.signal ? AbortSignal.any([call.signal, reading.signal]) : reading.signal;
	let code: number;
	try {
		code = await agent.run(argv, {
			cwd: call.cwd,
			env: call.env ?? {},
			timeoutMs: STEP_TIMEOUT_MS,
			signal,
			onData: (data, stream) => {
				if (stream === "stderr") {
					if (stderr.length < STDERR_KEEP) stderr += Buffer.from(data).toString("utf8");
					return;
				}
				if (cut) return;
				const room = (call.keep ?? Number.POSITIVE_INFINITY) - size;
				if (data.length > room) {
					out.push(Buffer.from(data.subarray(0, Math.max(room, 0))));
					size += Math.max(room, 0);
					cut = true;
					// 要的已经读够了：不等命令把剩下的吐完。
					reading.abort();
					return;
				}
				out.push(Buffer.from(data));
				size += data.length;
			},
		});
	} catch (error) {
		// 读够了自己结束的：不是出错（调用方放弃了才是）。
		if (cut && reading.signal.aborted && !call.signal?.aborted) {
			return { code: 0, stdout: Buffer.concat(out), stderr, cut };
		}
		throw error;
	}
	return { code, stdout: Buffer.concat(out), stderr, cut };
}

function git(agent: WorkspaceAgent, call: GitCall): Promise<GitResult> {
	return execute(agent, ["git", ...GIT_FLAGS, ...call.args], {
		...call,
		env: { ...GIT_ENV, ...call.env },
	});
}

/** 命令成功（退出码 0）才往下走；失败的消息带 git 的标准错误，进日志。 */
function must(result: GitResult, what: string): Buffer {
	if (result.code === 0) return result.stdout;
	const detail = result.stderr.trim().slice(0, 300);
	throw new WorkspaceError(`${what}失败（退出码 ${result.code}）${detail ? `：${detail}` : ""}`);
}

/** 工作区是不是 git 仓库：是就返回它的几个路径，不是返回 undefined。 */
async function findRepository(
	agent: WorkspaceAgent,
	workdir: string,
	signal: AbortSignal | undefined,
): Promise<Repository | undefined> {
	const result = await git(agent, {
		// `safe.directory`：工作区的属主和 Agent 的用户不是同一个时，git 拒绝在里面找仓库；这条命令只读、不执行仓库里的任何东西。
		args: [
			"-c",
			`safe.directory=${workdir}`,
			"rev-parse",
			"--absolute-git-dir",
			"--git-path",
			"objects",
			"--git-path",
			"index",
			"--git-path",
			"info/exclude",
		],
		cwd: workdir,
		// 不往上找：工作区之上的目录里有仓库也不算。
		env: { GIT_CEILING_DIRECTORIES: posix.dirname(workdir) },
		signal,
	});
	if (result.code === 0) {
		const [gitDir, objects, index, exclude] = result.stdout.toString("utf8").split("\n");
		if (!gitDir || !objects || !index || !exclude) {
			throw new WorkspaceError("git rev-parse 的输出认不出来");
		}
		const at = (path: string) => posix.resolve(workdir, path);
		return { gitDir, objects: at(objects), index: at(index), exclude: at(exclude) };
	}
	if (/not a git repository/i.test(result.stderr)) return undefined;
	must(result, "git rev-parse");
	return undefined;
}

/**
 * 工作区是 git 仓库：不是就 `git init`（分支 `main`，不带模板：没有示例钩子）、写 `.gitignore`，连同已有的文件做初次提交
 * （「初始化工作区」，作者是平台，不含 `.agents/skills`），返回 true；已经是仓库返回 false，什么也不动。
 * 初次提交不发 `platform` 事件（由调用方决定，这里只管做）。
 */
export async function ensureRepository(
	agent: WorkspaceAgent,
	workdir: string,
	options: { signal?: AbortSignal } = {},
): Promise<boolean> {
	const { signal } = options;
	if (await findRepository(agent, workdir, signal)) return false;
	must(
		await git(agent, {
			args: ["init", "-q", "--template=", "--initial-branch=main"],
			cwd: workdir,
			signal,
		}),
		"git init",
	);
	await writeGitignore(agent, workdir, signal);
	await commitChanges(agent, workdir, {
		message: INITIAL_COMMIT_MESSAGE,
		author: PLATFORM_IDENTITY,
		signal,
		summary: false,
	});
	return true;
}

/** `.gitignore`：没有就写；已经有的补上缺的行，原来的行不动。 */
async function writeGitignore(
	agent: WorkspaceAgent,
	workdir: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	const path = posix.join(workdir, ".gitignore");
	let current = "";
	try {
		current = (await agent.readFile(path, signal)).toString("utf8");
	} catch (error) {
		if (!(error instanceof AgentAnswer && error.code === Code.NotFound)) throw error;
	}
	const have = new Set(current.split(/\r?\n/).map((line) => line.trim()));
	const missing = GITIGNORE_LINES.filter((line) => !have.has(line));
	if (missing.length === 0) return;
	const lead = current === "" || current.endsWith("\n") ? current : `${current}\n`;
	await agent.writeFile(path, Buffer.from(`${lead}${missing.join("\n")}\n`), signal);
}

/**
 * 暂存工作区里的全部改动（`.agents/skills` 除外）并提交到当前分支；没有改动返回 undefined，什么也不留下（提交对象、分支都不变）。
 * 怎么做、为什么这样做见文件头。工作区不是仓库时抛 {@link WorkspaceError}（先 {@link ensureRepository}）。
 */
export async function commitChanges(
	agent: WorkspaceAgent,
	workdir: string,
	input: CommitInput,
): Promise<CommitResult | undefined> {
	const { signal } = input;
	const repo = await findRepository(agent, workdir, signal);
	if (!repo) throw new WorkspaceError("工作区不是 git 仓库");
	const scratch = await makeScratch(agent, signal);
	try {
		// 临时仓库当 GIT_DIR，索引、对象目录是真的仓库里的，工作区是工作区。
		const objects = { GIT_DIR: scratch, GIT_OBJECT_DIRECTORY: repo.objects };
		const stage = {
			...objects,
			GIT_WORK_TREE: workdir,
			GIT_INDEX_FILE: repo.index,
			// 工作区里的 .gitignore 照常生效；.git/info/exclude 经 core.excludesFile 指过来。
			GIT_ATTR_SOURCE: EMPTY_TREE,
		};
		const stageFlags = ["-c", "core.bare=false", "-c", `core.excludesFile=${repo.exclude}`];
		const run = (args: string[], env: Record<string, string>, keep?: number) =>
			git(agent, { args: [...stageFlags, ...args], cwd: workdir, env, keep, signal });

		const current = await git(agent, {
			args: ["rev-parse", "-q", "--verify", "HEAD^{commit}"],
			cwd: workdir,
			env: { GIT_DIR: repo.gitDir },
			signal,
		});
		// 退出码 1：还没有提交（分支还没出生）。别的非零是真的出错。
		if (current.code !== 0 && current.code !== 1) must(current, "git rev-parse HEAD");
		const parent = current.code === 0 ? current.stdout.toString("utf8").trim() : undefined;

		must(await run(["add", "-A"], stage), "git add");
		// `.agents/skills` 不进提交，每次都显式从索引里拿掉，不靠 `.gitignore`（它在模型手里）。不用路径排除（`add -A -- . ':(exclude)…'`）：
		// `.gitignore` 里也有这条时（初始化写进去的就有），git 把排除的路径当成「你明明点名了一个被忽略的路径」报错、退出码 1。
		// 已经跟踪的（不是平台提交进去的）会在这个提交里删掉：平台的提交里没有它。
		must(
			await run(
				["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", EXCLUDED_FROM_COMMITS],
				stage,
			),
			"git rm --cached",
		);
		const tree = must(await run(["write-tree"], stage), "git write-tree")
			.toString("utf8")
			.trim();
		const parentTree = parent
			? must(await run(["rev-parse", `${parent}^{tree}`], objects), "git rev-parse")
					.toString("utf8")
					.trim()
			: EMPTY_TREE;
		if (tree === parentTree) return undefined;

		const author = identity(input.author);
		const hash = must(
			await run(
				["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", oneLine(input.message)],
				{
					...objects,
					GIT_AUTHOR_NAME: author.name,
					GIT_AUTHOR_EMAIL: author.email,
					GIT_COMMITTER_NAME: PLATFORM_IDENTITY.name,
					GIT_COMMITTER_EMAIL: PLATFORM_IDENTITY.email,
				},
			),
			"git commit-tree",
		)
			.toString("utf8")
			.trim();
		if (!/^[0-9a-f]{40,64}$/.test(hash)) throw new WorkspaceError("git commit-tree 的输出认不出来");

		let files: CommitFile[] = [];
		let diff: Buffer = Buffer.alloc(0);
		let diffComplete = true;
		if (input.summary !== false) {
			const show = ["diff-tree", "-r", "--root", "--no-commit-id", "--no-renames"];
			const numstat = await run(
				[...show, "--numstat", "-z", "--no-ext-diff", "--no-textconv", hash],
				objects,
				NUMSTAT_LIMIT_BYTES,
			);
			files = parseNumstat(must(numstat, "git diff-tree"), numstat.cut);
			const limit = SESSION_EVENT_LIMITS.commitDiffBytes + (input.diffExtraBytes ?? 0);
			const patch = await run(
				[...show, "-p", "--no-color", "--no-ext-diff", "--no-textconv", hash],
				objects,
				limit + 1,
			);
			must(patch, "git diff-tree");
			diffComplete = patch.stdout.length <= limit && !patch.cut;
			diff = patch.stdout.subarray(0, limit);
		}

		// 分支最后动：上面任何一步失败，仓库里只多了索引里暂存的内容和没人引用的对象。
		must(
			await git(agent, {
				args: [
					"update-ref",
					"-m",
					`sfly: ${oneLine(input.message)}`,
					"HEAD",
					hash,
					parent ?? "0".repeat(hash.length),
				],
				cwd: workdir,
				env: { GIT_DIR: repo.gitDir },
				signal,
			}),
			"git update-ref",
		);
		return { hash, files, diff, diffComplete };
	} finally {
		await removeScratch(agent, scratch);
	}
}

/** `--numstat -z` 的输出：每个文件 `增\t删\t路径\0`，二进制文件的增删是 `-`。 */
function parseNumstat(output: Buffer, cut: boolean): CommitFile[] {
	// 读了一半就不是完整的文件列表：宁可这次提交不记，也不记一份缺的。
	if (cut) throw new WorkspaceError("改动的文件太多，文件统计超过了读取上限");
	const files: CommitFile[] = [];
	for (const record of output.toString("utf8").split("\0")) {
		if (record === "") continue;
		const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
		if (!match) throw new WorkspaceError("git diff-tree --numstat 的输出认不出来");
		files.push({
			path: match[3] as string,
			additions: match[1] === "-" ? null : Number(match[1]),
			deletions: match[2] === "-" ? null : Number(match[2]),
		});
	}
	return files;
}

/** 提交的作者：昵称里的尖括号、换行去掉（git 也会去），什么都没剩下就用平台的名字。 */
function identity(author: Identity): Identity {
	const name = author.name
		.replace(/[<>\r\n\0]/g, " ")
		.trim()
		.replace(/\s+/g, " ");
	return { name: name === "" ? PLATFORM_IDENTITY.name : name, email: author.email };
}

/** 说明写成一行（会话标题里没有换行，这里再保证一次）：换行、NUL 换成空格。 */
function oneLine(text: string): string {
	return text.replace(/[\r\n\0]+/g, " ").trim();
}

/** 在工作台上新建临时仓库（空的，只有平台写过）：提交时当 `GIT_DIR`。 */
async function makeScratch(
	agent: WorkspaceAgent,
	signal: AbortSignal | undefined,
): Promise<string> {
	const made = await execute(agent, ["mktemp", "-d", SCRATCH_TEMPLATE], { cwd: "/", signal });
	const path = made.stdout.toString("utf8").trim();
	if (made.code !== 0 || !path.startsWith(SCRATCH_PREFIX)) {
		throw new WorkspaceError(`mktemp 失败（退出码 ${made.code}）`);
	}
	try {
		must(
			await git(agent, {
				args: ["init", "-q", "--bare", "--template=", "--initial-branch=main"],
				cwd: path,
				signal,
			}),
			"git init（临时仓库）",
		);
	} catch (error) {
		await removeScratch(agent, path);
		throw error;
	}
	return path;
}

/** 删临时仓库：不管这次提交有没有被放弃都要做（所以不带调用方的信号），出错不抛（只是在工作台的 /tmp 里多留一个小目录）。 */
async function removeScratch(agent: WorkspaceAgent, path: string): Promise<void> {
	if (!path.startsWith(SCRATCH_PREFIX)) return;
	try {
		await execute(agent, ["rm", "-rf", path], { cwd: "/" });
	} catch {
		// 连不上工作台：留着，下次工作台上清 /tmp 时一起清。
	}
}

/** `platform`（`commit`）事件。 */
export type CommitEvent = Extract<AssistantEvent, { type: "platform" }>;

/**
 * 把一个提交的结果做成 `platform`（`commit`）事件。`turn` 是这个提交属于第几轮（被打断那一轮的补提交写那一轮，
 * 虽然事件在下一轮的事件流里发出）。
 *
 * 差异超过上限（{@link SESSION_EVENT_LIMITS} 的 `commitDiffBytes`）只留开头，标 `truncated`，在整行处截断（没有整行可截时
 * 不切开一个字符）。**先打码、后截断**：值打码之后才截，截断点上的半截值不会留下；取回的差异比上限多出最长的一种写法那么多字节
 * （{@link CommitInput.diffExtraBytes}），跨过上限的值是完整的，打得掉。没取完整份时末尾「最长的写法减一个字节」不用（那一段可能
 * 是半截的值，和 {@link Redactor.byteStream} 留尾巴一样）。
 */
export function commitEventBody(
	turn: number,
	result: CommitResult,
	redactor: Redactor,
): CommitEvent {
	const limit = SESSION_EVENT_LIMITS.commitDiffBytes;
	const stream = redactor.byteStream();
	let safe = stream.push(result.diff);
	if (result.diffComplete) safe = Buffer.concat([safe, stream.flush()]);
	const truncated = !result.diffComplete || safe.length > limit;
	const kept = truncated ? head(safe, limit) : safe;
	return {
		type: "platform",
		kind: "commit",
		turn,
		hash: result.hash,
		files: result.files,
		diff: kept.toString("utf8"),
		truncated,
	};
}

/** 不超过 `limit` 字节的开头：能在整行处截（保住大半）就在整行处，否则不切开一个字符。 */
function head(buffer: Buffer, limit: number): Buffer {
	const slice = buffer.length > limit ? buffer.subarray(0, limit) : buffer;
	const newline = slice.lastIndexOf(0x0a);
	if (newline !== -1 && newline + 1 >= slice.length / 2) return slice.subarray(0, newline + 1);
	return withoutPartialChar(slice);
}

/** 去掉末尾被截断的半个 UTF-8 字符。 */
function withoutPartialChar(buffer: Buffer): Buffer {
	let i = buffer.length - 1;
	for (let back = 0; i >= 0 && back < 3 && ((buffer[i] as number) & 0xc0) === 0x80; back += 1)
		i -= 1;
	if (i < 0) return buffer;
	const lead = buffer[i] as number;
	const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
	return buffer.length - i < need ? buffer.subarray(0, i) : buffer;
}
