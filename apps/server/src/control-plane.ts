import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import { AgentHub } from "./agents/agent-hub.js";
import { ArtifactStore, artifactBaseUrl } from "./artifacts/artifact-store.js";
import { type Clock, systemClock } from "./clock.js";
import { openDatabase } from "./db/database.js";
import { Engine } from "./engine/engine.js";
import { limitOutputs } from "./engine/output-limit.js";
import { startAgentGateway } from "./gateway/agent-gateway.js";
import { buildHttpApi } from "./http/api.js";
import { TaskLogs } from "./logs/task-logs.js";
import { OrchestrationStore } from "./orchestrations/orchestration-store.js";
import { createPackageRepository } from "./packages/package-repository.js";
import { PresenceRegistry } from "./presence/presence-registry.js";
import { Retention } from "./retention/retention.js";
import { createPreflight } from "./runs/preflight.js";
import { Mutex } from "./util/mutex.js";

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
	/** Agent 共享注册令牌；未设置时不校验。 */
	agentToken?: string;
	/**
	 * HTTP API 对 Agent 可见的地址（Agent 从这里下载节点包），例如 `http://sfly.internal:8080`。
	 * 默认取实际监听地址；监听在 0.0.0.0 / :: 时用本机主机名。
	 */
	publicHttpUrl?: string;
	/** 周期扫描（目前只有在线编辑者超时）的间隔，默认 250 毫秒（在线编辑者最多晚这么久被移除）；测试里调小，配合手动时钟推进。 */
	sweepIntervalMs?: number;
	/** 单个任务日志的上限（字节），默认 200 MB；超出部分截断（#18）。 */
	logLimitBytes?: number;
	/** 单个任务产物的总大小上限（字节），默认 1 GB（#18）。 */
	artifactLimitBytes?: number;
	/** 日志和产物的保留天数，默认 30 天；运行结束超过这么久后清理（#18）。 */
	retentionDays?: number;
	/** 保留期清理的扫描间隔，默认 1 分钟；是否到期只按注入的时钟判断。 */
	retentionSweepIntervalMs?: number;
	/** 定时 / Sleep 节点的定时器扫描间隔（#14），默认 1 秒；是否到期只按注入的时钟判断。 */
	timerSweepIntervalMs?: number;
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
	const database = openDatabase(options.databaseUrl, (error) => {
		if (logger) console.error("postgres pool error:", error.message);
	});

	try {
		await database.migrate();
	} catch (error) {
		await database.close();
		throw error;
	}

	const mutex = new Mutex();
	const hub = new AgentHub({ db: database.db, clock, mutex });
	await hub.markAllOffline();
	const orchestrations = new OrchestrationStore({ db: database.db, clock });
	let publicHttpUrl = "";
	const packages = createPackageRepository({ db: database.db, clock, dataDir: options.dataDir });
	const preflight = createPreflight({ db: database.db, packages });
	const engine = new Engine({
		db: database.db,
		clock,
		mutex,
		hub,
		packageArchiveUrl: (name, version) =>
			`${publicHttpUrl}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/archive`,
		artifactUploadUrl: (taskId) => artifactBaseUrl(publicHttpUrl, taskId),
		preflight,
	});
	const logs = new TaskLogs({
		db: database.db,
		clock,
		dataDir: options.dataDir,
		limitBytes: options.logLimitBytes,
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
		retention,
		artifacts,
		agentToken: options.agentToken,
		publicHttpUrl: () => publicHttpUrl,
	});
	const httpHost = options.http?.host ?? "127.0.0.1";
	await api.listen({ host: httpHost, port: options.http?.port ?? 0 });
	const httpPort = (api.server.address() as AddressInfo).port;
	const httpUrl = `http://${formatHost(httpHost)}:${httpPort}`;
	publicHttpUrl = (
		options.publicHttpUrl ??
		(httpHost === "0.0.0.0" || httpHost === "::" ? `http://${hostname()}:${httpPort}` : httpUrl)
	).replace(/\/+$/, "");

	let gateway: Awaited<ReturnType<typeof startAgentGateway>>;
	try {
		gateway = await startAgentGateway({
			host: options.grpc?.host ?? "127.0.0.1",
			port: options.grpc?.port ?? 0,
			hub,
			// 日志和进度不改变运行状态，不经过引擎（src/logs/task-logs.ts）。
			handler: {
				onOnline: (conn) => engine.onOnline(conn),
				onMessage: (conn, message) =>
					logs.handles(message)
						? logs.onMessage(conn, message)
						: engine.onMessage(conn, limitOutputs(message)),
			},
			agentToken: options.agentToken,
			onError: (error) => {
				if (logger) console.error("agent session error:", error);
			},
		});
	} catch (error) {
		await api.close();
		await database.close();
		throw error;
	}

	const sweep = setInterval(() => presence.sweep(), options.sweepIntervalMs ?? 250);
	sweep.unref();
	const retentionSweep = setInterval(() => {
		retention.sweep().catch((error) => {
			if (logger) console.error("retention sweep failed:", error);
		});
	}, options.retentionSweepIntervalMs ?? 60_000);
	retentionSweep.unref();
	// 定时器的状态全在 PG（tasks.wake_at），扫描本身无状态；上一次没结束时跳过本次。
	let waking: Promise<unknown> | undefined;
	const timerSweep = setInterval(() => {
		if (waking) return;
		waking = engine
			.wakeTimers()
			.catch((error) => {
				if (logger) console.error("timer sweep failed:", error);
			})
			.finally(() => {
				waking = undefined;
			});
	}, options.timerSweepIntervalMs ?? 1000);
	timerSweep.unref();

	return {
		httpUrl,
		grpcUrl: gateway.url,
		async close() {
			clearInterval(sweep);
			clearInterval(retentionSweep);
			clearInterval(timerSweep);
			await waking;
			await retention.idle();
			hub.closeAll();
			await gateway.close();
			// 等待已排队的状态变更（例如 Agent 下线）落库后再关闭连接池。
			await mutex.run(async () => {});
			await api.close();
			await database.close();
		},
	};
}

function formatHost(host: string): string {
	return host.includes(":") ? `[${host}]` : host;
}
