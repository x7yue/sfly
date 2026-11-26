import { randomBytes } from "node:crypto";
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
 * ## 威胁模型
 *
 * 模型在工作台上本来就能以同一个用户执行任意命令，所以「平台提交时执行了模型的东西」本身不是提权。要防的是两件事：
 * 一是平台的记录被模型改得不真（少记、记错）；二是模型借平台的提交拖住或打乱一轮的收尾（让它不结束、让它在停止的期限之后才结束）。
 * 下面每一条都按这两件事来：不执行模型留下的东西，是因为执行了它就能改记录、拖时间；基准不用模型的 `HEAD`，是因为它能改记录。
 *
 * ## 提交不执行工作区里能被模型改的任何东西
 *
 * 工作区和它的 `.git/` 都在模型手里：它能往 `.git/hooks/` 放脚本，能改 `.git/config`（`core.hooksPath`、`core.fsmonitor`、
 * `filter.<名>.clean`、`diff.<名>.textconv`、`diff.external`、`gpg.program`、`include.path`、`includeIf`、`remote.<名>.uploadpack`……），
 * 能写 `.gitattributes` 和 `.git/info/attributes`，能在工作区里放子模块、嵌套仓库（它们自己的配置和属性也是它写的），能改索引
 * （`skip-worktree`、`assume-unchanged`、`gitlink`）。普通的 `git add -A && git commit` 会执行其中好几样，所以提交的做法是：
 *
 * 1. **每条 git 命令都在命令上显式关掉**会执行东西的配置（{@link GIT_FLAGS}），不靠仓库里的配置：命令行上的 `-c` 比所有配置文件
 *    （含 `include.path`、`includeIf` 引进来的）都优先。`core.hooksPath=/dev/null` 让所有钩子（含 `reference-transaction`、
 *    `post-index-change`）都找不到（`/dev/null/<钩子名>` 不是文件）；`core.fsmonitor=false`；`gc.auto=0`、`maintenance.auto=false`；
 *    `commit.gpgsign=false`。全局和系统的配置、全局的属性文件也去掉（{@link GIT_ENV}）。`GIT_NO_LAZY_FETCH=1`：仓库是部分克隆
 *    （`extensions.partialClone`）、`HEAD` 指到一个不存在的提交时，git 读这个提交会去「补取」，补取会执行 `remote.<名>.uploadpack`
 *    （或 `ext::` 地址）里写的命令；这个环境变量让它不去取，缺的就是缺的。
 * 2. **暂存不用模型的仓库，也不用模型的索引**：在工作台上新建一个只有平台写过的临时仓库（`mktemp -d` 出来的、名字不可预测的目录，
 *    里面的配置、`info/attributes`、钩子目录都是空的），用它作 `GIT_DIR`，**索引（`GIT_INDEX_FILE`）也是它里面的一个新文件（空的）**，
 *    对象目录（`GIT_OBJECT_DIRECTORY`）指到真的仓库里（新对象写在那里），`GIT_WORK_TREE` 是工作区。暂存（`add -A`）、`write-tree`、
 *    `commit-tree` 全在这个环境里做，读不到模型的 `config` 和 `info/attributes`，也读不到模型的索引。
 *    - 为什么不用模型的索引：索引里有子模块（`gitlink`）时，`add -A` 会进到子模块里看它改没改，子模块自己的 `.git/config` 和
 *      `.git/info/attributes` 里的过滤器、`fsmonitor` 就会执行（`diff.ignoreSubmodules`、`submodule.recurse` 都拦不住）；
 *      索引里的 `skip-worktree`、`assume-unchanged` 位会让改了的文件不进提交（记录少记）。空索引里什么都没有：工作区里的子仓库当作
 *      普通的嵌套仓库，记成一个 `gitlink`，不进去看。
 *    - 代价：每一轮都把工作区里的文件全读一遍、哈希一遍（没有索引里的文件状态可省）：大工作区里 `add -A` 是主要耗时，30 秒的期限不够时
 *      这一轮的改动留给下一轮（sessions.ts）。
 *    - **提交成功之后把临时索引换到真的索引的位置**（见下面「提交之后换索引」）：模型在工作台上接着用 git 时，`git status`、`git commit`、
 *      `git reset --hard` 看到的是平台提交之后的状态。
 *    - 工作区里的 `.gitattributes` 另用 `GIT_ATTR_SOURCE`（空树）绕开，存进去的就是工作区里的字节（不做换行转换、不展开 `$Id$`）。
 *      只把属性来源设成空树**不够**：它只换掉工作区里的 `.gitattributes`，`.git/info/attributes` 照样读（在 git 2.47 上实测），
 *      所以才要上面的临时仓库。`.git/info/exclude` 是数据，用 `core.excludesFile` 指过来照常生效。
 *    只有读 `HEAD`、更新分支（`rev-parse`、`update-ref`）在真的仓库里做：它们不碰属性和过滤器，钩子在命令上关了，
 *    `reference-transaction` 也在内。**更新分支排在最后**：差异和文件统计在分支动之前就取好了，中途失败时仓库里看不出任何变化（只多了
 *    没人引用的对象）。
 * 3. 取差异用 `diff-tree`（树对树，不读工作区的文件内容），带 `--no-ext-diff --no-textconv`：外部 diff 和 textconv 不执行；
 *    也带 `GIT_ATTR_SOURCE`（空树）：工作区里的 `.gitattributes` 写 `* -diff`（再用 `.gitignore` 藏起来）就能让每个文件都显示成二进制，
 *    差异里什么都看不到。
 * 4. **每次暂存之后都显式把根目录的 `.agents/skills` 从索引里拿掉**（助手服务每次拉起 pi 都把 skill 复制进去，不能进用户的仓库），
 *    不靠 `.gitignore`：`.gitignore` 在模型手里，它删了、改了、写了 `!.agents/skills/` 都一样。只管根目录那一个：命令在工作区根目录里
 *    执行，路径是相对根的；节点包里 `sfly init` 放进去的 `<包>/.agents/skills/` 是用户的东西，照常提交。
 *
 * ## 提交之后换索引
 *
 * 暂存用的是临时仓库里的索引，所以平台提交之后真的索引（`.git/index`）还是旧的：`HEAD` 已经是平台的提交、索引里却没有它的内容，模型
 * 接着在工作台上 `git status` 会看到上一轮的改动像是没暂存，不带 `git add` 的 `git commit` 会提交一个把文件都删掉的提交，`git reset --hard`
 * 删不掉它没暂存过的文件（「`reset --hard` 退回去，这一轮记成删掉」靠这一步）。所以 **`update-ref` 成功之后**，把临时索引复制到真的索引
 * 旁边的一个新名字（名字里有随机串），再 `mv -f` 换到真的索引的位置（同一个目录里的重命名，读的人不会读到写了一半的）。这两条命令不是
 * git 命令：没有钩子（`post-index-change` 不会跑），不读任何仓库配置。**换不成不影响这次提交**：提交和 `update-ref` 已经做完了，
 * 结果照常返回，换索引的失败写在 {@link CommitOutcome.indexError}（调用方记日志），模型那边的索引留着旧的，和不换时一样。
 * 真的索引的位置（`.git/index`）是符号链接时，`mv` 换掉的是链接本身，不写到它指向的地方；指到目录的符号链接（`mv` 当成「移进目录」）、
 * `.git` 是 `gitdir:` 文件时写到哪里，和模型自己的权限相同，防不了。
 *
 * ## 记什么：基准是平台自己上次记下的提交
 *
 * 一轮的记录是「这一轮的树」和「平台上次记下的树」之差，**不是**和 `HEAD` 比：模型自己 `git commit`、`git reset --hard`、改写历史之后，
 * `HEAD` 已经不是平台上次看到的样子，和它比就会把改动记丢（模型只要自己提交一下，这一轮在时间线上就是空的）。平台上次记下的提交号由
 * 调用方按工作区（工作台地址加路径）存在助手服务自己的数据目录里（{@link CommitInput.recorded}，不放工作台上：那里模型能改），
 * 每次提交成功后换成新的（{@link CommitOutcome.recorded}）。
 * - 这一轮的树等于上次记下的树：没有改动，不提交、不发事件。
 * - 不等：做一个提交，**父提交是当前的 `HEAD`**（模型的历史接着往下；模型已经把改动都提交了时，这是一个空提交，只记这一轮），
 *   事件里的文件统计和差异是「上次记下的树 → 这一轮的树」。
 * - 从没记过（第一轮、助手服务的数据目录丢了）或记的提交读不出来（模型 `gc`、删了对象、对象被写坏：读它的提交、它的树、或者取差异要读的
 *   文件对象时出错）：退回和 `HEAD` 比，
 *   差异开头加一行说明（{@link CommitResult.note}：事件的契约里没有放这件事的字段，不改契约）。
 *
 * 没做到的：
 * - 模型在提交进行的同时还有进程在往 `.git/` 里写（它起的后台进程，包括脱离进程组的：`setsid`）时，上面的「读不到」不保证；
 *   提交不会在命令结束之后还被什么执行。
 * - 平台用的 `git`、`mktemp`、`rm`、`cp`、`mv` 是工作台 `PATH` 上找到的那几个：Agent 以 root 运行、或 `PATH` 里有模型能写的目录时，模型能换掉它们。
 *   这和模型本来就有的权限一样，防不了。
 * - `.git/logs/HEAD` 是符号链接、`.git` 是一个 `gitdir:` 文件（指到别处）时，平台更新分支、换索引会写到那个地方：同样是模型自己的权限。
 * - 模型存心毁掉平台的记录：先自己提交全部改动，再改写历史并清掉平台上次记下的提交对象，这一轮会退回和 `HEAD` 比、记成没有改动
 *   （上面第三种）；`HEAD` 指到不存在的提交时平台提交不成（记日志、不发事件，每一轮都再试）。要防这些得把记录放到模型够不着的地方（#752 起）。
 * - 经过滤器管理的文件（git-lfs 一类）按工作区里的原样提交，不经过滤器。
 * - 提交进行中平台被放弃（期限到了、助手服务退出）：这一轮照常结束，`update-ref` 可能已经在工作台上做了、事件没发出去（换索引
 *   也可能没做，模型那边的索引是旧的）；这一轮的提交做成了、但这一轮已经结束（晚到的事件被丢）。这几个窗口很小，不处理（记日志）。
 *
 * 连不上工作台、git 不在、仓库坏了：抛 {@link WorkspaceError} 或工作台的错误，由调用方记日志；这一轮照常结束，留给下一轮开始前再试
 * （sessions.ts）。
 */

