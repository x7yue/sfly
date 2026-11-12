import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import {
	AgentBinaries,
	type AgentBinaryFiles,
	agentBinaryUrl,
} from "./agent-binaries/agent-binaries.js";
import { loadInstallScript } from "./agent-binaries/install-script.js";
import { AgentHub } from "./agents/agent-hub.js";
import { ArtifactStore, artifactBaseUrl } from "./artifacts/artifact-store.js";
import { type Clock, systemClock } from "./clock.js";
import { openDatabase } from "./db/database.js";
import { loadUserDocs } from "./docs/user-docs.js";
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
import { PresenceRegistry } from "./presence/presence-registry.js";
import type { Mirrors } from "./public-config.js";
import { Retention } from "./retention/retention.js";
import { createParamsCheck, createPreflight } from "./runs/preflight.js";
import { loadSdkWheels, sdkWheelUrl } from "./sdk/sdk-wheels.js";
import { Mutex } from "./util/mutex.js";
import { periodic } from "./util/periodic.js";

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
	logger?: boolean;
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
	 * 周期扫描（在线编辑者超时、任务租约过期、排队超时）的间隔，默认 250 毫秒；
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
	/** 日志和产物的保留天数，默认 30 天；运行结束超过这么久后清理（#18）。 */
	retentionDays?: number;
	/** 指标的保留天数，默认 30 天，与日志和产物分开配置；整天超过保留期的分区被删除（#32）。 */
	metricRetentionDays?: number;
	/** 保留期清理（含指标分区维护）的扫描间隔，默认 1 分钟；是否到期只按注入的时钟判断。 */
	retentionSweepIntervalMs?: number;
	/** 定时 / Sleep 节点的定时器扫描间隔（#14），默认 1 秒；是否到期只按注入的时钟判断。 */
	timerSweepIntervalMs?: number;
	/** 飞书发送队列的周期扫描间隔（#229，兜底：消息入队时已经立即唤醒投递），默认 1 秒。 */
	feishuSweepIntervalMs?: number;
	/** SSE 心跳的间隔，默认 15 秒；每次心跳带上控制面时间。 */
	sseHeartbeatMs?: number;
	/** 运行中任务的租约（毫秒），默认 30 秒；Agent 按它的三分之一发送心跳（#15）。 */
	leaseMs?: number;
	/** SDK 运行时 wheel 所在目录（src/sdk/sdk-wheels.ts）；不设置时不提供 SDK 下载。 */
	sdkWheelDir?: string;
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
	/** 数据库迁移目录；默认取源码中的 apps/server/drizzle，打包后的控制面需要指定。 */
	migrationsDir?: string;
}

export interface ControlPlane {
	readonly httpUrl: string;
	readonly grpcUrl: string;
	close(): Promise<void>;
}

