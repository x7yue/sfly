// 控制面入口。配置全部来自环境变量：
//   DATABASE_URL     PostgreSQL 连接串（默认 postgres://sfly:sfly@127.0.0.1:5432/sfly）
//   SFLY_DATA_DIR    数据目录：节点包文件等（默认 ./data）
//   SFLY_HTTP_HOST   HTTP API 监听地址（默认 0.0.0.0）
//   SFLY_HTTP_PORT   HTTP API 端口（默认 8080）
//   SFLY_GRPC_HOST   Agent 网关监听地址（默认 0.0.0.0）
//   SFLY_GRPC_PORT   Agent 网关端口（默认 50051）
//   SFLY_AGENT_TOKEN Agent 共享注册令牌（可选；设置后令牌不对的 Agent 被拒绝）
//   SFLY_PUBLIC_URL  HTTP API 对 Agent 可见的地址，Agent 从这里下载节点包；也用来拼运行通知卡片里
//                    「查看运行」的链接（没有配置时卡片没有按钮）
//                    （可选；默认取监听地址，监听 0.0.0.0 时用本机主机名）
//   SFLY_PUBLIC_GRPC_URL Agent 网关对 Agent 可见的地址，install.sh 写进 agent.env
//                    （可选；默认取 SFLY_PUBLIC_URL 的主机名加 Agent 网关的端口）
//   SFLY_PYPI_MIRROR PyPI 镜像（简单索引地址，例如 https://mirrors.ustc.edu.cn/pypi/simple），
//                    下发给 Agent 安装节点包依赖（可选；未设置时 Agent 用 uv 自己的配置，ADR 0012）
//   SFLY_GITHUB_RELEASE_MIRROR GitHub Release 镜像（例如 https://mirrors.ustc.edu.cn/github-release），
//                    下发给 Agent 安装 uv、下载 Python（可选；未设置时 Agent 用 uv 的官方来源）
//   SFLY_RETENTION_DAYS   日志和产物的保留天数（默认 30，大于 0、最大 36500），运行结束超过这么久后自动清理；
//                    不想清理就填 36500（约 100 年），没有别的「永不清理」的写法
//   SFLY_METRIC_RETENTION_DAYS 指标的保留天数（默认 30，大于 0、最大 36500），整天超过保留期的指标分区自动删除
//   SFLY_LOG_LIMIT_MB     单个任务日志的上限（默认 200），超出部分截断
//   SFLY_ARTIFACT_LIMIT_MB 单个任务产物的总大小上限（默认 1024），随任务下发给 Agent（#477）
//   SFLY_METRIC_LIMIT_MB  单个任务指标数据的上限（默认 50，按点数折算），超出后停止写入
//                    三个上限都是 MB（可以带小数），换算成字节后要在 1 到 2^53 − 1 之间
//   数值类的变量都在启动时检查：不是数、不是有限的数、超出范围的，写明变量名、填的原文和范围，一次报完，不启动（#577）；
//   端口（SFLY_HTTP_PORT、SFLY_GRPC_PORT）是 0 到 65535 的整数，0 让系统选一个空闲端口
//   SFLY_SDK_DIR     SDK 运行时 wheel 所在目录（默认 apps/server/dist/sdk，由 `pnpm --filter @sfly/server build` 生成）；
//                    Agent 从控制面下载与自身版本一致的 SDK 装进共享 venv
//   SFLY_CLIENT_DIR  API 客户端安装包（@sfly/client 的 tarball）所在目录（默认 apps/server/dist/client，由
//                    `pnpm --filter @sfly/server build` 生成）；控制面提供 GET /client 和同版本安装包的下载（ADR 0022）。
//                    目录不存在时不提供下载，控制面照常启动
//   SFLY_ADMIN_LOGIN、SFLY_ADMIN_PASSWORD 初始管理员的登录名和密码（可选，要一起设置；SFLY_ADMIN_DISPLAY_NAME 是显示名，
//                    默认同登录名）：只在库里没有任何用户时生效，供自动化部署和测试使用。不设置时，没有任何用户就在日志里打印一次性的
//                    初始化码（同时写进数据目录的 setup-code 文件，只有属主可读），用它在 /setup 页建第一个平台管理员（ADR 0029）
//   SFLY_LOGIN_IDLE_HOURS 登录的空闲期限（小时，默认 12，2 分钟到 876000 小时，可以带小数，写 0.0334 或更大）：这么久没有用过的登录
//                    失效，用着就顺延；下限是登录续期间隔（60 秒）的两倍，再短的话一直在用的登录也会过期
//   SFLY_DEV_ORIGINS 开发时也算同源的来源，逗号分隔，例如 http://localhost:3000（vite 开发服务器）：登录 Cookie 的跨站检查用，
//                    生产里不要设置（可选）。同源的判断见 src/auth/cross-site.ts：配置了 SFLY_PUBLIC_URL 时以它为准
//   SFLY_TRUST_PROXY 信任反向代理带来的 X-Forwarded-For，登录限速用它里面的来源地址（可选）。取的是可信代理之前的那个地址
//                    （代理追加在最后的，不是客户端自己写在最左边的）。不设置（空、false、0）：不看这个头，来源地址是 TCP 对端
//                    （在反向代理后面这样配，所有人是同一个来源地址，同一个地址上失败太多次会连累别人）；代理的地址段
//                    127.0.0.1,10.0.0.0/8（推荐：对端在段里才信）；代理的层数 1（或 true）、2……：不管对端是谁都跳过右边这几个
//                    地址，控制面的端口只能经代理访问，层数要和实际一致（配多了会信伪造的地址，配少了所有人落在同一个限速桶里）。
//                    写错了启动失败（src/http/trust-proxy.ts）
//   SFLY_CORS_ORIGINS 允许跨域调用 API 的来源，逗号分隔，例如 https://dash.example.com,http://localhost:5173（可选）。
//                    自建页面托管在别的来源时，浏览器靠它才调得通控制面（ADR 0022）；设置后只有名单里的来源能调用，
//                    没有设置（或写 *）时允许所有来源，不带凭据。控制台自己的页面同源，不受影响
//   SFLY_ASSISTANT_URL 助手服务的地址（http 或 https，可选）。助手默认关闭：地址和密钥都配好了才开，
//                    没开时会话的写接口返回 503 assistant_not_configured，读接口照常（ADR 0027）
//   SFLY_ASSISTANT_SECRET 和助手服务共用的密钥，至少 32 个字符（可选；太短当作没有配置，原因写进日志和就绪状态）
//   SFLY_WORKBENCH_AGENT 哪台 Agent 是工作台，Agent 的名字（可选；没设置时助手开着也建不了会话，503 写明原因）
//   SFLY_WEB_DIR     前端构建产物目录（默认 apps/web/dist，由 `pnpm --filter @sfly/web build` 生成）；
//                    控制面在 HTTP 端口上同时提供页面（ADR 0006）。未设置且默认目录不存在时只提供 API
//   SFLY_MIGRATIONS_DIR 数据库迁移目录（默认 apps/server/drizzle）
//   SFLY_DOCS_DIR    用户文档目录（默认仓库的 docs/guide，ADR 0013），控制面提供 /docs/<页>.md 与 /llms.txt
//   SFLY_AGENT_DIR   提供下载的 Agent 二进制目录，布局为 <架构>/sfly-agent（x86_64、aarch64，ADR 0011）；
//                    默认取仓库的 cargo 构建产物：target/<架构>-unknown-linux-musl/release/sfly-agent，
//                    本机架构没有 musl 构建时依次用 target/release、target/debug 下的 sfly-agent
// 打包成单文件后（scripts/bundle.ts，ADR 0010），上面几个目录的默认值改为 main.mjs 旁边的
// sdk/、client/、web/、drizzle/、docs/、agent/；install.sh 模板是 main.mjs 旁边的 install.sh。
import { existsSync } from "node:fs";
import { arch } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentArch } from "@sfly/schema";
import packageJson from "../package.json" with { type: "json" };
import type { AgentBinaryFiles } from "./agent-binaries/agent-binaries.js";
import { parseInitialAdmin } from "./auth/bootstrap.js";
import { runResetPassword } from "./auth/reset-password-cli.js";
import { EnvSettingsError, readEnvSettings } from "./config/env-settings.js";
import { type ControlPlane, startControlPlane } from "./control-plane.js";
import { defaultMigrationsDir } from "./db/database.js";
import { parseCorsOrigins } from "./http/cors.js";
import { parseTrustProxy } from "./http/trust-proxy.js";
import { installProcessGuards } from "./process-guards.js";
import { printError, printInfo, printWarning, terminalStreams } from "./util/output.js";

