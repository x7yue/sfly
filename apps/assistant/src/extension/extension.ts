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
// 两边路径相同：pi 在助手容器里和工作台上同一个路径（工作区）下运行，skill 也放在两边同一个位置，所以系统提示里
// 写的工作目录、skill 的位置就是工作台上的，扩展不改系统提示（#539 第 10 题只证明了工作目录能改，skill 的位置和
// 工具的工作目录换不过来）。

import { createReadStream, realpathSync, statSync } from "node:fs";
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
import { Redactor } from "../redact.js";
import { readTurnConfig, type TurnConfig } from "../turn-config.js";

/** 建目录、查文件这类短命令的超时。 */
const SHORT_TIMEOUT_MS = 30_000;

/**
 * 一条命令交给 pi 的输出最多这么多字节（打过码的）：超过的丢掉，结果末尾写明丢了多少。pi 把截断之前的全部输出
 * 写进它的临时文件、扩展再把这个文件传到工作台上，不设上限的话一条输出几百 MB 的命令就能让 pi 的内存和
 * 助手容器的磁盘（所有会话共用）跟着涨。
 */
export const OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024;

/** 这一轮要打码的值（保密的环境变量，会话里到现在为止的都算）。 */
function redactorFor(config: TurnConfig): Redactor {
	const redactor = new Redactor();
	redactor.add(config.secrets ?? []);
	return redactor;
}

/** pi 命令工具的临时文件：`<临时目录>/pi-bash-<16 位十六进制>.log`（pi 的 output-files）。 */
const PI_TEMP_FILE = /^pi-bash-[0-9a-f]{16}\.log$/;

export interface ExtensionDeps {
	/** 这一轮的配置（每次用到时读）。 */
	config: () => TurnConfig;
	/** 连到一台 Agent 的能力端口。 */
	connect: (address: string) => AgentClient;
	/** pi 的临时目录（默认系统的临时目录）。 */
	tempDir?: string;
	/** 建目录这类短命令的超时（默认 {@link SHORT_TIMEOUT_MS}，测试里改短）。 */
	shortTimeoutMs?: number;
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
	const short = deps.shortTimeoutMs ?? SHORT_TIMEOUT_MS;
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
	const { workdir } = deps.config();

	pi.registerTool(
		atWorkdir(
			createWriteToolDefinition(workdir, { operations: writeOps(agent, workdir, short) }),
			workdir,
		),
	);
	// 编辑要读到文件的原样内容再写回去（读到打过码的内容写回去，就把文件里的值换成了 ******）：读的时候不打码，
	// 工具的结果（差异、说明）交给 pi 之前再按值打码。
	pi.registerTool(
		redactedResult(
			atWorkdir(
				createEditToolDefinition(workdir, { operations: editOps(agent, workdir, short) }),
				workdir,
			),
			deps.config,
		),
	);
	// 命令在工作台上执行，环境是这一轮的配置给的：pi 的 PI_* 会话变量不在那边，不让系统提示说「可以看 PI_* 变量」。
	const bash = createBashToolDefinition(workdir, {
		operations: bashOps(agent, deps.config),
		exposeSessionEnvironment: false,
	});
	pi.registerTool(
		atWorkdir(
			createReadToolDefinition(workdir, { operations: readOps(agent, deps.config) }),
			workdir,
		),
	);
	pi.registerTool({
		...bash,
		async execute(id, params, signal, onUpdate, ctx) {
			const result = await bash.execute(id, params, signal, onUpdate, withCwd(ctx, workdir));
			// 要求 1：只认结构化字段里的路径，只接受 pi 自己的临时文件。
			const path = (result.details as { fullOutputPath?: unknown } | undefined)?.fullOutputPath;
			if (isPiTempFile(path, tempDir)) {
				try {
					// 工作台上建同名的父目录（两边路径相同），按块读、按块传，不把整份读进内存
					// （文件里是打过码、不超过 OUTPUT_LIMIT_BYTES 的输出）。
					const code = await agent().run(["mkdir", "-p", dirname(path)], {
						cwd: "/",
						timeoutMs: short,
					});
					if (code === 0) {
						await agent().writeFile(path, createReadStream(path, { highWaterMark: 256 * 1024 }));
					}
				} catch {
					// 传不上去时模型读那个路径会得到「文件不存在」，照常往下走。
				}
			}
			return result;
		},
	});
}

