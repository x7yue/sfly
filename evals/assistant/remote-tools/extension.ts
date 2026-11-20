// 对照实验的臂 B（#443）：pi 进程和开发环境分开，读、写、编辑、命令四个内置工具的执行
// 都经能力端口落到开发环境里的 Agent 上。pi 本地只有一个同名的空目录（工作目录的路径两边一样，
// 不用换算），文件和命令都在开发环境里。
//
// 配置（环境变量）：
// - AEVAL_AGENT_ADDR：开发环境 Agent 的能力端口，例如 dev:50052；
// - AEVAL_REMOTE_ENV：命令额外带上的环境变量（JSON 对象）。本地执行时命令继承 pi 的环境，
//   远程执行时继承的是 Agent 的环境，评测要的 SFLY_NICKNAME、AI_AGENT 经它补上；
// - AEVAL_DEFAULT_TIMEOUT：模型没给超时时用的秒数（能力端口要求必须有超时），默认 600；
//   评测里设成会话的时间上限，和本地 pi 没有默认超时的效果一样（见 README.md）；
// - AEVAL_REMOTE_LOG：每次适配（补默认超时、上传截断输出、建父目录……）记一行 JSON 的文件。
//
// 本地和远程的语义差别、做了哪些适配，见同目录的 README.md。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type EditOperations,
	type ExtensionAPI,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { type AgentClient, asFsError, connectAgent, TimeoutError } from "./agent";

const address = process.env.AEVAL_AGENT_ADDR ?? "dev:50052";
const remoteEnv: Record<string, string> = JSON.parse(process.env.AEVAL_REMOTE_ENV ?? "{}");
const defaultTimeout = Number(process.env.AEVAL_DEFAULT_TIMEOUT ?? "600");
const logPath = process.env.AEVAL_REMOTE_LOG;

function note(kind: string, detail: Record<string, unknown> = {}): void {
	if (!logPath) return;
	appendFileSync(logPath, `${JSON.stringify({ ts: Date.now(), kind, ...detail })}\n`);
}

const SHORT_TIMEOUT_MS = 30_000;

function readOps(agent: AgentClient): ReadOperations {
	return {
		readFile: async (path) => {
			try {
				return await agent.readFile(path);
			} catch (error) {
				throw asFsError(error, "open", path);
			}
		},
		createReadStream: (path, { signal }) => {
			const chunks = agent.readChunks(path, signal);
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
				await agent.stat(path);
			} catch (error) {
				throw asFsError(error, "access", path);
			}
		},
		detectImageMimeType: async (path) => {
			try {
				const parts: Uint8Array[] = [];
				for await (const chunk of agent.readChunks(path, undefined, 16)) parts.push(chunk);
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

function writeOps(agent: AgentClient, cwd: string): WriteOperations {
	return {
		writeFile: async (path, content) => {
			try {
				await agent.writeFile(path, Buffer.from(content, "utf-8"));
			} catch (error) {
				throw asFsError(error, "open", path);
			}
		},
		// 能力端口没有建目录的接口，写文件又要求父目录已经存在：经命令建。
		mkdir: async (dir) => {
			note("mkdir_via_exec", { dir });
			const code = await agent.run(["mkdir", "-p", dir], { cwd, timeoutMs: SHORT_TIMEOUT_MS });
			if (code !== 0) throw new Error(`EACCES: mkdir -p '${dir}' 退出码 ${code}`);
		},
	};
}

function editOps(agent: AgentClient, cwd: string): EditOperations {
	const read = readOps(agent);
	const write = writeOps(agent, cwd);
	return { readFile: read.readFile, access: read.access, writeFile: write.writeFile };
}

function bashOps(agent: AgentClient): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			// 能力端口的命令必须有超时；本地 pi 的命令没给超时就一直等。
			const seconds = timeout ?? defaultTimeout;
			if (timeout === undefined) note("default_timeout", { seconds });
			try {
				// argv 不经 shell：包一层 bash。用登录 shell，PATH 和开发环境里人用的一样（~/.local/bin 里的 sfly）；
				// 本地 pi 继承的是启动它的 shell 的环境。
				const exitCode = await agent.run(["bash", "-lc", command], {
					cwd,
					env: remoteEnv,
					timeoutMs: Math.round(seconds * 1000),
					signal,
					onData: (data) => onData(Buffer.from(data)),
				});
				return { exitCode };
			} catch (error) {
				if (error instanceof TimeoutError) {
					note("timeout", { seconds });
					// pi 约定的超时格式：bash 工具据此写「Command timed out after N seconds」。
					throw new Error(`timeout:${seconds}`);
				}
				throw error;
			}
		},
	};
}

