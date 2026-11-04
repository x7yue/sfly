import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import { AgentHub } from "./agents/agent-hub.js";
import { type Clock, systemClock } from "./clock.js";
import { openDatabase } from "./db/database.js";
import { Engine } from "./engine/engine.js";
import { startAgentGateway } from "./gateway/agent-gateway.js";
import { buildHttpApi } from "./http/api.js";
import { OrchestrationStore } from "./orchestrations/orchestration-store.js";
import { createPackageRepository } from "./packages/package-repository.js";
import { PresenceRegistry } from "./presence/presence-registry.js";
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
	const engine = new Engine({
		db: database.db,
		clock,
		mutex,
		hub,
		packageArchiveUrl: (name, version) =>
			`${publicHttpUrl}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/archive`,
	});
	const packages = createPackageRepository({ db: database.db, clock, dataDir: options.dataDir });
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
			handler: engine,
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

	return {
		httpUrl,
		grpcUrl: gateway.url,
		async close() {
			clearInterval(sweep);
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
