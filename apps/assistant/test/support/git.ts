// 测试里用的 git：去掉继承来的 GIT_* 变量，不读全局和系统的配置（CODING_STANDARDS「测试只碰自己建的东西」）。
// 还有「模型布下的陷阱」：钩子、fsmonitor、过滤器、textconv、外部 diff、gpg……每一个都是一个会写标记文件的脚本，
// 平台提交时它们哪个也不该被执行。
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) env[key] = value;
	}
	return {
		...env,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		...extra,
	};
}

/** 在 `cwd` 里运行 git，返回标准输出（出错抛异常）。 */
export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		env: gitEnv(),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/**
 * 给 `git` 加上和平台一样的保险（不执行钩子、fsmonitor），用来在布了陷阱的仓库里**读**历史：测试自己的读命令
 * 不能被陷阱绊到，也不该被算成平台的执行。
 */
export function safeGit(cwd: string, ...args: string[]): string {
	return git(
		cwd,
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"core.fsmonitor=false",
		"-c",
		"core.pager=cat",
		"--no-pager",
		...args,
	);
}

/** 仓库里的提交，新的在前：`<作者> | <提交者> | <说明>`。 */
export function log(cwd: string): string[] {
	const out = safeGit(cwd, "log", "--no-ext-diff", "--format=%an | %cn | %s");
	return out.split("\n").filter(Boolean);
}

export interface Traps {
	/** 触发了的陷阱的名字（标记文件的名字去掉 `.ran`），排好序。 */
	ran(): string[];
	/** 布下的陷阱的名字。 */
	names: string[];
}

/** 一批陷阱共用的标记目录：每个陷阱是一个会在这里留下 `<名字>.ran` 的脚本。 */
function trapKit() {
	const markers = mkdtempSync(join(tmpdir(), "sfly-traps-"));
	const names: string[] = [];
	/** 写一个脚本陷阱；`body` 不给时是「留下标记、原样转发标准输入」（过滤器、textconv 那样的）。 */
	const script = (path: string, name: string, body = "cat\n") => {
		names.push(name);
		writeFileSync(path, `#!/bin/sh\ntouch '${join(markers, `${name}.ran`)}'\n${body}`);
		chmodSync(path, 0o755);
		return path;
	};
	const traps = (): Traps => ({
		names,
		ran: () =>
			readdirSync(markers)
				.filter((name) => name.endsWith(".ran"))
				.map((name) => name.replace(/\.ran$/, ""))
				.sort(),
	});
	return { markers, names, script, traps };
}

/** 模型自己的 git：有身份，不读全局和系统的配置。 */
const asModel = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=m", "-c", "user.email=m@m.invalid", ...args], {
		cwd,
		env: gitEnv(),
		stdio: "ignore",
	});

/** 子模块那一路的陷阱：工作区里的嵌套仓库 `nested-repo`，在父仓库的索引里是 gitlink（模型自己 `git add` 的），里面有一个改过的文件。 */
const NESTED = "nested-repo";

function plantNested(kit: ReturnType<typeof trapKit>, workdir: string): void {
	const sub = join(workdir, NESTED);
	mkdirSync(sub);
	asModel(sub, "init", "-q", "-b", "main");
	writeFileSync(join(sub, "f"), "s\n");
	asModel(sub, "add", "f");
	asModel(sub, "commit", "-q", "-m", "s");
	// 子仓库自己的属性和配置（它在子仓库里，不在父仓库的 .git 里：父仓库的所有防护都够不着，只能不进去看）。
	mkdirSync(join(sub, ".git", "info"), { recursive: true });
	writeFileSync(join(sub, ".git", "info", "attributes"), "* filter=evil\n");
	asModel(
		sub,
		"config",
		"filter.evil.clean",
		kit.script(join(sub, ".git", "filter.sh"), "submodule-filter"),
	);
	asModel(
		sub,
		"config",
		"core.fsmonitor",
		kit.script(join(sub, ".git", "fsmonitor.sh"), "submodule-fsmonitor"),
	);
	// 父仓库的索引里放 gitlink，再把子仓库里的文件改了（文件状态变了，`git add -A` 才会进去看）。
	asModel(workdir, "add", NESTED);
	writeFileSync(join(sub, "f"), "t\n");
	utimesSync(join(sub, "f"), new Date("2001-01-01"), new Date("2001-01-01"));
}

/** 只布子模块那一路（见 {@link plantNested}）：工作区已经是 git 仓库。 */
export function plantSubmodule(workdir: string): Traps {
	const kit = trapKit();
	plantNested(kit, workdir);
	return kit.traps();
}