const FULL_OUTPUT = /Full output: (\/[^\]\s]+)\]/;

/** 输出被截断时 pi 把全文写在自己本地的临时文件里，并把路径告诉模型：把它原样传到开发环境的同一路径。 */
async function uploadFullOutput(agent: AgentClient, text: string): Promise<void> {
	const path = FULL_OUTPUT.exec(text)?.[1];
	if (!path || !existsSync(path)) return;
	try {
		await agent.writeFile(path, readFileSync(path));
		note("uploaded_full_output", { path });
	} catch (error) {
		note("upload_full_output_failed", { path, error: String(error) });
	}
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (result.content ?? []).map((part) => part.text ?? "").join("\n");
}

/** 把开发环境里节点包目录下的 skill 复制到本地的同一路径，再交给 pi 发现：pi 只在本地找 skill，
 * 系统提示里写的 skill 位置是开发环境里的路径，模型用 read 读的也是开发环境里的那份。 */
async function mirrorSkills(agent: AgentClient, cwd: string): Promise<string[]> {
	const root = join(cwd, ".agents", "skills");
	const chunks: Uint8Array[] = [];
	const code = await agent.run(["find", "-L", root, "-type", "f", "-print0"], {
		cwd,
		timeoutMs: SHORT_TIMEOUT_MS,
		onData: (data, stream) => {
			if (stream === "stdout") chunks.push(data);
		},
	});
	if (code !== 0) return [];
	const files = Buffer.concat(chunks).toString("utf-8").split("\0").filter(Boolean);
	for (const file of files) {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, await agent.readFile(file));
	}
	note("mirrored_skills", { files: files.length });
	return files.length > 0 ? [root] : [];
}

/** 开发环境里工作目录和各级上级目录的 AGENTS.md（没有时 CLAUDE.md）：pi 只在本地找上下文文件。 */
async function remoteContextFiles(agent: AgentClient, cwd: string) {
	const found: Array<{ path: string; content: string }> = [];
	for (let dir = cwd; ; dir = dirname(dir)) {
		for (const name of ["AGENTS.md", "CLAUDE.md"]) {
			const path = join(dir, name);
			try {
				found.unshift({ path, content: (await agent.readFile(path)).toString("utf-8") });
				break;
			} catch {
				// 没有这个文件
			}
		}
		if (dir === dirname(dir)) break;
	}
	return found;
}

export default async function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const agent = connectAgent(address);
	const described = await agent.describe();
	note("connected", { agent: described.name, version: described.agentVersion });
	const skillPaths = await mirrorSkills(agent, cwd);
	const contextFiles = await remoteContextFiles(agent, cwd);

	const read = createReadTool(cwd, { operations: readOps(agent) });
	const write = createWriteTool(cwd, { operations: writeOps(agent, cwd) });
	const edit = createEditTool(cwd, { operations: editOps(agent, cwd) });
	const bash = createBashTool(cwd, { operations: bashOps(agent) });

	pi.registerTool(read);
	pi.registerTool(write);
	pi.registerTool(edit);
	pi.registerTool({
		...bash,
		async execute(id, params, signal, onUpdate, ctx) {
			try {
				const result = await bash.execute(id, params, signal, onUpdate, ctx);
				await uploadFullOutput(agent, textOf(result));
				return result;
			} catch (error) {
				await uploadFullOutput(agent, error instanceof Error ? error.message : String(error));
				throw error;
			}
		},
	});

	pi.on("resources_discover", async () => ({ skillPaths }));

	pi.on("before_agent_start", async (event) => {
		const options = event.systemPromptOptions;
		for (const file of contextFiles) {
			if (!options.contextFiles.some((existing) => existing.path === file.path)) {
				options.contextFiles.push(file);
			}
		}
	});
}