/** 平台自己的提交身份：初次提交的作者、每个提交的提交者。 */
export const PLATFORM_IDENTITY = { name: "sfly", email: "noreply@sfly.invalid" } as const;

/** 初次提交的说明。 */
export const INITIAL_COMMIT_MESSAGE = "初始化工作区";

/** 写进 `.gitignore` 的行（至少这些：uv 把虚拟环境建在节点包目录里，不忽略就会被提交）。 */
export const GITIGNORE_LINES = ["/.agents/skills/", ".venv/", "__pycache__/", "dist/"] as const;

/** 暂存时显式排除的路径：不靠 `.gitignore`。命令在工作区根目录里执行，这是相对根的路径：只管根目录那一个。 */
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
	// 缺的对象就是缺的，不去「补取」：补取会执行 `.git/config` 里 `remote.<名>.uploadpack`（见文件头）。
	GIT_NO_LAZY_FETCH: "1",
};

/** 一条 git 命令最长等多久（整个提交另有自己的期限）。 */
const STEP_TIMEOUT_MS = 60_000;

/** 临时仓库的位置：工作台上 `/tmp` 一定在、谁都能写。 */
const SCRATCH_TEMPLATE = "/tmp/sfly-commit.XXXXXXXX";
const SCRATCH_PREFIX = "/tmp/sfly-commit.";