/** 打包成单文件时由 esbuild 定义为 true（scripts/bundle.ts）；源码运行时未定义。 */
declare const SFLY_BUNDLED: boolean | undefined;
const bundled = typeof SFLY_BUNDLED !== "undefined" && SFLY_BUNDLED;
const fromHere = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const defaults = bundled
	? {
			webDir: fromHere("./web"),
			sdkDir: fromHere("./sdk"),
			clientDir: fromHere("./client"),
			migrationsDir: fromHere("./drizzle"),
			docsDir: fromHere("./docs"),
			agentDir: fromHere("./agent"),
			installScriptFile: fromHere("./install.sh"),
		}
	: {
			webDir: fromHere("../../web/dist"),
			sdkDir: fromHere("../dist/sdk"),
			clientDir: fromHere("../dist/client"),
			migrationsDir: defaultMigrationsDir,
			docsDir: fromHere("../../../docs/guide"),
			agentDir: undefined,
			installScriptFile: undefined,
		};

const ARCHES: readonly AgentArch[] = ["x86_64", "aarch64"];
const hostArch: AgentArch | undefined = (
	{ x64: "x86_64", arm64: "aarch64" } as Record<string, AgentArch>
)[arch()];
/** 提供下载的 Agent 二进制：目录布局为 <架构>/sfly-agent；开发时取仓库的 cargo 构建产物（见文件头）。 */
const agentBinaries = (dir: string | undefined): AgentBinaryFiles => {
	if (dir) return Object.fromEntries(ARCHES.map((a) => [a, join(dir, a, "sfly-agent")]));
	const target = process.env.CARGO_TARGET_DIR || fromHere("../../../target");
	const files: AgentBinaryFiles = {};
	for (const a of ARCHES) {
		const candidates = [join(target, `${a}-unknown-linux-musl`, "release", "sfly-agent")];
		if (a === hostArch) {
			candidates.push(join(target, "release", "sfly-agent"), join(target, "debug", "sfly-agent"));
		}
		files[a] = candidates.find((file) => existsSync(file)) ?? candidates[0];
	}
	return files;
};

