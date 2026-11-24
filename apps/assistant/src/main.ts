import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectAgent } from "./agent.js";
import { EventBus } from "./bus.js";
import { ASSISTANT_PORT, ConfigError, readConfig } from "./config.js";
import { piPackage } from "./launch.js";
import { checkModelsFile } from "./models.js";
import { forLog } from "./redact.js";
import { createAssistantServer } from "./server.js";
import { SessionManager } from "./sessions.js";

/**
 * 助手服务的入口（ADR 0027）：读配置、起 HTTP 服务。镜像里的布局见 scripts/bundle.ts。
 * 本机开发时用 `pnpm --filter @sfly/assistant dev`（先 `build:extension` 打包扩展）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const log = (message: string) => process.stderr.write(`${new Date().toISOString()} ${message}\n`);

/**
 * 兜底：一个没人接的拒绝不该带走所有会话在做的轮（Node 默认结束进程）。记下来、照常跑。这不是修法：往 pi 写命令的地方
 * 都接住了失败（`PiProcess.request` 不拒绝，#677 审查），碰到这一行说明又有一处漏了。
 */
process.on("unhandledRejection", (reason) => {
	const text = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
	log(`没人接的拒绝（已兜住，助手服务照常运行）：${forLog(text, [])}`);
});

function main(): void {
	let config: ReturnType<typeof readConfig>;
	try {
		config = readConfig(process.env);
		for (const warning of checkModelsFile(config.modelsFile, process.env)) log(`提醒：${warning}`);
	} catch (error) {
		if (error instanceof ConfigError) {
			log(`拒绝启动：${error.message}`);
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
		connect: (address, agentLog = log) => connectAgent(address, { log: agentLog }),
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
		modelsFile: config.modelsFile,
		log,
	});
	server.listen(ASSISTANT_PORT, () => log(`助手服务在 :${ASSISTANT_PORT}（pi ${pi.version}）`));
	const stop = () => {
		server.close();
		void sessions.shutdown().then(() => process.exit(0));
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}

main();
