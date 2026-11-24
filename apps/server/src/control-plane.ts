import { mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import type { FastifyServerOptions } from "fastify";
import packageJson from "../package.json" with { type: "json" };
import { TaskActions } from "./actions/task-actions.js";
import {
	AgentBinaries,
	type AgentBinaryFiles,
	agentBinaryUrl,
} from "./agent-binaries/agent-binaries.js";
import { loadInstallScript } from "./agent-binaries/install-script.js";
import { AgentAuthenticator } from "./agents/agent-auth.js";
import { AgentCredentialService } from "./agents/agent-credentials.js";
import { createAgentEnvironment } from "./agents/agent-environment.js";
import { AgentHub } from "./agents/agent-hub.js";
import { registerSharedAgentToken } from "./agents/shared-agent-token.js";
import {
	ArtifactStore,
	artifactBaseUrl,
	DEFAULT_ARTIFACT_LIMIT_BYTES,
} from "./artifacts/artifact-store.js";
import { AccountService } from "./auth/accounts.js";
import { bootstrapFirstAdmin, type InitialAdmin } from "./auth/bootstrap.js";
import { LoginThrottle, type LoginThrottleOptions } from "./auth/login-throttle.js";
import type { ScryptParams } from "./auth/password.js";
import { PasswordGate, type PasswordGateOptions } from "./auth/password-gate.js";
import { RevocationBus } from "./auth/revocations.js";
import { SetupCode } from "./auth/setup-code.js";
import { TokenService } from "./auth/tokens.js";
import { type Clock, systemClock } from "./clock.js";
import { EnvSettingsError, numericOptionProblems } from "./config/env-settings.js";
import { gatewayUrlFrom } from "./config/url-setting.js";
import { openDatabase } from "./db/database.js";
import { loadUserDocs } from "./docs/user-docs.js";
import { loadClientTarballs } from "./downloads/client-tarballs.js";
import { createAssignContent } from "./engine/assign-content.js";
import { Engine } from "./engine/engine.js";
import { limitOutputs } from "./engine/output-limit.js";
import { EngineNotifications } from "./feishu/engine-notifications.js";
import { FeishuBots } from "./feishu/feishu-bots.js";
import { FeishuClient } from "./feishu/feishu-client.js";
import { FeishuDelivery } from "./feishu/feishu-delivery.js";
import { TaskNotifications } from "./feishu/task-notifications.js";
import { startAgentGateway } from "./gateway/agent-gateway.js";
import { buildHttpApi } from "./http/api.js";
import { loadWebApp } from "./http/web-app.js";
import { TaskLogs } from "./logs/task-logs.js";
import { MetricQueries } from "./metrics/metric-queries.js";
import { MetricRetention } from "./metrics/metric-retention.js";
import { TaskMetrics } from "./metrics/task-metrics.js";
import { OrchestrationStore } from "./orchestrations/orchestration-store.js";
import { createPackageRepository } from "./packages/package-repository.js";
import { createStdIndex } from "./packages/std-index.js";
import { PresetStore } from "./presets/preset-store.js";
import type { Mirrors } from "./public-config.js";
import { Retention } from "./retention/retention.js";
import { createParamsCheck, createPreflight } from "./runs/preflight.js";
import { createTriggerAdmission } from "./runs/trigger-admission.js";
import { loadSdkWheels, sdkWheelUrl } from "./sdk/sdk-wheels.js";
import { AssistantClient } from "./sessions/assistant-client.js";
import { assistantSetup } from "./sessions/assistant-config.js";
import { AssistantConnection } from "./sessions/assistant-connection.js";
import { SessionService } from "./sessions/session-service.js";
import { SessionStore } from "./sessions/session-store.js";
import { Mutex } from "./util/mutex.js";
import { printError, printInfo } from "./util/output.js";
import { periodic } from "./util/periodic.js";
import { safeError } from "./util/safe-error.js";

export interface ListenOptions {
	host?: string;
	/** 0 表示随机端口。 */
	port?: number;
}

export interface ControlPlaneOptions {
	databaseUrl: string;
	/** 数据目录：节点包文件等存放在这里。 */
	dataDir: string;
	clock?: Clock;
	http?: ListenOptions;
	grpc?: ListenOptions;
	/**
	 * 打开 Fastify 的日志和控制面自己的控制台输出；给 `{ stream }` 时 Fastify 的日志写进这个流（测试用它检查日志里
	 * 没有哈希、令牌这类不该出现的内容），控制台输出照常。
	 */
	logger?: boolean | { stream: NodeJS.WritableStream };
	/** Agent 共享注册令牌；未设置（或为空串）时不校验。 */
	agentToken?: string;
	/**
	 * HTTP API 对 Agent 可见的地址（Agent 从这里下载节点包），例如 `http://sfly.internal:8080`。
	 * 默认取实际监听地址；监听在 0.0.0.0 / :: 时用本机主机名。
	 */
	publicHttpUrl?: string;
	/**
	 * Agent 网关对 Agent 可见的地址（install.sh 写进 agent.env），例如 `http://sfly.internal:50051`。
	 * 默认取 HTTP 对外地址的主机名加 Agent 网关的端口。
	 */
	publicGrpcUrl?: string;
	/**
	 * 周期扫描（任务租约过期、排队超时）的间隔，默认 250 毫秒；
	 * 测试里调小，配合手动时钟推进。
	 */
	sweepIntervalMs?: number;
	/** 单个任务日志的上限（字节），默认 200 MB；超出部分截断（#18）。 */
	logLimitBytes?: number;
	/** 按运行合并读取日志时一次请求最多扫描的字节数，所有任务分摊，默认 8 MB（#223）；测试里调小。 */
	logScanBytes?: number;
	/** 单个任务指标数据的上限（字节，按每点 28 字节折算成点数），默认 50 MB；超出后截断（#29）。 */
	metricLimitBytes?: number;
	/** 指标写入的扫描间隔，默认 1 秒；当前段攒了多久（约 10 秒）才写只按注入的时钟判断（#29）。 */
	metricFlushIntervalMs?: number;
	/** 单个任务产物的总大小上限（字节），默认 1 GB（#18）。 */
	artifactLimitBytes?: number;
	/** 产物上传的空闲时限（毫秒），默认 60 秒（#588）：不是部署者的配置，只有测试和嵌入时给。 */
	artifactUploadIdleMs?: number;
	/** 日志和产物的保留天数，默认 30 天；运行结束超过这么久后清理（#18）。 */
	retentionDays?: number;
	/** 指标的保留天数，默认 30 天，与日志和产物分开配置；整天超过保留期的分区被删除（#32）。 */
	metricRetentionDays?: number;
	/** 保留期清理（含指标分区维护）的扫描间隔，默认 1 分钟；是否到期只按注入的时钟判断。 */
	retentionSweepIntervalMs?: number;
	/** 飞书发送队列的周期扫描间隔（#229，兜底：消息入队时已经立即唤醒投递），默认 1 秒。 */
	feishuSweepIntervalMs?: number;
	/** SSE 心跳的间隔，默认 15 秒；每次心跳带上控制面时间。 */
	sseHeartbeatMs?: number;
	/** 运行中任务的租约（毫秒），默认 30 秒；Agent 按它的三分之一发送心跳（#15）。 */
	leaseMs?: number;
	/** SDK 运行时 wheel 所在目录（src/sdk/sdk-wheels.ts）；不设置时不提供 SDK 下载。 */
	sdkWheelDir?: string;
	/** API 客户端安装包所在目录（src/downloads/client-tarballs.ts）；不设置或目录不存在时不提供下载。 */
	clientPackageDir?: string;
	/**
	 * PyPI 镜像（简单索引地址，例如 `https://mirrors.ustc.edu.cn/pypi/simple`），在 Welcome 里下发给 Agent 安装节点包依赖（ADR 0012）。
	 * 没有默认值：不设置时 Agent 用 uv 自己的配置。
	 */
	pypiMirror?: string;
	/**
	 * GitHub Release 镜像（例如 `https://mirrors.ustc.edu.cn/github-release`），在 Welcome 里下发给 Agent 安装 uv、下载 Python（ADR 0012）。
	 * 没有默认值：不设置时 Agent 用 uv 的官方来源。
	 */
	githubReleaseMirror?: string;
	/** 提供下载的 Agent 二进制（架构 → 文件，src/agent-binaries/agent-binaries.ts）；不设置时没有 Agent 下载。 */
	agentBinaries?: AgentBinaryFiles;
	/** install.sh 模板；默认取源码中的 src/agent-binaries/install.sh，打包后的控制面需要指定。 */
	installScriptFile?: string;
	/** 用户文档目录（仓库的 docs/guide，src/docs/user-docs.ts）；不设置时没有文档。 */
	docsDir?: string;
	/** 控制面版本号，默认取 package.json；测试里固定，让文档等输出与发版无关。 */
	version?: string;
	/** 前端构建产物目录（apps/web 的 vite build 输出）；不设置时只提供 API，不提供页面。 */
	webDir?: string;
	/**
	 * 允许跨域调用 API 的来源名单（形如 `https://dash.example.com`，src/http/cors.ts 的 parseCorsOrigins 解析环境变量
	 * `SFLY_CORS_ORIGINS` 得到）；不设置时允许所有来源（ADR 0022）。
	 */
	corsOrigins?: readonly string[];
	/** 数据库迁移目录；默认取源码中的 apps/server/drizzle，打包后的控制面需要指定。 */
	migrationsDir?: string;
	/**
	 * 借出去的数据库连接（事务里）出错时调用（#563，docs/ARCHITECTURE.md §6.10）：`main.ts` 给的是有序退出进程。
	 * 这样的连接上的错误以前是没人接的 `error` 事件、进程当场退出；之后的状态不可信（任务结果没写进去、提交之后的派发没人补），
	 * 靠重启恢复。调用之前连接池已经结束：之后新的拿连接的请求立刻以错误结束，不再碰数据库（已经借出去的连接不受影响，有序关闭等它们做完）。不给：只记日志（测试里的控制面）。
	 */
	onFatalDatabaseError?: (error: Error) => void;
	/**
	 * 助手服务的地址（`SFLY_ASSISTANT_URL`，ADR 0027）。助手默认关闭：地址和共享密钥（`assistantSecret`）都配好了才开，
	 * 没配时会话的写接口返回 503 `assistant_not_configured`，读接口照常。
	 */
	assistantUrl?: string;
	/** 和助手服务共用的密钥（`SFLY_ASSISTANT_SECRET`）：短于 32 个字符当作没有配置，原因写进日志和就绪状态。 */
	assistantSecret?: string;
	/** 哪台 Agent 是工作台（Agent 的名字，`SFLY_WORKBENCH_AGENT`）；骨架期间由部署者配置，#549 换成项目上的一列、删掉它。 */
	workbenchAgent?: string;
	/** 兜底收拾「一直在做」的会话的扫描间隔，默认 1 分钟；是否过期只按注入的时钟判断。 */
	sessionSweepIntervalMs?: number;
	/**
	 * 停止会话时，把中止发给助手服务之后最多等多久它把这一轮的结局带回来（毫秒），默认 `STOP_GRACE_MS`（13 秒：助手服务强制结束
	 * 进程的宽限 10 秒加 3 秒余量，不能短于它）；超过由控制面结束这一轮。测试里调小。
	 */
	sessionStopGraceMs?: number;
	/** 发给助手服务的命令（不含事件流和 `/health`）最多等多久（毫秒），默认 10 秒；测试里调小。 */
	assistantCommandTimeoutMs?: number;
	/** 事件连接多久没有收到任何字节（心跳也没有）就当它死了、断开重连（毫秒），默认 45 秒（3 个心跳间隔）；测试里调小。 */
	assistantEventsIdleMs?: number;
	/** 助手服务的事件连接断了之后重连的等待（毫秒）：第一次等 `min`，之后每次翻倍到 `max`；测试里调小。 */
	assistantReconnectMs?: { min: number; max: number };
	/**
	 * 初始管理员（环境变量 `SFLY_ADMIN_LOGIN`、`SFLY_ADMIN_PASSWORD`，src/auth/bootstrap.ts 的 parseInitialAdmin）：
	 * 只在没有任何用户时生效；不给时没有任何用户就生成一次性的初始化码（打印在日志里，写进数据目录的 setup-code 文件）。
	 */
	initialAdmin?: InitialAdmin;
	/** 登录的空闲期限（毫秒），默认 12 小时（环境变量 `SFLY_LOGIN_IDLE_HOURS`）。 */
	loginIdleMs?: number;
	/** 密码哈希的 scrypt 参数，默认 N=2^16、r=8、p=2；测试里调小。 */
	scrypt?: ScryptParams;
	/**
	 * 除了公开地址（`publicHttpUrl`）以外还算同源的来源，登录 Cookie 的跨站检查用（src/auth/cross-site.ts）：
	 * 开发时 vite 开发服务器的地址（`http://localhost:3000`）。生产里不用设置。
	 */
	sameOrigins?: readonly string[];
	/** 信任反向代理的 `X-Forwarded-For`（环境变量 `SFLY_TRUST_PROXY`）；默认不信任，见 {@link HttpApiDeps.trustProxy}。 */
	trustProxy?: FastifyServerOptions["trustProxy"];
	/** 算「假哈希」的函数（登录名不存在时拿它验证一次，对齐耗时）：默认按 `scrypt` 参数算；测试里换成数着次数的。 */
	dummyHash?: (password: string) => Promise<string>;
	/** 登录限速的参数（src/auth/login-throttle.ts），默认见那里；测试里调。 */
	loginThrottle?: LoginThrottleOptions;
	/** 密码验证的并发上限（src/auth/password-gate.ts），默认见那里；测试里调。 */
	passwordGate?: PasswordGateOptions;
	/** 打开着的事件流多久重新检查一次它的凭据（毫秒，src/http/api.ts），默认 30 秒；测试里调小。 */
	streamRecheckMs?: number;
	/** 会话令牌的写（触发、保存、恢复、复制）的事务里等行锁最多等多久（毫秒，src/sessions/session-store.ts），默认 5 秒；测试里调小。 */
	sessionWriteLockTimeoutMs?: number;
}

export interface ControlPlane {
	readonly httpUrl: string;
	readonly grpcUrl: string;
	/** 助手会话和它的事件（src/sessions/）：测试往里写事件、推事件，和助手服务的连接（之后）也经它落库、发布。 */
	readonly sessions: SessionStore;
	/** Agent 凭据和开发 Agent（src/agents/agent-credentials.ts）：测试用它给假 Agent 签发凭据。 */
	readonly agentCredentials: AgentCredentialService;
	/**
	 * 关闭控制面。**可以重复调用，第二次起拿到的是同一个 promise**（和第一次同时落定，不会比它先完成）：只关一次，不再去关已经关了的东西
	 * （第二次关连接池会拒绝）。调用方不止一个（停止信号、致命错误之后的有序退出），谁先谁后都是同一个结果，不会有一方在另一方还没关完时
	 * 就当作「关完了」去退出进程。
	 */
	close(): Promise<void>;
}

/**
 * 启动控制面：执行迁移，然后启动 HTTP API 和 Agent 网关。启动失败时抛出去的错误已经去掉数据库查询的参数
 * （{@link safeError}）：用环境变量建第一个管理员时写库失败，错误里带着密码的哈希，谁拿到这个错误去打印都不会把它带出去。
 */
export async function startControlPlane(options: ControlPlaneOptions): Promise<ControlPlane> {
	// 数值选项在启动时就检查，不合法的不启动，不留到运行时（#477、#577）：产物合计的上限随任务下发给 Agent（uint64），
	// `Infinity`、超过 2^53 − 1 的值下发时让派发出错；保留天数很大时清理的截止时间不是有效的时间，清理任务每分钟报错。
	const optionProblems = numericOptionProblems(options);
	if (optionProblems.length > 0) throw new EnvSettingsError(optionProblems, "选项");
	try {
		return await start(options);
	} catch (error) {
		throw safeError(error);
	}
}

async function start(options: ControlPlaneOptions): Promise<ControlPlane> {
	const clock = options.clock ?? systemClock;
	const logger = options.logger ?? false;
	/**
	 * 控制面自己往标准错误写错误日志的唯一出口：错误先过 `safeError`，数据库错误里的参数（密码的哈希、令牌的哈希、
	 * 保密参数的值、飞书 Webhook 的地址）不会进日志。新加的错误日志都走它，默认就是安全的；不要在这个函数里直接 `console.error`。
	 */
	const logError = (what: string, error?: unknown): void => {
		if (logger) printError(what, error);
	};
	const database = openDatabase(
		options.databaseUrl,
		(error) => logError("postgres connection error:", error),
		options.migrationsDir,
		{
			...(options.onFatalDatabaseError ? { onInUseError: options.onFatalDatabaseError } : {}),
			// 连接池没有关完不是又断了一条连接：自己的前缀。
			onCloseTimeout: (error) => logError("database pool shutdown:", error),
		},
	);

	try {
		await database.migrate();
		// 共享令牌登记成默认项目的旧式 Agent 凭据（ADR 0029）。
		await registerSharedAgentToken(database.db, clock, options.agentToken);
	} catch (error) {
		await database.close();
		throw error;
	}

	let webApp: Awaited<ReturnType<typeof loadWebApp>> | undefined;
	try {
		webApp = options.webDir === undefined ? undefined : await loadWebApp(options.webDir);
	} catch (error) {
		await database.close();
		throw error;
	}
	const sdkWheels = await loadSdkWheels(options.sdkWheelDir);
	const clientTarballs = await loadClientTarballs(options.clientPackageDir);
	let docs: Awaited<ReturnType<typeof loadUserDocs>>;
	try {
		docs = await loadUserDocs(options.docsDir);
	} catch (error) {
		await database.close();
		throw error;
	}
	const version = options.version ?? packageJson.version;
	let installScript: string;
	try {
		installScript = await loadInstallScript(
			options.installScriptFile ??
				fileURLToPath(new URL("./agent-binaries/install.sh", import.meta.url)),
		);
	} catch (error) {
		await database.close();
		throw error;
	}
	const agentBinaries = new AgentBinaries(options.agentBinaries ?? {}, version);
	const mutex = new Mutex();
	const hub = new AgentHub({ db: database.db, clock, mutex, version });
	await hub.markAllOffline();
	// 会话令牌触发的运行、保存的场景版本，在同一个事务里给会话写平台记录（#547）：引擎和场景存储都用它。
	const sessions = new SessionStore({
		db: database.db,
		clock,
		onError: (what, error) => logError(`sfly: ${what}`, error),
		...(options.sessionWriteLockTimeoutMs !== undefined && {
			writeLockTimeoutMs: options.sessionWriteLockTimeoutMs,
		}),
	});
	const orchestrations = new OrchestrationStore({ db: database.db, clock, sessions });
	let publicHttpUrl = "";
	const mirrors: Mirrors = { pypi: options.pypiMirror, githubRelease: options.githubReleaseMirror };
	let publicGrpcUrl = "";
	const packages = createPackageRepository({ db: database.db, clock, dataDir: options.dataDir });
	const preflight = createPreflight({ version });
	const logs = new TaskLogs({
		db: database.db,
		clock,
		dataDir: options.dataDir,
		limitBytes: options.logLimitBytes,
	});
	// 控制面直接向飞书机器人的 Webhook 地址发请求（ADR 0020），不经代理。
	const feishu = new FeishuClient();
	const feishuError = (error: unknown) => logError("feishu delivery failed:", error);
	const feishuBots = new FeishuBots({ db: database.db, clock, logs, onError: feishuError });
	const feishuDelivery = new FeishuDelivery({
		db: database.db,
		clock,
		bots: feishuBots,
		client: feishu,
		logs,
		onError: feishuError,
	});
	// 运行通知卡片里「查看运行」的链接只在配置了对外地址（SFLY_PUBLIC_URL）时给：默认的监听地址不一定是用户打得开的地址。
	const configuredUrl = options.publicHttpUrl?.replace(/\/+$/, "");
	const notifications = new TaskNotifications({
		db: database.db,
		clock,
		logs,
		delivery: feishuDelivery,
	});
	// 指标要在引擎之前建好：任务上报指标要先于引擎处理（运行监控、关注项读数、控制台都读它）。
	const metricRetention = new MetricRetention({
		db: database.db,
		clock,
		retentionDays: options.metricRetentionDays,
	});
	const metrics = new TaskMetrics({
		db: database.db,
		clock,
		retention: metricRetention,
		limitBytes: options.metricLimitBytes,
	});
	const metricQueries = new MetricQueries({ db: database.db, clock, metrics });
	const engine = new Engine({
		db: database.db,
		clock,
		mutex,
		hub,
		sessions,
		assignContent: createAssignContent({
			packageArchiveUrl: (name, version) =>
				`${publicHttpUrl}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/archive`,
			artifactUploadUrl: (taskId) => artifactBaseUrl(publicHttpUrl, taskId),
			artifactLimitBytes: options.artifactLimitBytes ?? DEFAULT_ARTIFACT_LIMIT_BYTES,
		}),
		admitTrigger: createTriggerAdmission({ preflight, paramsCheck: createParamsCheck() }),
		notifications: new EngineNotifications({
			delivery: feishuDelivery,
			runUrl: (runId) => (configuredUrl ? `${configuredUrl}/runs/${runId}` : undefined),
			onError: (error, runId) => {
				logError(`run notification: not sent for run ${runId}:`, error);
			},
		}),
		leaseMs: options.leaseMs,
		agentEnvironment: createAgentEnvironment({
			version,
			sdkWheel: (agentVersion) => {
				const wheel = sdkWheels.find((w) => w.version === agentVersion);
				return wheel && { url: sdkWheelUrl(publicHttpUrl, wheel), sha256: wheel.sha256 };
			},
			mirrors,
			packageIndexUrl: () => `${publicHttpUrl}/simple/`,
			agentBinary: async (arch) => {
				const binary = await agentBinaries.find(version, arch);
				return binary && { url: agentBinaryUrl(publicHttpUrl, binary), sha256: binary.sha256 };
			},
		}),
	});
	// 重启恢复：状态都在 PG，给租约和排队超时留出 Agent 重连的时间（#15）；升级前停在已移除的等待节点上的任务
	// （ADR 0028）、目标 Agent 属于别的项目的任务（#610）按配置错误失败，某个历史运行出错时记日志、跳过，不挡住启动。
	await engine.recover((error, task) => {
		logError(
			`recover: 运行 ${task.runId} 的任务 ${task.id} 在启动恢复时按配置错误失败出错，已跳过:`,
			error,
		);
	});
	const actions = new TaskActions({
		db: database.db,
		clock,
		logs,
		runChanges: engine.runChanges,
	});
	const artifacts = new ArtifactStore({
		db: database.db,
		clock,
		dataDir: options.dataDir,
		limitBytes: options.artifactLimitBytes,
		uploadIdleMs: options.artifactUploadIdleMs,
	});
	// 上次进程被杀、断电时留下的上传临时文件：开始监听之前清掉（这时没有上传在做）；清不掉不挡住启动。
	await artifacts
		.sweepUploadTemp()
		.then((count) => {
			if (count > 0 && logger) printInfo(`sfly: 清掉了上次留下的 ${count} 个上传临时文件`);
		})
		.catch((error) => logError("sfly: 清理上次留下的上传临时文件失败：", error));
	const retention = new Retention({
		db: database.db,
		clock,
		dataDir: options.dataDir,
		retentionDays: options.retentionDays,
	});
	// 本地账号与登录（ADR 0029）：第一个管理员由初始管理员环境变量或一次性的初始化码建出。
	const setupCode = new SetupCode(options.dataDir);
	// 登录注销、用户停用、令牌吊销都从同一个广播出去：路由层据此关掉受影响的事件流。
	const revocations = new RevocationBus();
	const accounts = new AccountService({
		db: database.db,
		clock,
		setupCode,
		scrypt: options.scrypt,
		dummyHash: options.dummyHash,
		loginIdleMs: options.loginIdleMs,
		throttle: new LoginThrottle(clock, options.loginThrottle),
		passwordGate: new PasswordGate(options.passwordGate),
		revocations,
	});
	// 假哈希提前算好（不等第一个不存在的登录名）；算不出来不挡启动，用到时再算。
	void accounts.warmUp().catch(() => {});
	const tokens = new TokenService({ db: database.db, clock, revocations });
	// Agent 凭据吊销时，用它连着的 Agent 连接断开（#492）。
	const agentCredentials = new AgentCredentialService({
		db: database.db,
		clock,
		onRevoked: (ids) => hub.closeByCredentials(ids),
	});
	// 用户被停用：他名下的开发 Agent 的凭据停止有效（Hello 拒绝，见 agent-auth.ts），已连着的连接断开。凭据不吊销：启用之后恢复。
	const stopClosingDevAgents = accounts.onRevoked((revocation) => {
		if (revocation.type !== "user") return;
		agentCredentials
			.liveIdsOfUser(revocation.userId)
			.then((ids) => hub.closeByCredentials(ids))
			.catch((error) => logError("sfly: 用户停用时断开他的开发 Agent 失败", error));
	});
	try {
		await mkdir(options.dataDir, { recursive: true });
		await bootstrapFirstAdmin({
			accounts,
			setupCode,
			initialAdmin: options.initialAdmin,
			log: (message) => {
				if (logger) printInfo(message);
			},
		});
	} catch (error) {
		await database.close();
		throw error;
	}
	const publicUrl = options.publicHttpUrl?.replace(/\/+$/, "");
	// 助手默认关闭：没配好时写明原因（日志里一行，就绪状态里也写）。
	const assistant = assistantSetup({ url: options.assistantUrl, secret: options.assistantSecret });
	if (!assistant.configured && logger) printInfo(`sfly: 助手没有开启：${assistant.reason}`);
	const assistantClient = assistant.configured
		? new AssistantClient(assistant.config, {
				...(options.assistantCommandTimeoutMs !== undefined && {
					timeoutMs: options.assistantCommandTimeoutMs,
				}),
				...(options.assistantEventsIdleMs !== undefined && {
					eventsIdleMs: options.assistantEventsIdleMs,
				}),
			})
		: undefined;
	const sessionService = new SessionService({
		sessions,
		db: database.db,
		hub,
		clock,
		setup: assistant,
		client: assistantClient,
		workbenchAgent: options.workbenchAgent || undefined,
		...(options.sessionStopGraceMs !== undefined && { stopGraceMs: options.sessionStopGraceMs }),
		log: (message, error) => logError(`sfly: ${message}`, error),
	});
	const api = buildHttpApi({
		database,
		clock,
		logger,
		hub,
		orchestrations,
		presets: new PresetStore({ db: database.db, clock }),
		engine,
		packages,
		preflight,
		logs,
		actions,
		sessions,
		sessionService,
		metrics,
		metricQueries,
		retention,
		artifacts,
		agentToken: options.agentToken,
		publicConfig: {
			httpUrl: () => publicHttpUrl,
			grpcUrl: () => publicGrpcUrl,
			version,
			mirrors,
		},
		sdkWheels,
		stdIndex: createStdIndex({
			packages,
			onSkipped: (version, reason) => {
				logError(`package index: sfly-std ${version} is not listed:`, reason);
			},
		}),
		clientTarballs,
		agentBinaries,
		installScript,
		docs,
		feishuBots,
		feishu,
		sseHeartbeatMs: options.sseHeartbeatMs,
		logScanBytes: options.logScanBytes,
		webApp,
		corsOrigins: options.corsOrigins,
		accounts,
		tokens,
		agentCredentials,
		loginIdleMs: options.loginIdleMs,
		// 登录 Cookie 的跨站检查：配置的公开地址（反向代理后面是浏览器看到的地址），加上开发时 vite 的地址；
		// 没有配置公开地址时用请求的 Host 兜底。
		origins: {
			origins: [
				...(publicUrl && URL.canParse(publicUrl) ? [new URL(publicUrl).origin] : []),
				...(options.sameOrigins ?? []),
			],
			hostFallback: publicUrl === undefined,
		},
		publicHttps: publicUrl?.startsWith("https://") ?? false,
		publicUrl,
		trustProxy: options.trustProxy,
		streamRecheckMs: options.streamRecheckMs,
	});
	const httpHost = options.http?.host ?? "127.0.0.1";
	await api.listen({ host: httpHost, port: options.http?.port ?? 0 });
	const httpPort = (api.server.address() as AddressInfo).port;
	const httpUrl = `http://${formatHost(httpHost)}:${httpPort}`;
	publicHttpUrl = (
		options.publicHttpUrl ??
		(httpHost === "0.0.0.0" || httpHost === "::" ? `http://${hostname()}:${httpPort}` : httpUrl)
	).replace(/\/+$/, "");

	const sessionError = (error: unknown) => logError("agent session error:", error);
	let gateway: Awaited<ReturnType<typeof startAgentGateway>>;
	try {
		gateway = await startAgentGateway({
			host: options.grpc?.host ?? "127.0.0.1",
			port: options.grpc?.port ?? 0,
			hub,
			// 日志、进度、指标、ctx.notify 的通知、动作摘要和安装状态不改变运行状态，不经过引擎（src/logs/task-logs.ts、
			// src/metrics/task-metrics.ts、src/feishu/task-notifications.ts、src/actions/task-actions.ts、src/agents/agent-hub.ts）。
			handler: {
				onOnline: (conn, running) => engine.onOnline(conn, running),
				async onMessage(conn, message) {
					if (metrics.handles(message)) return metrics.onMessage(conn, message);
					if (logs.handles(message)) return logs.onMessage(conn, message);
					if (notifications.handles(message)) return notifications.onMessage(conn, message);
					if (actions.handles(message)) return actions.onMessage(conn, message);
					if (message.body.case === "install") return hub.recordInstall(conn, message.body.value);
					// 任务结束：先写入它的指标（Agent 在结果之前发完最后的点）。写不进去时记下来、照常处理结果：
					// 没写入的点留在内存里，由周期写入重试有限次（src/metrics/task-metrics.ts）。
					if (message.body.case === "result") {
						await metrics.flushTask(message.body.value.taskId).catch(sessionError);
					}
					return engine.onMessage(conn, limitOutputs(message));
				},
			},
			authenticator: new AgentAuthenticator({ db: database.db, clock }),
			onError: sessionError,
		});
	} catch (error) {
		feishuDelivery.close();
		await feishu.close();
		await api.close();
		await database.close();
		throw error;
	}
	publicGrpcUrl = (
		options.publicGrpcUrl ?? gatewayUrlFrom(publicHttpUrl, new URL(gateway.url).port)
	).replace(/\/+$/, "");

	// 助手服务的事件连接：配置了助手服务的话打开，断了按退避重连（src/sessions/assistant-connection.ts）。
	const assistantConnection = assistantClient
		? new AssistantConnection({
				client: assistantClient,
				sessions,
				log: (message, error) => logError(`sfly: ${message}`, error),
				reconnect: options.assistantReconnectMs && {
					minMs: options.assistantReconnectMs.min,
					maxMs: options.assistantReconnectMs.max,
				},
			})
		: undefined;
	assistantConnection?.start();
	// 兜底：超过 30 分钟没有持久事件的「在做」的会话按中断处理，项目才能再开始新的一轮（控制面启动时先收拾一遍）。
	await sessionService
		.expireStale()
		.catch((error) => logError("sfly: 收拾一直在做的会话失败：", error));

	// 周期扫描（src/util/periodic.ts：上一次没结束时跳过本次）；是否到期都只按注入的时钟判断。
	const fail = (what: string) => (error: unknown) => logError(`${what} failed:`, error);
	const sweeps = [
		periodic(
			options.sessionSweepIntervalMs ?? 60_000,
			() => sessionService.expireStale(),
			fail("session sweep"),
		),
		// 任务租约过期与排队超时（#15）。
		periodic(options.sweepIntervalMs ?? 250, () => engine.expireTasks(), fail("sweep")),
		// 日志和产物的保留期清理（#18）；指标分区的提前创建与到期删除（#32）。
		periodic(
			options.retentionSweepIntervalMs ?? 60_000,
			async () => {
				await metricRetention.sweep().catch(fail("metric retention sweep"));
				await retention.sweep();
			},
			fail("retention sweep"),
		),
		// 指标：写入攒了约 10 秒的当前段（#29）。
		periodic(options.metricFlushIntervalMs ?? 1000, () => metrics.flushDue(), fail("metric flush")),
		// 飞书发送队列（ADR 0020）：消息入队时已经立即唤醒投递，这里兜底（控制面重启前入队的、投递循环出错退出的）。
		periodic(
			options.feishuSweepIntervalMs ?? 1000,
			() => feishuDelivery.wake(),
			fail("feishu sweep"),
		),
	];
	// 重启前还在排队的消息接着投递。
	feishuDelivery.wake();

	/** 关闭只做一次：重复调用（收到几个停止信号）拿到同一个结果，不再去关已经关了的东西（第二次关连接池会拒绝）。 */
	let closing: Promise<void> | undefined;
	const close = async (): Promise<void> => {
		stopClosingDevAgents();
		await assistantConnection?.close();
		await Promise.all(sweeps.map((s) => s.stop()));
		await retention.idle();
		await metricRetention.idle();
		hub.closeAll();
		await gateway.close();
		// 正常关闭时写入内存里尚未写库的指标。
		await metrics.close().catch(fail("metric flush"));
		// 等待已排队的状态变更（例如 Agent 下线）落库后再关闭连接池。
		await mutex.run(async () => {});
		// 先中断还在等飞书响应的请求（中断的消息不记结果，留在队列里），api.close() 才不会等它们。
		feishuDelivery.close();
		await feishu.close();
		await feishuDelivery.idle();
		await api.close();
		await database.close();
	};

	return {
		httpUrl,
		grpcUrl: gateway.url,
		sessions,
		agentCredentials,
		close: () => {
			closing ??= close();
			return closing;
		},
	};
}

function formatHost(host: string): string {
	return host.includes(":") ? `[${host}]` : host;
}
