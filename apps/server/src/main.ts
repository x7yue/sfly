// 控制面入口。配置全部来自环境变量：
//   DATABASE_URL     PostgreSQL 连接串（默认 postgres://sfly:sfly@127.0.0.1:5432/sfly；空串当作没设置）。启动时用连接库（pg）
//                    自己解析连接串的函数检查，只拒它也解析不了的：Unix 套接字的写法（postgres://用户:密码@/库名?host=/var/run/postgresql）也行；
//                    带 @ 而没有 ://（用户:密码@主机/库名）也拒绝：连接库不会把它当地址，而是把整串当库名
//   SFLY_DATA_DIR    数据目录：节点包文件、任务日志、产物等（默认 ./data；空串当作没设置）。启动时检查（#651）：写成地址（带 ://）、
//                    ~ 开头的不合法（环境变量里的 ~ 没有人展开；写绝对路径）；目录要写得了（不存在就建，里面试写一个文件，下面已有的
//                    logs、artifacts、packages 各试写一次），写不了的写明目录（完整的路径：这是「不回显填的值」的一个写明的例外，
//                    见下面的 echo.ts）、原因、当前用户和怎么改，退出码 1
//   SFLY_HTTP_HOST   HTTP API 监听地址（默认 0.0.0.0；只认 IP 地址或主机名，写错了启动失败，说明不回显填的值，#651）。
//                    检查认的写法监听时仍可能失败（解析不了、本机没有这个地址）：说明只有变量名、端口、错误码，也不带地址
//   SFLY_HTTP_PORT   HTTP API 端口（默认 8080）
//   SFLY_GRPC_HOST   Agent 网关监听地址（默认 0.0.0.0；写法同上）
//   SFLY_GRPC_PORT   Agent 网关端口（默认 50051）
//   SFLY_AGENT_TOKEN Agent 共享注册令牌（可选；设置后令牌不对的 Agent 被拒绝）
//   SFLY_PUBLIC_URL  HTTP API 对 Agent 可见的地址，Agent 从这里下载节点包；也用来拼运行通知卡片里
//                    「查看运行」的链接（没有配置时卡片没有按钮）
//                    （可选；默认取监听地址，监听 0.0.0.0 时用本机主机名）。要写成带协议和主机的 http 或 https 地址
//                    （https://sfly.example.com，路径前缀可以，不带用户名密码、? 和 #），写错了启动失败（#619）
//   SFLY_PUBLIC_GRPC_URL Agent 网关对 Agent 可见的地址，install.sh 写进 agent.env
//                    （可选；默认取 SFLY_PUBLIC_URL 的主机名加 Agent 网关的端口，启动时就算好）。写法同上，另外不带路径
//   SFLY_PYPI_MIRROR PyPI 镜像（简单索引地址，例如 https://mirrors.ustc.edu.cn/pypi/simple），
//                    下发给 Agent 安装节点包依赖（可选；未设置时 Agent 用 uv 自己的配置，ADR 0012）
//   SFLY_GITHUB_RELEASE_MIRROR GitHub Release 镜像（例如 https://mirrors.ustc.edu.cn/github-release），
//                    下发给 Agent 安装 uv、下载 Python（可选；未设置时 Agent 用 uv 的官方来源）
//                    两个镜像都要写成 http 或 https 地址，没写协议启动失败；uv 认的 file:// 地址也行，PyPI 镜像还认绝对路径
//   SFLY_RETENTION_DAYS   日志和产物的保留天数（默认 30，大于 0、最大 36500），运行结束超过这么久后自动清理；
//                    不想清理就填 36500（约 100 年），没有别的「永不清理」的写法
//   SFLY_METRIC_RETENTION_DAYS 指标的保留天数（默认 30，大于 0、最大 36500），整天超过保留期的指标分区自动删除
//   SFLY_LOG_LIMIT_MB     单个任务日志的上限（默认 200），超出部分截断
//   SFLY_ARTIFACT_LIMIT_MB 单个任务产物的总大小上限（默认 1024），随任务下发给 Agent（#477）
//   SFLY_METRIC_LIMIT_MB  单个任务指标数据的上限（默认 50，按点数折算），超出后停止写入
//                    三个上限都是 MB（可以带小数），换算成字节后要在 1 到 2^53 − 1 之间
//   数值类的变量都在启动时检查：不是数、不是有限的数、超出范围的，写明变量名、填的原文和范围，一次报完，不启动（#577）；
//   端口（SFLY_HTTP_PORT、SFLY_GRPC_PORT）是 0 到 65535 的整数，0 让系统选一个空闲端口。
//   字符串类的变量也在启动时和它们一起检查（#619、#651）：SFLY_TRUST_PROXY、SFLY_CORS_ORIGINS、SFLY_DEV_ORIGINS、
//   SFLY_ADMIN_LOGIN 和 SFLY_ADMIN_PASSWORD（要一起给）、SFLY_PUBLIC_URL、SFLY_PUBLIC_GRPC_URL、DATABASE_URL、
//   SFLY_PYPI_MIRROR、SFLY_GITHUB_RELEASE_MIRROR、SFLY_DATA_DIR、SFLY_HTTP_HOST、SFLY_GRPC_HOST。
//   报错里不出现密码、密钥和地址里的凭据：回显填的值只经过 src/config/echo.ts，只有数值类回显（最多 12 个字符），地址、名单、代理、
//   数据库地址、密码、监听地址一律不回显（数据目录的路径是写明的例外，见 echo.ts）；报错的顺序是读的顺序（稳定）。
//   哪些检查、哪些留给第一次用到，见 docs/ARCHITECTURE.md「启动时检查哪些环境变量」
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
//                    哪台 Agent 是项目的工作台不是环境变量：项目管理员用 PUT /projects/:project/workbench 登记（存在库里，#549）
//   SFLY_FIREWALL_PROBES 每台工作台的出网名单容器上探测服务的地址（可选，#498）：「工作台的 Agent 名=主机:端口」，空格分隔，
//                    compose 里是 workbench=sfly-workbench:47124。说的是出网名单容器在哪，不是哪台 Agent 是工作台；
//                    没有配置的工作台，助手页写「没有测成」
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
import { runResetPassword } from "./auth/reset-password-cli.js";
import { dataDirFromEnv, dataDirProblems } from "./config/data-dir.js";
import { type EnvSettings, EnvSettingsError, readEnvSettings } from "./config/env-settings.js";
import { databaseUrlFromEnv } from "./config/url-setting.js";
import { type ControlPlane, startControlPlane } from "./control-plane.js";
import { defaultMigrationsDir } from "./db/database.js";
import { installProcessGuards } from "./process-guards.js";
import { VaultKeyError } from "./secrets/vault-key.js";
import { installShutdown } from "./shutdown.js";
import { ListenError } from "./util/listen-error.js";
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
	// 读 DATABASE_URL 和控制面用的是同一个函数（去前后空白、空串当作没设置、pg 解析不了的拒绝，说明里没有填的值）。
	const databaseUrl = (() => {
		try {
			return databaseUrlFromEnv(env.DATABASE_URL);
		} catch (error) {
			// 说明是固定的文字（没有填的值），只写 message：没有堆栈。
			printError(`sfly: ${(error as Error).message}`);
			process.exit(1);
		}
	})();
	const code = await runResetPassword(process.argv.slice(3), {
		databaseUrl,
		stdin: process.stdin,
		stdinIsTty: process.stdin.isTTY === true,
		...terminalStreams(),
	});
	process.exit(code);
}
// 数值类的环境变量（端口、保留天数、各种上限、登录的空闲期限，#577）和字符串类的（代理信任、跨域来源、初始管理员、对外地址、
// 数据库地址、镜像地址，#619；监听地址、数据目录，#651）在启动时就检查：不合法的写明变量名和要求，一次报完，不启动，不留到运行时才
// 出错。数据目录还要试写一次（目录写不了：Docker 卷的属主不对最常见）：这是 readEnvSettings 之外碰文件系统的检查（readEnvSettings
// 里数据库地址交给连接库解析时也会读 sslcert 等指的文件），在这里读完环境变量之后做，结果和环境变量的问题一起报；它在控制面的任何
// 启动动作之前（包括启动时清理上传的临时文件）：先看写不写得了，再清。
const { httpPort, grpcPort, httpHost, grpcHost, ...settings } =
	await (async (): Promise<EnvSettings> => {
		const problems: string[] = [];
		let read: EnvSettings | undefined;
		try {
			read = readEnvSettings(env);
		} catch (error) {
			if (!(error instanceof EnvSettingsError)) throw error;
			problems.push(...error.problems);
		}
		const envProblems = problems.length;
		// 数据目录写得了吗：别的环境变量写错了也照样试（一次报完）；数据目录自己写成地址的不去试（上面已经报了，不碰文件系统）。
		const dataDir = (() => {
			try {
				return dataDirFromEnv(env.SFLY_DATA_DIR);
			} catch {
				return undefined;
			}
		})();
		if (dataDir !== undefined) problems.push(...(await dataDirProblems(dataDir)));
		if (problems.length === 0 && read) return read;
		// 往终端写东西只走统一的出口（lint 规则 no-direct-output 拦着直接用 console）：这些说明只有变量名、要求、目录和当前用户，
		// 没有数据库的参数，也没有填的值（地址类的不回显），拼成字符串交给 printError。
		const subject = problems.length === envProblems ? "环境变量" : "启动检查";
		printError(`sfly: 控制面没有启动，${new EnvSettingsError(problems, subject).message}`);
		process.exit(1);
	})();
