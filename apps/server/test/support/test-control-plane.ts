import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { Agent } from "undici";
import packageJson from "../../package.json" with { type: "json" };
import type { Clock } from "../../src/clock.js";
import {
	type ControlPlane,
	type ControlPlaneOptions,
	startControlPlane,
} from "../../src/control-plane.js";
import { defaultMigrationsDir } from "../../src/db/database.js";
import { DEFAULT_PROJECT } from "../../src/projects/project-id.js";
import { TestUsers } from "./credentials.js";
import { registerCredentialIssuer } from "./fake-agent.js";
import { ManualClock } from "./manual-clock.js";
import { prepareVaultTables } from "./migrations.js";
import { registerCliCredentials } from "./sfly-cli.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";

// 控制面的测试和端到端测试都经这里启动控制面。Node 低于 .node-version 时，undici 与 Node 自带的 fetch 不兼容，
// 每个请求都只报 `fetch failed`（invalid onRequestStart method），看不出是版本问题：先检查版本。
const requiredNode = Number(
	readFileSync(new URL("../../../../.node-version", import.meta.url), "utf8").trim(),
);
if (Number(process.versions.node.split(".")[0]) < requiredNode) {
	throw new Error(
		`测试需要 Node ${requiredNode}（.node-version），当前是 ${process.versions.node}：先切换 Node 版本（例如 nvm use ${requiredNode}）`,
	);
}

export interface TestControlPlane {
	/** 当前实例；restart() 之后会换成新实例。 */
	readonly current: ControlPlane;
	readonly httpUrl: string;
	readonly grpcUrl: string;
	readonly clock: Clock;
	/** 控制面版本（Agent 的目标版本）：`version` 选项，默认 package.json 的版本。 */
	readonly version: string;
	readonly database: TestDatabase;
	/** 临时数据目录；restart() 后保留，close() 时删除。 */
	readonly dataDir: string;
	/**
	 * 对 HTTP API 发请求，path 以 / 开头。默认带上凭据（#493）：按昵称请求头（没有时是 `tester`）找这个用户的个人令牌，
	 * 见 {@link TestUsers}。请求自己带了 `authorization` 或 `cookie` 时不动；`credentials: "omit"` 时什么凭据都不带。
	 */
	fetch(path: string, init?: RequestInit): Promise<Response>;
	/** 默认带的凭据：每个昵称一个用户和他的个人令牌（{@link TestUsers}）。 */
	readonly users: TestUsers;
	/** 同一个控制面，`fetch` 总是带 tester 的个人令牌：`defaultCredentials: false` 的文件做准备步骤用。 */
	asTester(): TestControlPlane;
	/**
	 * 停掉当前实例，在同一个数据库、同样的 HTTP / gRPC 端口上重新启动（模拟控制面重启；
	 * 端口不变，真实 Agent 才能按原地址重连、继续下载和上传）；
	 * `whileDown` 在停机期间执行（例如推进手动时钟模拟停机时长）；`migrationsDir` 换一个迁移目录重新启动
	 * （例如从只含旧迁移的目录升级到当前版本，模拟升级控制面）。
	 */
	restart(whileDown?: () => void | Promise<void>, next?: { migrationsDir?: string }): Promise<void>;
	/** 停掉实例并删除临时数据库。 */
	close(): Promise<void>;
}

const portOf = (url: string) => Number(new URL(url).port);

/**
 * 在独立的临时数据库和临时数据目录上启动一个真实的控制面，HTTP 与 gRPC 都监听随机端口。
 * 默认注入 ManualClock，可以传入自己的时钟；agentToken 为共享注册令牌（默认不校验）。
 * 日志上限、产物上限、保留期等（#18）可以按需覆盖。
 */
