// 路由或插件登记出错时，启动失败的原因是原来的错误，不是「监听失败」（#651 的审查）：
// Fastify 的 `listen` 里面会先做 `ready`，路由、插件的登记在那一步才真正执行：登记出错（重复的路由、schema 写错……）也从 `listen` 抛出来。
// HTTP 的监听包了一层（util/listen-error.ts，把 `listen` 的错误都说成「监听失败」，只留错误码），不先做 `ready` 的话，
// 登记出错会被说成「监听失败（错误码 FST_ERR_…）：检查 SFLY_HTTP_HOST」，真正的原因（哪条路由、哪里不对）丢了，还把人指到错的地方。
// 这里用现有的入口造一个登记阶段出错的控制面：把 `contractRoute` 换成会重复登记某个契约的版本（节点包的发布路由在 `app.register`
// 的作用域里登记，所以重复的路由在 `ready` 时才被发现，Fastify 报 FST_ERR_DUPLICATED_ROUTE）；产品代码不为测试改任何接口。
// 对照：端口被占用时仍是「监听失败」（监听失败的说明不变）。
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

/** 重复登记的契约（`undefined` 是照常）。 */
const hooks = vi.hoisted(() => ({ duplicate: undefined as unknown }));

vi.mock("../src/http/contract-route.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/http/contract-route.js")>();
	const contractRoute = ((...args: Parameters<typeof actual.contractRoute>) => {
		actual.contractRoute(...args);
		if (hooks.duplicate === args[1]) actual.contractRoute(...args);
	}) as typeof actual.contractRoute;
	return { ...actual, contractRoute };
});

const { packagesApi } = await import("@sfly/schema");
const { startControlPlane } = await import("../src/control-plane.js");
const { ListenError } = await import("../src/util/listen-error.js");

describe("启动时登记路由出错：原来的错误照原样出来，不说成监听失败", () => {
	let database: TestDatabase;
	let dataDir: string;

	beforeEach(async () => {
		database = await createTestDatabase("sfly_register", { dropWaitMs: 200 });
		dataDir = await mkdtemp(join(tmpdir(), "sfly-register-error-"));
	});
	afterEach(async () => {
		hooks.duplicate = undefined;
		await rm(dataDir, { recursive: true, force: true });
		await database.drop();
	});

	const start = (http: { host: string; port: number } = { host: "127.0.0.1", port: 0 }) =>
		startControlPlane({
			databaseUrl: database.url,
			dataDir,
			http,
			grpc: { host: "127.0.0.1", port: 0 },
		});

	it("重复的路由（在 app.register 的作用域里，ready 时才发现）：抛出 Fastify 原来的错误，不是 ListenError，说明里没有「监听失败」", async () => {
		hooks.duplicate = packagesApi.publish;

		const error = await start().then(
			() => undefined,
			(thrown: unknown) => thrown as NodeJS.ErrnoException,
		);

		expect(error, "应该启动失败").toBeDefined();
		expect(error).not.toBeInstanceOf(ListenError);
		expect(error?.code).toBe("FST_ERR_DUPLICATED_ROUTE");
		expect(error?.message).toContain("already declared");
		expect(error?.message).not.toContain("监听失败");
		expect(error?.message).not.toContain("SFLY_HTTP_HOST");
	}, 60_000);

	it("对照：端口被占用仍是「监听失败」（ListenError，错误码 EADDRINUSE），说明不变", async () => {
		const holder = createServer();
		await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
		const port = (holder.address() as { port: number }).port;
		try {
			const error = await start({ host: "127.0.0.1", port }).then(
				() => undefined,
				(thrown: unknown) => thrown as InstanceType<typeof ListenError>,
			);

			expect(error).toBeInstanceOf(ListenError);
			expect(error?.code).toBe("EADDRINUSE");
			expect(error?.message).toContain(
				`HTTP API监听失败（地址在 SFLY_HTTP_HOST、端口 SFLY_HTTP_PORT，端口 ${port}；错误码 EADDRINUSE）`,
			);
		} finally {
			await new Promise<void>((resolve) => holder.close(() => resolve()));
		}
	}, 60_000);
});