const env = process.env;
// 子命令：`node main.mjs reset-password <登录名>` 重置密码（管理员忘了密码时在控制面所在的主机上执行），不启动控制面。
if (process.argv[2] === "reset-password") {
	const code = await runResetPassword(process.argv.slice(3), {
		databaseUrl: env.DATABASE_URL ?? "postgres://sfly:sfly@127.0.0.1:5432/sfly",
		stdin: process.stdin,
		stdinIsTty: process.stdin.isTTY === true,
		...terminalStreams(),
	});
	process.exit(code);
}
// 数值类的环境变量（端口、保留天数、各种上限、登录的空闲期限）在启动时就检查：不合法的写明变量名、填的原文和允许的范围，
// 一次报完，不启动（#577），不留到运行时才出错。
const { httpPort, grpcPort, ...limits } = (() => {
	try {
		return readEnvSettings(env);
	} catch (error) {
		if (!(error instanceof EnvSettingsError)) throw error;
		// 往终端写东西只走统一的出口（lint 规则 no-direct-output 拦着直接用 console）：这个错误只有变量名、填的原文和范围，
		// 没有数据库的参数，说明拼成字符串交给 printError。
		printError(`sfly: 控制面没有启动，${error.message}`);
		process.exit(1);
	}
})();
const webDir = env.SFLY_WEB_DIR || (existsSync(defaults.webDir) ? defaults.webDir : undefined);
if (!webDir) printWarning(`sfly: ${defaults.webDir} not found, serving the API only (no web app)`);
// 进程级的未捕获异常和未处理的拒绝、借出去的数据库连接出错：记错误日志、有序关闭、退出码 1 退出，由部署的重启策略拉起来
// （#563，docs/ARCHITECTURE.md §6.9）。装在控制面启动之前：启动时（迁移）的连接出错也一样处理；控制面起来之前没有东西可关。
let running: ControlPlane | undefined;
const guards = installProcessGuards({
	shutdown: async () => {
		await running?.close();
	},
});
// 启动失败（写库失败、端口被占……）也走统一的出口：数据库错误里的参数不会随未捕获的异常打到终端上。
const controlPlane = await startControlPlane({
	onFatalDatabaseError: (error) => guards.fatal("数据库连接在使用中断开", error),
	databaseUrl: env.DATABASE_URL ?? "postgres://sfly:sfly@127.0.0.1:5432/sfly",
	dataDir: env.SFLY_DATA_DIR ?? "./data",
	http: { host: env.SFLY_HTTP_HOST ?? "0.0.0.0", port: httpPort },
	grpc: { host: env.SFLY_GRPC_HOST ?? "0.0.0.0", port: grpcPort },
	logger: true,
	agentToken: env.SFLY_AGENT_TOKEN || undefined,
	publicHttpUrl: env.SFLY_PUBLIC_URL || undefined,
	pypiMirror: env.SFLY_PYPI_MIRROR || undefined,
	githubReleaseMirror: env.SFLY_GITHUB_RELEASE_MIRROR || undefined,
	// 保留天数、各种上限、登录的空闲期限：`...limits` 一次传进去，不逐项接线（漏掉一项就是悄悄不生效）。
	...limits,
	sdkWheelDir: env.SFLY_SDK_DIR || defaults.sdkDir,
	clientPackageDir: env.SFLY_CLIENT_DIR || defaults.clientDir,
	webDir,
	corsOrigins: parseCorsOrigins(env.SFLY_CORS_ORIGINS),
	initialAdmin: parseInitialAdmin(env),
	sameOrigins: parseCorsOrigins(env.SFLY_DEV_ORIGINS),
	trustProxy: parseTrustProxy(env.SFLY_TRUST_PROXY),
	docsDir: env.SFLY_DOCS_DIR || defaults.docsDir,
	agentBinaries: agentBinaries(env.SFLY_AGENT_DIR || defaults.agentDir),
	installScriptFile: defaults.installScriptFile,
	publicGrpcUrl: env.SFLY_PUBLIC_GRPC_URL || undefined,
	migrationsDir: env.SFLY_MIGRATIONS_DIR || defaults.migrationsDir,
	assistantUrl: env.SFLY_ASSISTANT_URL || undefined,
	assistantSecret: env.SFLY_ASSISTANT_SECRET || undefined,
	workbenchAgent: env.SFLY_WORKBENCH_AGENT || undefined,
}).catch((error: unknown) => {
	printError("sfly: 控制面没有启动：", error);
	process.exit(1);
});
printInfo(
	`sfly control plane ${packageJson.version}: http ${controlPlane.httpUrl}, grpc ${controlPlane.grpcUrl}`,
);

running = controlPlane;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void controlPlane.close().then(() => process.exit(0));
	});
}