/** 启动控制面：执行迁移，然后启动 HTTP API 和 Agent 网关。 */
export async function startControlPlane(options: ControlPlaneOptions): Promise<ControlPlane> {
	const clock = options.clock ?? systemClock;
	const logger = options.logger ?? false;
	const database = openDatabase(
		options.databaseUrl,
		(error) => {
			if (logger) console.error("postgres pool error:", error.message);
		},
		options.migrationsDir,
	);

	try {
		await database.migrate();
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
	const orchestrations = new OrchestrationStore({ db: database.db, clock });
	let publicHttpUrl = "";
	const mirrors: Mirrors = { pypi: options.pypiMirror, githubRelease: options.githubReleaseMirror };
	let publicGrpcUrl = "";
	const packages = createPackageRepository({ db: database.db, clock, dataDir: options.dataDir });
	const preflight = createPreflight({ db: database.db, packages, version });
	const logs = new TaskLogs({
		db: database.db,
		clock,
		dataDir: options.dataDir,
		limitBytes: options.logLimitBytes,
	});
	// 控制面直接向飞书机器人的 Webhook 地址发请求（ADR 0020），不经代理。
	const feishu = new FeishuClient();
	const feishuError = (error: unknown) => {
		if (logger) console.error("feishu delivery failed:", error);
	};
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
	const engine = new Engine({
		db: database.db,
		clock,
		mutex,
		hub,
		packageArchiveUrl: (name, version) =>
			`${publicHttpUrl}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/archive`,
		artifactUploadUrl: (taskId) => artifactBaseUrl(publicHttpUrl, taskId),
		preflight,
		paramsCheck: createParamsCheck({ db: database.db, packages }),
		notifications: new EngineNotifications({
			logs,
			delivery: feishuDelivery,
			runUrl: (runId) => (configuredUrl ? `${configuredUrl}/runs/${runId}` : undefined),
		}),
		leaseMs: options.leaseMs,
		sdkWheel: (agentVersion) => {
			const wheel = sdkWheels.find((w) => w.version === agentVersion);
			return wheel && { url: sdkWheelUrl(publicHttpUrl, wheel), sha256: wheel.sha256 };
		},
		mirrors,
		agentBinary: async (arch) => {
			const binary = await agentBinaries.find(version, arch);
			return binary && { url: agentBinaryUrl(publicHttpUrl, binary), sha256: binary.sha256 };
		},
	});
	// 重启恢复：状态都在 PG，只需给租约和排队超时留出 Agent 重连的时间（#15）。
	await engine.recover();
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
	const artifacts = new ArtifactStore({
		db: database.db,
		clock,
		dataDir: options.dataDir,
		limitBytes: options.artifactLimitBytes,
	});
	const retention = new Retention({
		db: database.db,
		clock,
		dataDir: options.dataDir,
		retentionDays: options.retentionDays,
	});
	const presence = new PresenceRegistry({ clock });
	const api = buildHttpApi({
		database,
		clock,
		logger,
		hub,
		orchestrations,
		engine,
		packages,
		presence,
		preflight,
		logs,
		metrics,
		metricQueries: new MetricQueries({ db: database.db, clock, metrics }),
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
		agentBinaries,
		installScript,
		docs,
		feishuBots,
		feishu,
		sseHeartbeatMs: options.sseHeartbeatMs,
		logScanBytes: options.logScanBytes,
		webApp,
	});
	const httpHost = options.http?.host ?? "127.0.0.1";
	await api.listen({ host: httpHost, port: options.http?.port ?? 0 });
	const httpPort = (api.server.address() as AddressInfo).port;
	const httpUrl = `http://${formatHost(httpHost)}:${httpPort}`;
	publicHttpUrl = (
		options.publicHttpUrl ??
		(httpHost === "0.0.0.0" || httpHost === "::" ? `http://${hostname()}:${httpPort}` : httpUrl)
	).replace(/\/+$/, "");

	const sessionError = (error: unknown) => {
		if (logger) console.error("agent session error:", error);
	};
	let gateway: Awaited<ReturnType<typeof startAgentGateway>>;
	try {
		gateway = await startAgentGateway({
			host: options.grpc?.host ?? "127.0.0.1",
			port: options.grpc?.port ?? 0,
			hub,
			// 日志、进度、指标和 ctx.notify 的通知不改变运行状态，不经过引擎
			// （src/logs/task-logs.ts、src/metrics/task-metrics.ts、src/feishu/task-notifications.ts）。
			handler: {
				onOnline: (conn, running) => engine.onOnline(conn, running),
				async onMessage(conn, message) {
					if (metrics.handles(message)) return metrics.onMessage(conn, message);
					if (logs.handles(message)) return logs.onMessage(conn, message);
					if (notifications.handles(message)) return notifications.onMessage(conn, message);
					// 任务结束：先写入它的指标（Agent 在结果之前发完最后的点）。写不进去时记下来、照常处理结果：
					// 没写入的点留在内存里，由周期写入重试有限次（src/metrics/task-metrics.ts）。
					if (message.body.case === "result") {
						await metrics.flushTask(message.body.value.taskId).catch(sessionError);
					}
					return engine.onMessage(conn, limitOutputs(message));
				},
			},
			agentToken: options.agentToken,
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
		options.publicGrpcUrl ?? withPort(publicHttpUrl, new URL(gateway.url).port)
	).replace(/\/+$/, "");

	// 周期扫描（src/util/periodic.ts：上一次没结束时跳过本次）；是否到期都只按注入的时钟判断。
	const fail = (what: string) => (error: unknown) => {
		if (logger) console.error(`${what} failed:`, error);
	};
	const sweeps = [
		// 在线编辑者超时（#17）、任务租约过期与排队超时（#15）。
		periodic(
			options.sweepIntervalMs ?? 250,
			async () => {
				presence.sweep();
				await engine.expireTasks();
			},
			fail("sweep"),
		),
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
		// 定时 / Sleep 节点（#14）：定时器的状态全在 PG（tasks.wake_at），扫描本身无状态。
		periodic(options.timerSweepIntervalMs ?? 1000, () => engine.wakeTimers(), fail("timer sweep")),
		// 飞书发送队列（ADR 0020）：消息入队时已经立即唤醒投递，这里兜底（控制面重启前入队的、投递循环出错退出的）。
		periodic(
			options.feishuSweepIntervalMs ?? 1000,
			() => feishuDelivery.wake(),
			fail("feishu sweep"),
		),
	];
	// 重启前还在排队的消息接着投递。
	feishuDelivery.wake();

	return {
		httpUrl,
		grpcUrl: gateway.url,
		async close() {
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
		},
	};
}

/** 同一主机、另一个端口的 http 地址。 */
function withPort(url: string, port: string): string {
	const parsed = new URL(url);
	return `http://${parsed.hostname}:${port}`;
}

function formatHost(host: string): string {
	return host.includes(":") ? `[${host}]` : host;
}