/**
 * 部分克隆的陷阱：`extensions.partialClone` 加 `remote.origin.uploadpack`（补取缺的对象时 git 会执行它），`HEAD` 指到一个不存在的提交
 * （读它就要补取）。仓库已经是坏的：平台提交不成也没关系，要看的是 uploadpack 没有被执行。
 */
export function plantLazyFetch(workdir: string): Traps {
	const kit = trapKit();
	const gitDir = join(workdir, ".git");
	const upload = kit.script(join(gitDir, "uploadpack.sh"), "lazy-fetch-uploadpack", "exit 1\n");
	asModel(workdir, "config", "core.repositoryformatversion", "1");
	asModel(workdir, "config", "extensions.partialClone", "origin");
	asModel(workdir, "config", "remote.origin.url", workdir);
	asModel(workdir, "config", "remote.origin.promisor", "true");
	asModel(workdir, "config", "remote.origin.uploadpack", upload);
	writeFileSync(join(gitDir, "refs", "heads", "main"), `${"1".repeat(40)}\n`);
	return kit.traps();
}

/**
 * 在一个已经是 git 仓库的 `workdir` 里布下陷阱，写法都是模型能做到的（它在工作台上能写 `.git/` 里的任何东西和工作区里的任何文件）：
 * `.git/hooks/` 里的钩子、`core.hooksPath` 指到别处、`core.fsmonitor`、`filter` 经 `.gitattributes` 和 `.git/info/attributes` 两处引用、
 * `diff.<名>.textconv` 和外部 diff（`diff.external`、`diff.<名>.command`）、`gpg.program` 加 `commit.gpgsign`、`gc.auto`，
 * 同样的配置还放在 `include.path` 和 `includeIf` 引进来的文件里；再加一个嵌套仓库（父索引里有它的 gitlink，它自己配了过滤器和 fsmonitor，
 * 见 {@link plantSubmodule}）。部分克隆那一路另放（{@link plantLazyFetch}）：它让仓库的 `HEAD` 坏掉。
 */
export function plantTraps(workdir: string): Traps {
	const kit = trapKit();
	const { markers, names, script } = kit;
	const gitDir = join(workdir, ".git");
	plantNested(kit, workdir);
	mkdirSync(join(gitDir, "hooks"), { recursive: true });
	for (const hook of [
		"pre-commit",
		"prepare-commit-msg",
		"commit-msg",
		"post-commit",
		"reference-transaction",
		"post-index-change",
		"pre-auto-gc",
		"post-checkout",
		"post-rewrite",
	]) {
		script(join(gitDir, "hooks", hook), `hook-${hook}`);
	}
	const hostile = join(markers, "hostile-hooks");
	mkdirSync(hostile);
	for (const hook of ["pre-commit", "commit-msg", "reference-transaction", "post-commit"]) {
		script(join(hostile, hook), `hooksPath-${hook}`);
	}
	const fsmonitor = script(join(gitDir, "fsmonitor.sh"), "fsmonitor");
	const filter = script(join(gitDir, "filter.sh"), "filter");
	const textconv = script(join(gitDir, "textconv.sh"), "textconv");
	const extdiff = script(join(gitDir, "extdiff.sh"), "extdiff");
	const gpg = script(join(gitDir, "gpg.sh"), "gpg");
	const config = [
		"[core]",
		`\tfsmonitor = ${fsmonitor}`,
		`\thooksPath = ${hostile}`,
		'[filter "evil"]',
		`\tclean = ${filter}`,
		`\tsmudge = ${filter}`,
		`\tprocess = ${filter}`,
		'[diff "evil"]',
		`\ttextconv = ${textconv}`,
		`\tcommand = ${extdiff}`,
		"[diff]",
		`\texternal = ${extdiff}`,
		"[gpg]",
		`\tprogram = ${gpg}`,
		"[commit]",
		"\tgpgsign = true",
		"[gc]",
		"\tauto = 1",
		"",
	].join("\n");
	const included = join(gitDir, "evil.inc");
	writeFileSync(included, config);
	writeFileSync(
		join(gitDir, "config"),
		[
			readFileSync(join(gitDir, "config"), "utf8"),
			`[include]\n\tpath = ${included}\n`,
			`[includeIf "gitdir:${workdir}/"]\n\tpath = ${included}\n`,
			config,
		].join("\n"),
	);
	names.push("include-path");
	writeFileSync(join(workdir, ".gitattributes"), "* filter=evil diff=evil\n");
	mkdirSync(join(gitDir, "info"), { recursive: true });
	writeFileSync(join(gitDir, "info", "attributes"), "* filter=evil diff=evil\n");
	return kit.traps();
}
