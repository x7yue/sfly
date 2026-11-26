import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectAgent } from "./agent.js";
import { EventBus } from "./bus.js";
import { ASSISTANT_PORT, ConfigError, readConfig } from "./config.js";
import { piPackage } from "./launch.js";
import { ModelHealth } from "./model-health.js";
import { printError, writeLog, writeRawLog } from "./output.js";
import { createAssistantServer } from "./server.js";
import { SessionManager } from "./sessions.js";

/**
 * 助手服务的入口（ADR 0027）：读配置、起 HTTP 服务。镜像里的布局见 scripts/bundle.ts。
 * 本机开发时用 `pnpm --filter @sfly/assistant dev`（先 `build:extension` 打包扩展）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const log = writeLog;

/**
 * 兜底：一个没人接的拒绝不该带走所有会话在做的轮（Node 默认结束进程）。记下来、照常跑。这不是修法：往 pi 写命令的地方
 * 都接住了失败（`PiProcess.request` 不拒绝，#677 审查），碰到这一行说明又有一处漏了。
 */
process.on("unhandledRejection", (reason) => {
	// 带堆栈（截到上限）：要看出是哪一处漏了接。没有会话可以按值打码，按形状打码（writeRawLog）。
	const text = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
	writeRawLog(`没人接的拒绝（已兜住，助手服务照常运行）：${text}`);
});

function main(): void {
	let config: ReturnType<typeof readConfig>;
	try {
		config = readConfig(process.env);
	} catch (error) {
		if (error instanceof ConfigError) {
			printError("拒绝启动", error);
			process.exit(1);
		}
		throw error;
	}
	const pi = piPackage();
	// 应用目录：本机开发时 main.ts 在 apps/assistant/src/ 下，应用目录是 apps/assistant；镜像里 main.mjs 就在应用目录（/app）下。
	// 打包好的扩展在 dist/ 下；镜像里的 skill 在 skills/ 下，本机开发时没有这个目录，用仓库里的 docs/guide/skills/（是同一份）。
	const appDir = basename(here) === "src" ? dirname(here) : here;
	const bundledSkills = join(appDir, "skills");
	const bus = new EventBus();
	// 模型没有配置时照常启动（#548）：`/health` 报缺什么，新的一轮在开始之前被 503 拒绝。
	const model = new ModelHealth({
		modelsFile: config.modelsFile,
		model: config.model,
		env: process.env,
		log,
	});
	const sessions = new SessionManager({
		dataDir: config.dataDir,
		modelsFile: config.modelsFile,
		model: config.model,
		piArgv: [process.execPath, pi.cli],
		extension: join(appDir, "dist", "extension.mjs"),
		skillsDir: existsSync(bundledSkills)
			? bundledSkills
			: join(appDir, "..", "..", "docs", "guide", "skills"),
		hostEnv: process.env,
		bus,
		modelGate: () => model.gate(),
		// 会话以外用到的工作台客户端（探一下工作台）没有会话可以按值打码：按形状打码、截到上限。
		connect: (address, agentLog = writeRawLog) => connectAgent(address, { log: agentLog }),
		log,
	});
	const version = (
		JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as { version: string }
	).version;
	const server = createAssistantServer({
		secret: config.secret,
		bus,
		sessions,
		versions: { assistant: version, pi: pi.version },
		model: () => model.snapshot(),
		log,
	});
	server.listen(ASSISTANT_PORT, () => {
		log(`助手服务在 :${ASSISTANT_PORT}（pi ${pi.version}）`);
		model.start();
	});
	const stop = () => {
		model.close();
		server.close();
		// shutdown 不该拒绝（结束进程的每一步都接住了失败）；万一拒绝，HTTP 已经关了，不能留着一个不干活的进程：记一行、以 1 退出。
		sessions.shutdown().then(
			() => process.exit(0),
			(error: unknown) => {
				printError("退出时结束会话出错", error);
				process.exit(1);
			},
		);
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}

main();
