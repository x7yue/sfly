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

/**
 * 在一个已经是 git 仓库的 `workdir` 里布下陷阱，写法都是模型能做到的（它在工作台上能写 `.git/` 里的任何东西和工作区里的任何文件）：
 * `.git/hooks/` 里的钩子、`core.hooksPath` 指到别处、`core.fsmonitor`、`filter` 经 `.gitattributes` 和 `.git/info/attributes` 两处引用、
 * `diff.<名>.textconv` 和外部 diff（`diff.external`、`diff.<名>.command`）、`gpg.program` 加 `commit.gpgsign`、`gc.auto`，
 * 同样的配置还放在 `include.path` 和 `includeIf` 引进来的文件里。
 */
export function plantTraps(workdir: string): Traps {
	const markers = mkdtempSync(join(tmpdir(), "sfly-traps-"));
	const gitDir = join(workdir, ".git");
	const names: string[] = [];
	const script = (path: string, name: string) => {
		names.push(name);
		writeFileSync(path, `#!/bin/sh\ntouch '${join(markers, `${name}.ran`)}'\ncat\n`);
		chmodSync(path, 0o755);
		return path;
	};
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
	return {
		names,
		ran: () =>
			readdirSync(markers)
				.filter((name) => name.endsWith(".ran"))
				.map((name) => name.replace(/\.ran$/, ""))
				.sort(),
	};
}
