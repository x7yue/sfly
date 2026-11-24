// 测试工具 `PgProxy` 自己的性质（#687）。
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgProxy } from "./support/pg-proxy.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

describe("PgProxy", () => {
	let database: TestDatabase;
	let proxy: PgProxy;

	beforeEach(async () => {
		database = await createTestDatabase("sfly_proxy");
		proxy = await PgProxy.start(database.url);
	}, 60_000);
	afterEach(async () => {
		await proxy.close();
		await database.drop();
	});

	/** 连上转发，一次写出去：启动消息，紧接着一条简单查询（数据库的回应、BackendKeyData 都还没到）。 */
	const sendQueryBeforeBackendKey = async (sql: string): Promise<Socket> => {
		const url = new URL(proxy.urlFor(database.url));
		const params = Buffer.from(
			`user\0${decodeURIComponent(url.username)}\0database\0${url.pathname.slice(1)}\0\0`,
		);
		const startup = Buffer.alloc(8 + params.length);
		startup.writeInt32BE(startup.length, 0);
		startup.writeInt32BE(196_608, 4);
		params.copy(startup, 8);
		const query = Buffer.alloc(6 + Buffer.byteLength(sql));
		query.write("Q", 0);
		query.writeInt32BE(query.length - 1, 1);
		query.write(sql, 5);
		const socket = new Socket();
		socket.on("error", () => {});
		await new Promise<void>((resolve) => socket.connect(Number(url.port), "127.0.0.1", resolve));
		socket.write(Buffer.concat([startup, query]));
		return socket;
	};

	it("terminate-backend 在还没收到后端进程号时触发：记在 failures 里，不是没人接的拒绝", async () => {
		proxy.arm(/^select 1$/, "terminate-backend");

		const socket = await sendQueryBeforeBackendKey("select 1");
		const until = Date.now() + 5_000;
		while (proxy.failures.length === 0 && Date.now() < until) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		socket.destroy();

		expect(proxy.fired.map((f) => f.action)).toEqual(["terminate-backend"]);
		expect(proxy.failures).toHaveLength(1);
		expect(proxy.failures[0]?.message).toContain("BackendKeyData");
	}, 30_000);
});