export async function startTestControlPlane(
	options: {
		clock?: Clock;
		agentToken?: string;
		/** 停止之后等助手服务带回结局的宽限：默认 300 毫秒；`"production"` 是不传值、用控制面自己的默认（`STOP_GRACE_MS`）。 */
		sessionStopGraceMs?: number | "production";
		/**
		 * 从这个模板库（{@link createMigratedTemplate}）复制出测试库，不用每个控制面都把迁移从头跑一遍（#613）。
		 * 模板是按源码里的迁移目录迁移好的，不能和 `migrationsDir` 一起给（老迁移目录对着新结构的库没有意义）。
		 */
		template?: string;
		/**
		 * 配置了助手服务（`assistantUrl`）时，启动和重启之后等事件流连上再返回（默认等，最多 10 秒，连不上不报错、直接返回）：
		 * 事件流没连上时就绪状态写助手服务连不上、建会话和说话 503（#545），不等的话测试一建会话就可能撞上刚启动、还没连上的那几毫秒。
		 * 助手服务本来就连不上的用例（地址写错、密钥不对）传 `false`，不等那 10 秒。
		 */
		waitForAssistant?: boolean;
		/**
		 * 默认项目的工作台（Agent 的名字）：启动之后直接写进库（`projects.workbench_agent`），不经 `PUT /projects/:project/workbench`。
		 * 真正的登记要求这台 Agent 已经用 Agent 凭据连上来过，而这些测试在控制面起来之后才连假 Agent；要测登记本身的用例
		 * 不用这个选项，走接口。库里有了登记，控制面就只接受 Agent 凭据（假 Agent 默认用 Agent 凭据，下面的 `registerIssuer`）。
		 */
		workbenchAgent?: string;
		/**
		 * `fetch` 默认带上凭据（{@link TestUsers}，#493）；`false` 时不带，请求自己写凭据。给测试凭据本身的用例（登录、令牌、
		 * 初始化、访问检查）用：它们要数库里的用户和令牌、要看不带凭据时的样子，默认凭据会建出多余的用户和令牌。
		 */
		defaultCredentials?: boolean;
	} & Pick<
		ControlPlaneOptions,
		| "logLimitBytes"
		| "logScanBytes"
		| "metricLimitBytes"
		| "artifactLimitBytes"
		| "artifactUploadIdleMs"
		| "retentionDays"
		| "purgeWaitMs"
		| "metricRetentionDays"
		| "leaseMs"
		| "sseHeartbeatMs"
		| "sdkWheelDir"
		| "clientPackageDir"
		| "webDir"
		| "corsOrigins"
		| "docsDir"
		| "version"
		| "publicHttpUrl"
		| "publicGrpcUrl"
		| "agentBinaries"
		| "pypiMirror"
		| "githubReleaseMirror"
		| "migrationsDir"
		| "logger"
		| "assistantUrl"
		| "assistantSecret"
		| "assistantReconnectMs"
		| "assistantEventsIdleMs"
		| "assistantCommandTimeoutMs"
		| "sessionSweepIntervalMs"
		| "onSessionEnded"
		| "initialAdmin"
		| "loginIdleMs"
		| "sameOrigins"
		| "scrypt"
		| "dummyHash"
		| "loginThrottle"
		| "passwordGate"
		| "trustProxy"
		| "streamRecheckMs"
		| "sessionWriteLockTimeoutMs"
		| "agentMessageMaxBytes"
	> = {},
): Promise<TestControlPlane> {
	if (options.template !== undefined && options.migrationsDir !== undefined) {
		throw new Error("template 和 migrationsDir 不能一起给：模板库已经按源码里的迁移目录迁移好了");
	}
	let migrationsDir = options.migrationsDir;
	const clock = options.clock ?? new ManualClock();
	const database = await createTestDatabase("sfly_test", { template: options.template });
	const dataDir = await mkdtemp(join(tmpdir(), "sfly-test-"));
	const start = async (ports = { http: 0, grpc: 0 }) => {
		await prepareVaultTables(database.url, migrationsDir);
		return startControlPlane({
			databaseUrl: database.url,
			dataDir,
			clock,
			agentToken: options.agentToken,
			logLimitBytes: options.logLimitBytes,
			logScanBytes: options.logScanBytes,
			metricLimitBytes: options.metricLimitBytes,
			// 指标写入扫描（#29）同样调快。
			metricFlushIntervalMs: 20,
			artifactLimitBytes: options.artifactLimitBytes,
			artifactUploadIdleMs: options.artifactUploadIdleMs,
			retentionDays: options.retentionDays,
			purgeWaitMs: options.purgeWaitMs,
			metricRetentionDays: options.metricRetentionDays,
			leaseMs: options.leaseMs,
			sseHeartbeatMs: options.sseHeartbeatMs,
			sdkWheelDir: options.sdkWheelDir,
			clientPackageDir: options.clientPackageDir,
			webDir: options.webDir,
			corsOrigins: options.corsOrigins,
			docsDir: options.docsDir,
			version: options.version,
			publicHttpUrl: options.publicHttpUrl,
			publicGrpcUrl: options.publicGrpcUrl,
			agentBinaries: options.agentBinaries,
			pypiMirror: options.pypiMirror,
			githubReleaseMirror: options.githubReleaseMirror,
			migrationsDir,
			logger: options.logger,
			assistantUrl: options.assistantUrl,
			assistantSecret: options.assistantSecret,
			assistantReconnectMs: options.assistantReconnectMs,
			assistantEventsIdleMs: options.assistantEventsIdleMs,
			assistantCommandTimeoutMs: options.assistantCommandTimeoutMs,
			// 兜底收拾「一直在做」的会话（超过 30 分钟没有持久事件）：测试里默认不扫（用例里手动推进时钟、直接写库造会话，
			// 不该被它收拾掉），要测它的用例自己传间隔。
			sessionSweepIntervalMs: options.sessionSweepIntervalMs ?? 3_600_000,
			onSessionEnded: options.onSessionEnded,
			// 停止之后等助手服务带回结局的宽限：测试里短一点（要测它的用例自己传）。
			sessionStopGraceMs:
				options.sessionStopGraceMs === "production"
					? undefined
					: (options.sessionStopGraceMs ?? 300),
			initialAdmin: options.initialAdmin,
			loginIdleMs: options.loginIdleMs,
			sameOrigins: options.sameOrigins,
			// 密码哈希用小参数：测试里每次登录都要算，默认参数一次约 0.2 秒、占 64 MiB（要测真实代价的测试自己传）。
			scrypt: options.scrypt ?? { logN: 10, r: 8, p: 1 },
			dummyHash: options.dummyHash,
			loginThrottle: options.loginThrottle,
			passwordGate: options.passwordGate,
			trustProxy: options.trustProxy,
			streamRecheckMs: options.streamRecheckMs,
			sessionWriteLockTimeoutMs: options.sessionWriteLockTimeoutMs,
			agentMessageMaxBytes: options.agentMessageMaxBytes,
			// 保留期清理也调快（只按注入的时钟判断是否到期）。
			retentionSweepIntervalMs: 20,
			// 飞书发送队列的周期扫描同样调快。
			feishuSweepIntervalMs: 20,
			// 周期扫描调快：测试推进手动时钟后很快就能观察到效果，不用真实等待。
			sweepIntervalMs: 20,
			http: { host: "127.0.0.1", port: ports.http },
			grpc: { host: "127.0.0.1", port: ports.grpc },
		});
	};

	const users = new TestUsers(database.url);
	// 用旧的迁移目录起的控制面（升级测试）：库里还没有用户和令牌的表，或者是旧的样子，默认凭据建不出来；换回源码里的迁移
	// 目录重启之后才带。
	const signs = () =>
		options.defaultCredentials !== false &&
		(migrationsDir === undefined || resolve(migrationsDir) === resolve(defaultMigrationsDir));

	let current: ControlPlane;
	try {
		current = await start();
	} catch (error) {
		await database.drop();
		await rm(dataDir, { recursive: true, force: true });
		throw error;
	}

	if (options.workbenchAgent) {
		const client = new pg.Client({ connectionString: database.url });
		await client.connect();
		try {
			await client.query("update projects set workbench_agent = $1 where id = $2", [
				options.workbenchAgent,
				DEFAULT_PROJECT,
			]);
		} finally {
			await client.end();
		}
	}

	/** 等事件流连上（见 `waitForAssistant`）：连不上就等到时限、不报错。 */
	const settleAssistant = async () => {
		if (!options.assistantUrl || options.waitForAssistant === false) return;
		const deadline = Date.now() + 10_000;
		while (!current.assistantConnected() && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	await settleAssistant();

	// 假 Agent 没写 token 时用 Agent 凭据连接：按名字向这个控制面签发（和真实的部署一样，#492）。
	// 重启后库可能是另一个样子（升级测试会先把库退回旧结构）：凭据重新签发。
	const registerIssuer = () =>
		registerCredentialIssuer(current.grpcUrl, async (name) => {
			const issued = await current.agentCredentials.issue(DEFAULT_PROJECT, name);
			return issued.token;
		});
	let unregister = registerIssuer();
	// 命令行连这个控制面时默认带上个人令牌（sfly-cli.ts）。用户第一次用到时才建（启动时不建：
	// 「还没有任何用户」的初始化页要看到空库）；`spawnSfly` 同步起进程，用之前先 `await cp.users.user()`。
	const unregisterCli = registerCliCredentials(current.httpUrl, {
		token: async (nickname) => (signs() ? users.token(nickname) : undefined),
		tokenNow: (nickname) => (signs() ? users.tokenNow(nickname) : ""),
	});

	// 每个控制面实例一套独立的 HTTP 连接池：重启时销毁旧池，重启后的请求不会复用
	// 已被旧实例关闭的 keep-alive 连接（全局 fetch 的连接池会复用，偶发 ECONNRESET）。
	let dispatcher = new Agent();

	const plane: TestControlPlane = {
		asTester() {
			const signed = Object.create(plane) as TestControlPlane;
			Object.defineProperty(signed, "fetch", {
				value: async (path: string, init: RequestInit = {}) =>
					fetch(`${current.httpUrl}${path}`, {
						...init,
						headers: await users.sign(init),
						dispatcher,
					} as RequestInit),
			});
			return signed;
		},
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
		version: options.version ?? packageJson.version,
		database,
		dataDir,
		users,
		fetch: async (path, init = {}) =>
			fetch(`${current.httpUrl}${path}`, {
				...init,
				headers: signs() ? await users.sign(init) : init.headers,
				dispatcher,
			} as RequestInit),
		async restart(whileDown, next) {
			if (next && "migrationsDir" in next) migrationsDir = next.migrationsDir;
			const ports = { http: portOf(current.httpUrl), grpc: portOf(current.grpcUrl) };
			await current.close();
			const old = dispatcher;
			dispatcher = new Agent();
			await old.destroy();
			await whileDown?.();
			current = await start(ports);
			unregister();
			unregister = registerIssuer();
			await settleAssistant();
		},
		async close() {
			unregister();
			unregisterCli();
			await current.close();
			await dispatcher.destroy();
			await database.drop();
			await rm(dataDir, { recursive: true, force: true });
		},
	};
	return plane;
}