const webDir = env.SFLY_WEB_DIR || (existsSync(defaults.webDir) ? defaults.webDir : undefined);
if (!webDir) printWarning(`sfly: ${defaults.webDir} not found, serving the API only (no web app)`);
// 进程级的未捕获异常和未处理的拒绝、借出去的数据库连接出错：记错误日志、有序关闭、退出码 1 退出，由部署的重启策略拉起来
// （#563，docs/ARCHITECTURE.md §6.10）。装在控制面启动之前：启动时（迁移）的连接出错也一样处理；控制面起来之前没有东西可关。
let running: ControlPlane | undefined;
const guards = installProcessGuards({
	shutdown: async () => {
		await running?.close();
	},
});
// 启动失败（写库失败、端口被占……）也走统一的出口：数据库错误里的参数不会随未捕获的异常打到终端上。
const controlPlane = await startControlPlane({
	onFatalDatabaseError: (error) => guards.fatal("数据库连接在使用中断开", error),
	http: { host: httpHost, port: httpPort },
	grpc: { host: grpcHost, port: grpcPort },
	logger: true,
	agentToken: env.SFLY_AGENT_TOKEN || undefined,
	sdkWheelDir: env.SFLY_SDK_DIR || defaults.sdkDir,
	clientPackageDir: env.SFLY_CLIENT_DIR || defaults.clientDir,
	webDir,
	docsDir: env.SFLY_DOCS_DIR || defaults.docsDir,
	agentBinaries: agentBinaries(env.SFLY_AGENT_DIR || defaults.agentDir),
	installScriptFile: defaults.installScriptFile,
	migrationsDir: env.SFLY_MIGRATIONS_DIR || defaults.migrationsDir,
	assistantUrl: env.SFLY_ASSISTANT_URL || undefined,
	assistantSecret: env.SFLY_ASSISTANT_SECRET || undefined,
	workbenchProbes: env.SFLY_FIREWALL_PROBES || undefined,
	// 检查过的设置（保留天数、各种上限、登录的空闲期限、数据库地址、对外地址、跨域来源、初始管理员、代理信任、镜像）：
	// `...settings` 一次传进去，不逐项接线（漏掉一项就是悄悄不生效）。放在最后：前面没有同名的项（有就编译不过），后面也不能再有
	// 把它盖掉的（test/main-env-settings.test.ts 的结构检查守着）。
	...settings,
}).catch((error: unknown) => {
	// 监听失败、钥匙文件对不上：说明只有变量名、端口、文件和错误码，不带监听地址、不打印底层错误的原文（里面有填的值，#651 的审查）。
	if (error instanceof ListenError || error instanceof VaultKeyError)
		printError(`sfly: 控制面没有启动：${error.message}`);
	else printError("sfly: 控制面没有启动：", error);
	process.exit(1);
});
running = controlPlane;