/**
 * 删临时仓库最多等多久：提交还在期限内时是这么久（也不超过提交的期限）；提交已经被放弃（期限到了、助手服务退出）时只给很短的一下，
 * 不等工作台（它可能已经不回话了），留在 `/tmp` 里的小目录以后再清。用真实的时间：放弃的那一刻时钟的约定不适用。
 */
const CLEANUP_MS = 10_000;
const ABANDONED_CLEANUP_MS = 500;

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
	/**
	 * 平台上次在这个工作区记下的提交号（调用方按工作区存，见文件头「记什么」）：这一轮的树和它的树比。
	 * 没有记过传 undefined，退回和 `HEAD` 比。
	 */
	recorded?: string;
}

/** 一个提交的结果：{@link commitEventBody} 把它做成事件。 */
export interface CommitResult {
	hash: string;
	files: CommitFile[];
	/** 差异的开头一段：最多上限加 `diffExtraBytes` 字节。 */
	diff: Buffer;
	/** 差异就是全部（没有被截在读的时候）。 */
	diffComplete: boolean;
	/** 差异是和 `HEAD` 比的（不是和平台上次记下的）时，开头要写的一行说明（平台自己的话，不含模型的东西）。 */
	note?: string;
}

/** {@link commitChanges} 的结果。 */
export interface CommitOutcome {
	/** 这一轮的提交；没有改动是 undefined（什么也没留下）。 */
	result: CommitResult | undefined;
	/**
	 * 之后平台记下的提交号（下一轮的基准）：提交了是新的提交；没有改动时是原来记的；没有记过（或记的读不出来）时是 `HEAD`
	 * （没有改动，`HEAD` 的树就是这一轮的树）。
	 */
	recorded: string | undefined;
	/** 提交成功之后把临时索引换到真的索引的位置没做成：原因（给日志）。做成了、或者没有提交时 undefined。 */
	indexError?: string;
}

