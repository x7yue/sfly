import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TURN_CONFIG_ENV } from "./launch-env.js";
import { modelEnvRefs } from "./models.js";

/**
 * pi 的启动命令和环境（#540「拉起 pi」，参数照 #539 第 1–4 题的结论）。同一条命令既新建也恢复会话。
 *
 * - `--no-extensions -e <远程工具扩展>`：只加载平台的那一个扩展（#539 第 2 题）；
 * - `--tools read,bash,edit,write`：`grep`、`find`、`ls` 不经扩展，会在助手容器本地执行，不给；
 * - `--no-skills --skill <工作区>/.agents/skills`、`--no-context-files --append-system-prompt <平台说明>`、
 *   `--no-prompt-templates`：系统提示里只有给的东西（#539 第 3 题）；
 * - 设置目录（`PI_CODING_AGENT_DIR`）每次启动新建，里面只有模型文件，不和别的会话共用，进程退出后删掉：
 *   设置目录里的 `SYSTEM.md` 照样会替换整个系统提示，几个开关挡不住（#539 第 3 题），所以不让任何东西有机会放进去；
 *   pi 要写这个目录，所以它可写（#539 第 2 题）；
 * - `--session-dir <会话目录>/pi-session --session-id <会话 ID>`：第一次新建，之后恢复（#539 第 4 题）；
 *   两边路径相同：pi 的工作目录是这一轮的工作区在助手容器里的同名目录（里面只有助手服务复制的 skill），所以系统提示
 *   里写的工作目录、skill 的位置就是工作台上的，扩展不改系统提示（#539 第 10 题只证明了工作目录能改）；
 * - 每个进程自己的临时目录（`TMPDIR`）：命令的完整输出写在这里，一轮结束时清空、进程退出时删掉。
 */

/** pi 的包目录、命令行入口和版本。 */
export function piPackage(): { cli: string; version: string } {
	// 包没有导出 package.json：从入口往上找。
	let dir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
	while (!existsSync(join(dir, "package.json"))) {
		if (dirname(dir) === dir) throw new Error("找不到 pi 的 package.json");
		dir = dirname(dir);
	}
	const manifest = join(dir, "package.json");
	const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { version: string; bin?: unknown };
	const bin = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin as Record<string, string>).pi;
	if (!bin) throw new Error("pi 的 package.json 里没有命令行入口");
	return { cli: join(dirname(manifest), bin), version: pkg.version };
}

/** 平台说明的模板（`--append-system-prompt` 的内容），不含任何从工作台读来的东西。 */
export function platformPrompt(workbench: string, workdir: string): string {
	const template = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "platform-prompt.md"),
		"utf8",
	);
	return template.replaceAll("{{workbench}}", workbench).replaceAll("{{workdir}}", workdir);
}

export interface LaunchPaths {
	/** 这个会话的目录：`<数据目录>/sessions/<会话 ID>`。 */
	sessionDir: string;
	/** pi 的工作目录：这一轮的工作区在助手容器里的同名目录（两边路径相同）。 */
	cwd: string;
	/** `--skill`：`<工作区>/.agents/skills`，助手服务从镜像复制进来的那份。 */
	skillsDir: string;
	/** 打包好的远程工具扩展。 */
	extension: string;
	/** 这一轮交给扩展的配置文件（见 turn-config.ts）。 */
	turnConfig: string;
	/** 平台说明（`--append-system-prompt`）。 */
	contextFile: string;
}

export interface Launch {
	argv: string[];
	env: Record<string, string>;
	cwd: string;
	/** 这次启动新建的设置目录：进程退出后删掉。 */
	agentDir: string;
	/** 这个进程的临时目录（`TMPDIR`）：一轮结束时清空，进程退出后删掉。 */
	tmpDir: string;
}

/**
 * 准备一次启动：新建设置目录和临时目录、复制模型文件，拼出命令和环境。子进程的环境只有 `PATH`、`HOME`、
 * `PI_CODING_AGENT_DIR`、`PI_TELEMETRY=0`、`TMPDIR`、模型文件引用的变量和 {@link TURN_CONFIG_ENV}：
 * 共享密钥和助手服务其余的环境都不给。
 */
export function prepareLaunch(options: {
	sessionId: string;
	paths: LaunchPaths;
	dataDir: string;
	modelsFile: string;
	model: string | undefined;
	piArgv: string[];
	hostEnv: NodeJS.ProcessEnv;
	/** pi 进程的临时目录建在这下面（每个进程一个）。 */
	tmpRoot: string;
}): Launch {
	const { sessionId, paths, hostEnv } = options;
	const agentDir = join(
		options.dataDir,
		"agents",
		`${sessionId}-${randomBytes(4).toString("hex")}`,
	);
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	copyFileSync(options.modelsFile, join(agentDir, "models.json"));
	// 每个进程自己的临时目录：命令的完整输出（pi 的 pi-bash-*.log）写在这里，一轮结束时清空、进程退出时删掉。
	const tmpDir = join(options.tmpRoot, basename(agentDir));
	mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
	const env: Record<string, string> = {
		PATH: hostEnv.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		HOME: agentDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_TELEMETRY: "0",
		TMPDIR: tmpDir,
		[TURN_CONFIG_ENV]: paths.turnConfig,
	};
	for (const name of modelEnvRefs(readFileSync(options.modelsFile, "utf8")).names) {
		// 模型文件引用了助手服务自己的配置（共享密钥等）也不给：它们不是模型的密钥。
		if (name.startsWith("SFLY_ASSISTANT_")) continue;
		const value = hostEnv[name];
		if (value !== undefined) env[name] = value;
	}
	const argv = [
		...options.piArgv,
		"--mode",
		"rpc",
		"--offline",
		"--no-extensions",
		"-e",
		paths.extension,
		"--tools",
		"read,bash,edit,write",
		"--no-approve",
		"--no-skills",
		"--skill",
		paths.skillsDir,
		"--no-context-files",
		"--append-system-prompt",
		paths.contextFile,
		"--no-prompt-templates",
		"--session-dir",
		join(paths.sessionDir, "pi-session"),
		"--session-id",
		sessionId,
		...(options.model ? ["--model", options.model] : []),
	];
	return { argv, env, cwd: paths.cwd, agentDir, tmpDir };
}

/** 写平台说明（每次启动写一次）。 */
export function writeContextFile(path: string, workbench: string, workdir: string): void {
	writeFileSync(path, platformPrompt(workbench, workdir), { mode: 0o600 });
}
