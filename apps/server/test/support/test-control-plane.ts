import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../../src/clock.js";
import { type ControlPlane, startControlPlane } from "../../src/control-plane.js";
import { ManualClock } from "./manual-clock.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";

export interface TestControlPlane {
	/** 当前实例；restart() 之后会换成新实例。 */
	readonly current: ControlPlane;
	readonly httpUrl: string;
	readonly grpcUrl: string;
	readonly clock: Clock;
	readonly database: TestDatabase;
	/** 临时数据目录；restart() 后保留，close() 时删除。 */
	readonly dataDir: string;
	/** 对 HTTP API 发请求，path 以 / 开头。 */
	fetch(path: string, init?: RequestInit): Promise<Response>;
	/** 停掉当前实例，在同一个数据库上重新启动（模拟控制面重启）。 */
	restart(): Promise<void>;
	/** 停掉实例并删除临时数据库。 */
	close(): Promise<void>;
}

/**
 * 在独立的临时数据库和临时数据目录上启动一个真实的控制面，HTTP 与 gRPC 都监听随机端口。
 * 默认注入 ManualClock，可以传入自己的时钟；agentToken 为共享注册令牌（默认不校验）。
 */
export async function startTestControlPlane(
	options: { clock?: Clock; agentToken?: string } = {},
): Promise<TestControlPlane> {
	const clock = options.clock ?? new ManualClock();
	const database = await createTestDatabase();
	const dataDir = await mkdtemp(join(tmpdir(), "sfly-test-"));
	const start = () =>
		startControlPlane({
			databaseUrl: database.url,
			dataDir,
			clock,
			agentToken: options.agentToken,
			http: { host: "127.0.0.1", port: 0 },
			grpc: { host: "127.0.0.1", port: 0 },
		});

	let current: ControlPlane;
	try {
		current = await start();
	} catch (error) {
		await database.drop();
		await rm(dataDir, { recursive: true, force: true });
		throw error;
	}

	return {
		get current() {
			return current;
		},
		get httpUrl() {
			return current.httpUrl;
		},
		get grpcUrl() {
			return current.grpcUrl;
		},
		clock,
		database,
		dataDir,
		fetch: (path, init) => fetch(`${current.httpUrl}${path}`, init),
		async restart() {
			await current.close();
			current = await start();
		},
		async close() {
			await current.close();
			await database.drop();
			await rm(dataDir, { recursive: true, force: true });
		},
	};
}
