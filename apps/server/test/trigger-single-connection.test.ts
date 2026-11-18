// 触发（Engine.trigger，#380）：事务里的预检和参数检查只用事务的连接。
// 引擎接在只有一个连接的连接池上：事务占着这个连接时，事务里再从连接池取连接会一直等下去（这里 1 秒后报错），
// 同一个连接上并发的查询会排队（pg 会打弃用警告，pg@9 不再支持）。
// 触发所需的数据（场景、节点包、Agent）由另一个正常的控制面准备，引擎直接连同一个数据库。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentHub } from "../src/agents/agent-hub.js";
import { Engine } from "../src/engine/engine.js";
import { EngineNotifications } from "../src/feishu/engine-notifications.js";
import { createParamsCheck, createPreflight } from "../src/runs/preflight.js";
import { Mutex } from "../src/util/mutex.js";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent } from "./support/fake-agent.js";
import { packageArchive, packageMetadata, publishInit } from "./support/package-archive.js";
import { type SingleConnection, singleConnection } from "./support/single-connection.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const VERSION = "0.0.0-test";
const ACTOR = { nickname: "测试", via: null };

/** clean(source: AgentName)：入口参数选的 Agent 要在触发时按实际值检查（paramsCheck）。 */
const metadata = packageMetadata({
	name: "logs",
	version: "1.0.0",
	nodes: [
		{
			name: "clean",
			title: "清洗",
			entry: "logs:clean",
			inputs: {
				type: "object",
				properties: { source: { type: "string", "x-sfly-type": "agent" } },
				required: ["source"],
				order: ["source"],
			},
			outputs: { type: "object", properties: {} },
		},
	],
});

const document = {
	default_agent: "runner",
	nodes: [
		{ id: "entry", kind: "entry", params: [{ name: "src", type: "string" }] },
		{
			id: "c",
			kind: "package",
			package: "logs",
			node: "clean",
			inputs: { source: "${{ params.src }}" },
		},
	],
	edges: [{ from: "entry", to: "c", kind: "chain" }],
	packages: { logs: "1.0.0" },
};

describe("触发时的预检", () => {
	let cp: TestControlPlane;
	let single: SingleConnection;
	let runner: FakeAgent;
	let id: string;

	beforeEach(async () => {
		cp = await startTestControlPlane({ version: VERSION });
		expect((await cp.fetch("/packages", publishInit(packageArchive(metadata)))).status).toBe(201);
		runner = await FakeAgent.connect(cp.grpcUrl, { name: "runner" });
		id = await new ApiClient(cp).orchestrationWith(document, "预检");
		single = singleConnection(cp.database.url);
	});
	afterEach(async () => {
		await single.end();
		await runner.disconnect();
		await cp.close();
	});

	/** 引擎接在只有一个连接的连接池上，其余按控制面的接法。 */
	function engine(): Engine {
		const { db } = single;
		const mutex = new Mutex();
		return new Engine({
			db,
			clock: cp.clock,
			mutex,
			hub: new AgentHub({ db, clock: cp.clock, mutex, version: VERSION }),
			packageArchiveUrl: () => "http://sfly.test/archive",
			artifactUploadUrl: () => "http://sfly.test/artifacts",
			preflight: createPreflight({ version: VERSION }),
			paramsCheck: createParamsCheck(),
			notifications: new EngineNotifications({
				logs: { appendSystem: async () => {} },
				delivery: { wake: () => {} },
				runUrl: () => undefined,
				focusDeps: { clock: cp.clock, queries: {} as never, onError: () => {} },
			}),
		});
	}

	it("触发：预检和参数检查只用事务的连接、一条一条地读", async () => {
		const outcome = await engine().trigger(id, { params: { src: "runner" } }, ACTOR);
		expect(outcome).toMatchObject({ ok: true });
		expect(single.mostPending()).toBe(1);
	});

	it("参数检查不通过时同样只用事务的连接：400 invalid_params", async () => {
		const outcome = await engine().trigger(id, { params: { src: "ghost" } }, ACTOR);
		expect(outcome).toMatchObject({ ok: false, status: 400, code: "invalid_params" });
		expect(single.mostPending()).toBe(1);
	});
});