/**
 * pi 的工具解析相对路径时先用调用时的 `ctx.cwd`（pi 进程本地的工作目录），没有才用创建时给的。两边路径相同时
 * 两者一样；这里仍固定成这一轮的工作区，相对路径和命令的工作目录不随 pi 进程本地的目录变。
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

/** 读的两种操作：整份读、按块读，交给 pi 之前都按值打码（导出给测试）。 */
export function readOps(agent: () => AgentClient, config: () => TurnConfig): ReadOperations {
	return {
		// 读到的内容交给 pi 之前就按值打码：pi 的截断、会话文件里都是打过码的。
		readFile: async (path) => {
			try {
				return redactorFor(config()).redactBytes(await agent().readFile(path));
			} catch (error) {
				throw asFsError(error, "open", path);
			}
		},
		createReadStream: (path, { signal }) => {
			const chunks = agent().readChunks(path, signal);
			const redact = redactorFor(config()).byteStream();
			return (async function* () {
				try {
					for await (const chunk of chunks) {
						const out = redact.push(chunk);
						if (out.length > 0) yield out;
					}
					const rest = redact.flush();
					if (rest.length > 0) yield rest;
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
				return sniffImage(await agent().readHead(path, 16));
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

function writeOps(agent: () => AgentClient, cwd: string, short: number): WriteOperations {
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
			const code = await agent().run(["mkdir", "-p", dir], { cwd, timeoutMs: short });
			if (code !== 0) throw new Error(`EACCES: mkdir -p '${dir}' 退出码 ${code}`);
		},
	};
}

function editOps(agent: () => AgentClient, cwd: string, short: number): EditOperations {
	// 读原样的内容（编辑完要写回去），不打码；结果由 redactedResult 打码。
	const read = readOps(agent, () => ({ secrets: [] }) as unknown as TurnConfig);
	const write = writeOps(agent, cwd, short);
	return { readFile: read.readFile, access: read.access, writeFile: write.writeFile };
}

/** 工具的结果交给 pi 之前，里面的字符串都按值打码。 */
// biome-ignore lint/suspicious/noExplicitAny: 工具的参数、结果各不相同，这里只处理结果里的字符串。
function redactedResult<T extends ToolDefinition<any, any, any>>(
	tool: T,
	config: () => TurnConfig,
): T {
	return {
		...tool,
		execute: async (id, params, signal, onUpdate, ctx) =>
			redactorFor(config()).redactValue(await tool.execute(id, params, signal, onUpdate, ctx)),
	};
}

function bashOps(agent: () => AgentClient, config: () => TurnConfig): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			// pi 给的环境（它自己进程的环境）不传过去：命令只带这一轮配置里的环境变量。
			const current = config();
			const { env, defaultTimeoutSeconds } = current;
			// 能力端口的命令必须有超时：模型没给时用这一轮的默认值。
			// 夹在这一轮的用时上限（就是默认值）以内：到了上限这一轮反正要结束，太大的值还会让期限的定时器溢出。
			const seconds = Math.min(timeout ?? defaultTimeoutSeconds, defaultTimeoutSeconds);
			// 输出交给 pi 之前就按值打码（值跨两块也认得出），并且有上限：pi 的截断、临时文件、会话文件里
			// 都是打过码的，也不会先截断、后打码留下半截。
			const redact = redactorFor(current).byteStream();
			let passed = 0;
			let dropped = 0;
			const give = (data: Buffer) => {
				const room = OUTPUT_LIMIT_BYTES - passed;
				if (data.length > room) dropped += data.length - room;
				const taken = data.length > room ? data.subarray(0, room) : data;
				passed += taken.length;
				if (taken.length > 0) onData(taken);
			};
			const finish = () => {
				give(redact.flush());
				if (dropped > 0) {
					onData(
						Buffer.from(
							`\n[输出超过 ${OUTPUT_LIMIT_BYTES / 1024 / 1024} MiB，后面的 ${dropped} 字节丢掉了：` +
								"没有交给模型，也没有保存。要看完整的输出，把它重定向到工作台上的文件再分段读]\n",
						),
					);
				}
			};
			try {
				// argv 不经 shell：包一层登录 shell，PATH 和人在工作台上用的一样（~/.local/bin 里的 sfly）。
				// 取消信号传给能力端口的调用，Agent 随之结束命令的整棵进程树。
				const exitCode = await agent().run(["bash", "-lc", command], {
					cwd,
					env,
					timeoutMs: Math.round(seconds * 1000),
					signal,
					onData: (data) => {
						if (passed >= OUTPUT_LIMIT_BYTES) {
							dropped += data.length;
							return;
						}
						give(redact.push(data));
					},
				});
				finish();
				return { exitCode };
			} catch (error) {
				finish();
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