interface Repository {
	gitDir: string;
	objects: string;
	exclude: string;
	/** 真的索引的位置（提交之后临时索引换到这里）。 */
	index: string;
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
			"info/exclude",
			"--git-path",
			"index",
		],
		cwd: workdir,
		// 不往上找：工作区之上的目录里有仓库也不算。
		env: { GIT_CEILING_DIRECTORIES: posix.dirname(workdir) },
		signal,
	});
	if (result.code === 0) {
		const [gitDir, objects, exclude, index] = result.stdout.toString("utf8").split("\n");
		if (!gitDir || !objects || !exclude || !index) {
			throw new WorkspaceError("git rev-parse 的输出认不出来");
		}
		const at = (path: string) => posix.resolve(workdir, path);
		return { gitDir, objects: at(objects), exclude: at(exclude), index: at(index) };
	}
	if (/not a git repository/i.test(result.stderr)) return undefined;
	must(result, "git rev-parse");
	return undefined;
}

/**
 * 工作区是 git 仓库：不是就 `git init`（分支 `main`，不带模板：没有示例钩子）、写 `.gitignore`，连同已有的文件做初次提交
 * （「初始化工作区」，作者是平台，不含 `.agents/skills`），`created` 为 true，`recorded` 是初次提交的提交号（调用方记下它当基准）；
 * 已经是仓库 `created` 为 false，什么也不动。初次提交不发 `platform` 事件（由调用方决定，这里只管做）。
 */
