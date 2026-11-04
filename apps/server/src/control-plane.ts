import type { AddressInfo } from "node:net";
import { AgentHub } from "./agents/agent-hub.js";
import { type Clock, systemClock } from "./clock.js";
import { openDatabase } from "./db/database.js";
import { Engine } from "./engine/engine.js";
import { startAgentGateway } from "./gateway/agent-gateway.js";
import { buildHttpApi } from "./http/api.js";
import { OrchestrationStore } from "./orchestrations/orchestration-store.js";
import { createPackageRepository } from "./packages/package-repository.js";
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
	const engine = new Engine({ db: database.db, clock, mutex, hub });
	const packages = createPackageRepository({ db: database.db, clock, dataDir: options.dataDir });
	const api = buildHttpApi({ database, clock, logger, hub, orchestrations, engine, packages });
	const httpHost = options.http?.host ?? "127.0.0.1";
	await api.listen({ host: httpHost, port: options.http?.port ?? 0 });
	const httpPort = (api.server.address() as AddressInfo).port;

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

	return {
		httpUrl: `http://${httpHost.includes(":") ? `[${httpHost}]` : httpHost}:${httpPort}`,
		grpcUrl: gateway.url,
		async close() {
			hub.closeAll();
			await gateway.close();
			// 等待已排队的状态变更（例如 Agent 下线）落库后再关闭连接池。
			await mutex.run(async () => {});
			await api.close();
			await database.close();
		},
	};
}