// 停止信号：关闭只做一次，重复的信号只记一句（`src/shutdown.ts`）。和因错误而有序退出（`guards`）是两条都会调用 `close()`、都会退出的
// 路径（`close()` 可以重复调用，拿到同一个结果）：**已经因为致命错误在退出时，退出码一定是 1**，停止信号的关闭先完成也一样，
// 否则按失败才重启的部署不会把它拉起来；停止信号先到、关闭途中又出致命错误的也是 1（见 `process-guards.ts` 文件头）。
installShutdown({
	emitter: process,
	signals: ["SIGINT", "SIGTERM"],
	close: () => controlPlane.close(),
	exit: (code) => process.exit(guards.exiting ? 1 : code),
	log: (message) => printInfo(message),
	logError: (message, error) => printError(message, error),
});
// 启动行放在装好停止信号的处理**之后**：看到这一行（测试、部署脚本、`docker logs`），就表示这个进程收到停止信号会有序关闭。
// 放在前面时，行写出去和处理装上之间有一小段（同一个同步的片段，但进程在这里被调度走了，外面的信号就到得了）：信号按系统默认的
// 动作直接结束进程（#710）。控制面起来之前（迁移、监听端口）收到停止信号仍然是按默认的动作直接结束：那时没有东西可关。
printInfo(
	`sfly control plane ${packageJson.version}: http ${controlPlane.httpUrl}, grpc ${controlPlane.grpcUrl}`,
);