export async function ensureRepository(
	agent: WorkspaceAgent,
	workdir: string,
	options: { signal?: AbortSignal } = {},
): Promise<{ created: boolean; recorded: string | undefined }> {
	const { signal } = options;
	if (await findRepository(agent, workdir, signal)) return { created: false, recorded: undefined };
	must(
		await git(agent, {
			args: ["init", "-q", "--template=", "--initial-branch=main"],
			cwd: workdir,
			signal,
		}),
		"git init",
	);
	await writeGitignore(agent, workdir, signal);
	const { recorded } = await commitChanges(agent, workdir, {
		message: INITIAL_COMMIT_MESSAGE,
		author: PLATFORM_IDENTITY,
		signal,
		summary: false,
	});
	return { created: true, recorded };
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

/** 提交号的样子（认过才拼进命令行）。 */
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * 把工作区里的全部改动（根目录的 `.agents/skills` 除外）提交到当前分支；没有改动 `result` 是 undefined，什么也没留下（提交对象、分支都不变）。
 * 记什么、怎么做、为什么这样做见文件头。工作区不是仓库时抛 {@link WorkspaceError}（先 {@link ensureRepository}）。
 */
export async function commitChanges(
	agent: WorkspaceAgent,
	workdir: string,
	input: CommitInput,
): Promise<CommitOutcome> {
	const { signal } = input;
	const repo = await findRepository(agent, workdir, signal);
	if (!repo) throw new WorkspaceError("工作区不是 git 仓库");
	const scratch = await makeScratch(agent, signal);
	try {
		// 临时仓库当 GIT_DIR，对象目录是真的仓库里的，工作区是工作区；索引是临时仓库里的新文件（空的，不读模型的索引）。
		const objects = { GIT_DIR: scratch, GIT_OBJECT_DIRECTORY: repo.objects };
		const stage = {
			...objects,
			GIT_WORK_TREE: workdir,
			GIT_INDEX_FILE: posix.join(scratch, "index"),
			// 工作区里的 .gitignore 照常生效；.git/info/exclude 经 core.excludesFile 指过来。
			GIT_ATTR_SOURCE: EMPTY_TREE,
		};
		// 取差异也不读工作区里的 .gitattributes（`* -diff` 会让每个文件都显示成二进制）。
		const compare = { ...objects, GIT_ATTR_SOURCE: EMPTY_TREE };
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

		// 基准：平台上次记下的提交的树；没记过、读不出来就退回 HEAD 的树。
		const recordedTree = await treeOf(run, objects, input.recorded);
		const headTree = parent
			? must(await run(["rev-parse", `${parent}^{tree}`], objects), "git rev-parse")
					.toString("utf8")
					.trim()
			: EMPTY_TREE;
		const baseTree = recordedTree ?? headTree;
		if (tree === baseTree) {
			return { result: undefined, recorded: recordedTree ? input.recorded : parent };
		}
		let note = recordedTree ? undefined : fallbackNote(input.recorded, parent);

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
		if (!OBJECT_ID.test(hash)) throw new WorkspaceError("git commit-tree 的输出认不出来");

		let files: CommitFile[] = [];
		let diff: Buffer = Buffer.alloc(0);
		let diffComplete = true;
		if (input.summary !== false) {
			const limit = SESSION_EVENT_LIMITS.commitDiffBytes + (input.diffExtraBytes ?? 0);
			const summarize = async (base: string) => {
				const show = ["diff-tree", "-r", "--no-renames"];
				const numstat = await run(
					[...show, "--numstat", "-z", "--no-ext-diff", "--no-textconv", base, tree],
					compare,
					NUMSTAT_LIMIT_BYTES,
				);
				const changed = parseNumstat(must(numstat, "git diff-tree"), numstat.cut);
				const patch = await run(
					[...show, "-p", "--no-color", "--no-ext-diff", "--no-textconv", base, tree],
					compare,
					limit + 1,
				);
				must(patch, "git diff-tree");
				return {
					files: changed,
					diff: patch.stdout.subarray(0, limit),
					complete: patch.stdout.length <= limit && !patch.cut,
				};
			};
			let summary: Awaited<ReturnType<typeof summarize>>;
			try {
				summary = await summarize(baseTree);
			} catch (error) {
				// 平台上次记下的提交的树在、但取差异要读的对象不在或被写坏了（git 退出码非零）：和「记下的提交读不出来」一样退回和 HEAD 比，
				// 不能让每一轮都为这个失败下去。别的错（工作台不回话、被放弃）不在这里处理。
				if (!(error instanceof WorkspaceError) || !recordedTree) throw error;
				note = fallbackNote(input.recorded, parent);
				summary = await summarize(headTree);
			}
			files = summary.files;
			diff = summary.diff;
			diffComplete = summary.complete;
		}

		// 分支最后动：上面任何一步失败，仓库里只多了没人引用的对象。
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
		// 提交已经做成：换索引没做成也不抛，结果照常返回（见文件头「提交之后换索引」）。
		const indexError = await swapIndex(agent, posix.join(scratch, "index"), repo.index, signal);
		return {
			result: { hash, files, diff, diffComplete, note },
			recorded: hash,
			...(indexError !== undefined && { indexError }),
		};
	} finally {
		await removeScratch(agent, scratch, signal);
	}
}

/**
 * 平台上次记下的提交的树的对象号；没记过、读不出来（提交不在、对象被写坏：`rev-parse` 退出码非零，任何一种）时 undefined。
 * 只读提交本身，不去远端取（`GIT_NO_LAZY_FETCH`）：缺的对象就是缺的。树里的对象在不在，取差异时才知道（见 {@link commitChanges}）。
 */
async function treeOf(
	run: (args: string[], env: Record<string, string>) => Promise<GitResult>,
	objects: Record<string, string>,
	recorded: string | undefined,
): Promise<string | undefined> {
	if (!recorded || !OBJECT_ID.test(recorded)) return undefined;
	const found = await run(["rev-parse", "-q", "--verify", `${recorded}^{tree}`], objects);
	if (found.code !== 0) return undefined;
	const tree = found.stdout.toString("utf8").trim();
	return OBJECT_ID.test(tree) ? tree : undefined;
}

/**
 * 提交成功之后把临时索引换到真的索引的位置：复制到真的索引旁边的一个新名字（有随机串）、再 `mv -f` 换上去。不是 git 命令：
 * 没有钩子，不读仓库配置。返回 undefined 是换成了；没换成返回原因（给日志），临时的副本尽量删掉。
 */
async function swapIndex(
	agent: WorkspaceAgent,
	from: string,
	to: string,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	const copy = `${to}.sfly-${randomBytes(6).toString("hex")}`;
	try {
		for (const argv of [
			["cp", from, copy],
			["mv", "-f", copy, to],
		]) {
			const done = await execute(agent, argv, { cwd: "/", signal });
			if (done.code !== 0) {
				const detail = done.stderr.trim().slice(0, 300);
				throw new WorkspaceError(
					`${argv[0]} 失败（退出码 ${done.code}）${detail ? `：${detail}` : ""}`,
				);
			}
		}
		return undefined;
	} catch (error) {
		try {
			await execute(agent, ["rm", "-f", copy], {
				cwd: "/",
				signal: AbortSignal.timeout(ABANDONED_CLEANUP_MS),
			});
		} catch {
			// 连不上工作台：留着一个小文件。
		}
		return error instanceof Error ? error.message : String(error);
	}
}

/** 基准退回到 `HEAD` 时差异开头那一行：平台自己的话，说明这份差异是和什么比的。 */
function fallbackNote(recorded: string | undefined, head: string | undefined): string {
	const against = head ? `仓库当前提交（${head.slice(0, 7)}）` : "空仓库";
	const why = recorded
		? "平台上次记下的提交读不出来（对象不在或已损坏）"
		: "平台还没有记过这个工作区的提交";
	return `（${why}，下面是和${against}的差异）\n`;
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
		await removeScratch(agent, path, signal);
		throw error;
	}
	return path;
}

/**
 * 删临时仓库：不管这次提交有没有成都要做，出错不抛（只是在工作台的 /tmp 里多留一个小目录）。提交的期限（`signal`）还没到时算在期限里；
 * 已经到了（提交被放弃）就只给 {@link ABANDONED_CLEANUP_MS} 那么一下，不等工作台回话。
 */
async function removeScratch(
	agent: WorkspaceAgent,
	path: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (!path.startsWith(SCRATCH_PREFIX)) return;
	const within = AbortSignal.timeout(CLEANUP_MS);
	const budget =
		signal && !signal.aborted
			? AbortSignal.any([signal, within])
			: AbortSignal.timeout(ABANDONED_CLEANUP_MS);
	try {
		await execute(agent, ["rm", "-rf", path], { cwd: "/", signal: budget });
	} catch {
		// 连不上工作台、等不到：留着，下次工作台上清 /tmp 时一起清。
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
	// 开头的说明是平台自己写的（不含模型的东西，不用打码），占上限里的几个字节。
	const note = result.note ?? "";
	const limit = SESSION_EVENT_LIMITS.commitDiffBytes - Buffer.byteLength(note);
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
		diff: note + kept.toString("utf8"),
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
