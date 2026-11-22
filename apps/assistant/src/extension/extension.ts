// 远程工具扩展（#540）：pi 的读、写、编辑、命令四个工具经工作台 Agent 的能力端口执行（ADR 0027「循环在工作台之外」）。
// 从评测集臂 B 的原型（evals/assistant/remote-tools/extension.ts）搬过来，改了两处，各有测试守着：
//
// 1. 不根据工具结果里的文字决定读本机的哪个文件。截断输出的全文只认 pi 在结构化字段里给出的路径
//    （命令工具结果的 `details.fullOutputPath`），并且只接受 pi 自己的临时文件：路径就在临时目录下、带 pi 的前缀，
//    解析成真实路径之后还是它（不经符号链接指到别处）、是普通文件。命令的输出（结果的文字）不影响读哪个文件、读不读。
// 2. 不根据工作台返回的内容在本机写任何文件。这个文件里没有本机的文件写入（测试检查源码）：skill 用镜像里的那份，
//    由助手服务写到工作台上；工作台上的 AGENTS.md 由模型自己用读工具读，不读回本机。
//
// 工作台的地址、命令的环境变量、默认超时每一轮可能不同：每次用到时读助手服务写的这一轮的配置（turn-config.ts）。
// 系统提示里的工作目录和 skill 的位置写成工作台上的路径（#539 第 10 题：扩展在 before_agent_start 里改得了）。

import { readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type EditOperations,
	type ExtensionAPI,
	type ReadOperations,
	type ToolDefinition,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { type AgentClient, asFsError, connectAgent, TimeoutError } from "../agent.js";
import { TURN_CONFIG_ENV } from "../launch-env.js";
import { readTurnConfig, type TurnConfig } from "../turn-config.js";

/** 建目录、查文件这类短命令的超时。 */
const SHORT_TIMEOUT_MS = 30_000;

/** pi 命令工具的临时文件：`<临时目录>/pi-bash-<16 位十六进制>.log`（pi 的 output-files）。 */
const PI_TEMP_FILE = /^pi-bash-[0-9a-f]{16}\.log$/;

export interface ExtensionDeps {
	/** 这一轮的配置（每次用到时读）。 */
	config: () => TurnConfig;
	/** 连到一台 Agent 的能力端口。 */
	connect: (address: string) => AgentClient;
	/** pi 的临时目录（默认系统的临时目录）。 */
	tempDir?: string;
}

/**
 * pi 在结构化字段里给出的截断输出全文的路径，是不是 pi 自己的临时文件：就在临时目录下、带 pi 的前缀，
 * 解析成真实路径之后还在真实的临时目录下、名字不变（不经符号链接指到别处），是普通文件。
 */
export function isPiTempFile(path: unknown, tempDir: string = tmpdir()): path is string {
	if (typeof path !== "string" || !PI_TEMP_FILE.test(basename(path))) return false;
	if (dirname(path) !== tempDir) return false;
	try {
		const real = realpathSync(path);
		return real === join(realpathSync(tempDir), basename(path)) && statSync(real).isFile();
	} catch {
		return false;
	}
}

export function createRemoteTools(pi: ExtensionAPI, deps: ExtensionDeps): void {
	const tempDir = deps.tempDir ?? tmpdir();
	const clients = new Map<string, AgentClient>();
	const agent = (): AgentClient => {
		const { address } = deps.config();
		let client = clients.get(address);
		if (!client) {
			client = deps.connect(address);
			clients.set(address, client);
		}
		return client;
	};
	const { workdir, skills } = deps.config();

	pi.registerTool(
		atWorkdir(createReadToolDefinition(workdir, { operations: readOps(agent) }), workdir),
	);
	pi.registerTool(
		atWorkdir(
			createWriteToolDefinition(workdir, { operations: writeOps(agent, workdir) }),
			workdir,
		),
	);
	pi.registerTool(
		atWorkdir(createEditToolDefinition(workdir, { operations: editOps(agent, workdir) }), workdir),
	);
	// 命令在工作台上执行，环境是这一轮的配置给的：pi 的 PI_* 会话变量不在那边，不让系统提示说「可以看 PI_* 变量」。
	const bash = createBashToolDefinition(workdir, {
		operations: bashOps(agent, deps.config),
		exposeSessionEnvironment: false,
	});
	pi.registerTool({
		...bash,
		async execute(id, params, signal, onUpdate, ctx) {
			const result = await bash.execute(id, params, signal, onUpdate, withCwd(ctx, workdir));
			// 要求 1：只认结构化字段里的路径，只接受 pi 自己的临时文件。
			const path = (result.details as { fullOutputPath?: unknown } | undefined)?.fullOutputPath;
			if (isPiTempFile(path, tempDir)) {
				try {
					await agent().writeFile(path, readFileSync(path));
				} catch {
					// 传不上去时模型读那个路径会得到「文件不存在」，照常往下走。
				}
			}
			return result;
		},
	});

	// 系统提示里写工作台上的路径：工作目录，以及 skill 的位置（模型用读工具读工作台上的那份）。
	pi.on("before_agent_start", async (event) => {
		const options = event.systemPromptOptions;
		options.cwd = workdir;
		for (const skill of options.skills) {
			skill.filePath = onWorkbench(skill.filePath, skills);
			skill.baseDir = onWorkbench(skill.baseDir, skills);
		}
	});
}

/**
 * pi 的工具解析相对路径时先用调用时的 `ctx.cwd`（pi 进程本地的工作目录），没有才用创建时给的：换成工作台上的工作区，
 * 相对路径和命令的工作目录才落在工作台上（#539 第 10 题没测的那一半，这里实测出来的）。
 */
function withCwd<T>(ctx: T, workdir: string): T {
	if (ctx === undefined || ctx === null || typeof ctx !== "object") return ctx;
	return new Proxy(ctx, {
		get: (target, key) => (key === "cwd" ? workdir : Reflect.get(target, key)),
	});
}

// biome-ignore lint/suspicious/noExplicitAny: 工具的参数、结果、渲染状态各不相同，这里只换 ctx。
function atWorkdir<T extends ToolDefinition<any, any, any>>(tool: T, workdir: string): T {
	return {
		...tool,
		execute: (id, params, signal, onUpdate, ctx) =>
			tool.execute(id, params, signal, onUpdate, withCwd(ctx, workdir)),
	};
}

/** 镜像里 skill 目录下的路径换成工作台上同一个位置；不在那个目录下的原样。 */
export function onWorkbench(path: string, skills: TurnConfig["skills"]): string {
	const local = skills.local.replace(/\/+$/, "");
	if (path === local) return skills.workbench;
	if (path.startsWith(`${local}/`)) return skills.workbench + path.slice(local.length);
	return path;
}

function readOps(agent: () => AgentClient): ReadOperations {
	return {
		readFile: async (path) => {
			try {
				return await agent().readFile(path);
			} catch (error) {
				throw asFsError(error, "open", path);
			}
		},
		createReadStream: (path, { signal }) => {
			const chunks = agent().readChunks(path, signal);
			return (async function* () {
				try {
					yield* chunks;
				} catch (error) {
					throw asFsError(error, "open", path);
				}
			})();
		},
		access: async (path) => {
			try {
				await agent().stat(path);
			} catch (error) {
				throw asFsError(error, "access", path);
			}
		},
		detectImageMimeType: async (path) => {
			try {
				const parts: Uint8Array[] = [];
				for await (const chunk of agent().readChunks(path, undefined, 16)) parts.push(chunk);
				return sniffImage(Buffer.concat(parts));
			} catch {
				return null;
			}
		},
	};
}

function sniffImage(head: Buffer): string | null {
	if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return "image/png";
	}
	if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
	if (head.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
	if (
		head.subarray(0, 4).toString("latin1") === "RIFF" &&
		head.subarray(8, 12).toString("latin1") === "WEBP"
	) {
		return "image/webp";
	}
	return null;
}

function writeOps(agent: () => AgentClient, cwd: string): WriteOperations {
	return {
		writeFile: async (path, content) => {
			try {
				await agent().writeFile(path, Buffer.from(content, "utf-8"));
			} catch (error) {
				throw asFsError(error, "open", path);
			}
		},
		// 能力端口没有建目录的接口，写文件又要求父目录已经存在：经命令建（在工作台上）。
		mkdir: async (dir) => {
			const code = await agent().run(["mkdir", "-p", dir], { cwd, timeoutMs: SHORT_TIMEOUT_MS });
			if (code !== 0) throw new Error(`EACCES: mkdir -p '${dir}' 退出码 ${code}`);
		},
	};
}

function editOps(agent: () => AgentClient, cwd: string): EditOperations {
	const read = readOps(agent);
	const write = writeOps(agent, cwd);
	return { readFile: read.readFile, access: read.access, writeFile: write.writeFile };
}

function bashOps(agent: () => AgentClient, config: () => TurnConfig): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			// pi 给的环境（它自己进程的环境）不传过去：命令只带这一轮配置里的环境变量。
			const { env, defaultTimeoutSeconds } = config();
			// 能力端口的命令必须有超时：模型没给时用这一轮的默认值。
			const seconds = timeout ?? defaultTimeoutSeconds;
			try {
				// argv 不经 shell：包一层登录 shell，PATH 和人在工作台上用的一样（~/.local/bin 里的 sfly）。
				// 取消信号传给能力端口的调用，Agent 随之结束命令的整棵进程树。
				const exitCode = await agent().run(["bash", "-lc", command], {
					cwd,
					env,
					timeoutMs: Math.round(seconds * 1000),
					signal,
					onData: (data) => onData(Buffer.from(data)),
				});
				return { exitCode };
			} catch (error) {
				if (error instanceof TimeoutError) {
					// pi 约定的超时格式：命令工具据此写「Command timed out after N seconds」。
					throw new Error(`timeout:${seconds}`);
				}
				throw error;
			}
		},
	};
}

/** pi 加载扩展时调用：配置文件的路径由助手服务经环境变量给出。 */
export default function (pi: ExtensionAPI) {
	const path = process.env[TURN_CONFIG_ENV];
	if (!path) throw new Error(`没有 ${TURN_CONFIG_ENV}：远程工具扩展只能由助手服务拉起的 pi 加载`);
	createRemoteTools(pi, { config: () => readTurnConfig(path), connect: connectAgent });
}
