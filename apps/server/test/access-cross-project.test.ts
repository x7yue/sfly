// 项目甲的凭据请求项目乙的资源，每个接口一条（ADR 0029「一处检查」，规格 #489）。
//
// 真实控制面和数据库。项目乙是默认项目（接口的路径还不带项目，#488 之前列表和新建都落在默认项目里），
// 有真实存在的场景、版本、预设、运行、任务、Agent、节点包和飞书机器人；项目甲 `alpha` 的各种凭据去请求它们，
// 每个属于项目的接口一条：被拒绝（经场景、运行、任务定位的资源和按名字定位的资源都是 404，不是 403；Agent 凭据和任务凭据
// 请求清单之外的接口是 403），写接口前后各取一份控制面留下的全部痕迹（库、序列、数据目录）和假飞书服务收到的请求，
// 没有任何变化。同一个请求用项目乙自己的凭据发一遍作对照：没有被访问检查拒绝（测试看错误说明认出访问检查的 404）。
//
// 每个接口、每种凭据都从路由清单和 test/support/credentials.ts 生成：新加接口自动进来，新加一种凭据在 ATTACKERS 里登记一次。
// 会话令牌在 #495 登记；任务凭据、Agent 凭据的签发在 #492，这里直接写库。
import { httpContract, RESOURCE_KINDS, type RouteDef } from "@sfly/schema";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCESS_NOT_FOUND_MESSAGE } from "../src/auth/access-guard.js";
import { routeKey } from "../src/auth/access-rules.js";
import { requiredScope } from "../src/auth/scopes.js";
import { guardHttpContract } from "../src/http/contract-route.js";
import { ApiClient } from "./support/api-client.js";
import { bearer, loginCookie, TestAccounts } from "./support/credentials.js";
import {
	expectedForAgent,
	expectedForTask,
	ID_PARAM_VALUES,
	NAME_PARAM_VALUES,
	projectRoutes,
	requestFor,
	systemRoutes,
	type Victim,
} from "./support/cross-project.js";
import { type FakeFeishu, startFakeFeishu } from "./support/fake-feishu.js";
import { publishPackage } from "./support/package-archive.js";
import { createPresetOk, presetScenario } from "./support/presets.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";
import { diffFootprints, settledFootprint } from "./support/write-footprint.js";

/** 一种凭据：请求头，以及它请求项目乙的这个接口时应得的状态。 */
interface Attacker {
	name: string;
	headers: Record<string, string>;
	expected(def: RouteDef): 403 | 404;
}

const isAccessNotFound = async (res: Response) => {
	const body = (await res
		.clone()
		.json()
		.catch(() => undefined)) as { error?: { message?: string } } | undefined;
	return res.status === 404 && body?.error?.message === ACCESS_NOT_FOUND_MESSAGE;
};

describe("项目甲的凭据请求项目乙的资源（每个属于项目的接口一条，从路由清单生成）", () => {
	let cp: TestControlPlane;
	let feishu: FakeFeishu;
	let accounts: TestAccounts;
	let victim: Victim;
	/** 项目乙里派给 agent-victim、正在运行的任务：它能上传产物。 */
	let runningTask: string;
	let attackers: Attacker[];
	/** 项目乙自己的凭据：对照。 */
	let insiders: { name: string; headers: Record<string, string> }[];

	beforeAll(async () => {
		feishu = await startFakeFeishu();
		cp = await startTestControlPlane();
		accounts = new TestAccounts(cp.database.url);
		const api = new ApiClient(cp);

		// 项目乙（默认项目）的资源。
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		const scenario = await api.orchestrationWith(presetScenario(), "项目乙的场景");
		const preset = (
			await createPresetOk(api, scenario, { name: "预设", params: [{ name: "host", value: "h" }] })
		).id;
		await api.createFeishuBot("bot-victim", feishu.webhookUrl("victim"));
		const run = "00000000-0000-4000-8000-0000000000a1";
		const chain = "00000000-0000-4000-8000-0000000000a2";
		const task = "00000000-0000-4000-8000-0000000000a3";
		runningTask = "00000000-0000-4000-8000-0000000000a4";
		const session = "00000000-0000-4000-8000-0000000000a5";
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			const at = "2026-01-01T00:00:00Z";
			await client.query(
				`insert into agents (name, project_id, info, status, registered_at, last_seen_at)
				values ('agent-victim', 'default', '{"agent_version":"0.5.0","os":"linux","arch":"x86_64","slots":2}', 'offline', $1, $1)`,
				[at],
			);
			await client.query(
				`insert into runs (id, orchestration_id, orchestration_version_id, project_id, triggered_by, params, status, started_at, ended_at)
				select $1, orchestration_id, id, 'default', '旧人', '{}', 'success', $2, $2
				from orchestration_versions where orchestration_id = $3`,
				[run, at, scenario],
			);
			await client.query(
				`insert into chain_instances (id, run_id, chain_id, depth, params, status, started_at, ended_at)
				values ($1, $2, 'entry', 0, '{}', 'success', $3, $3)`,
				[chain, run, at],
			);
			await client.query(
				`insert into tasks (id, run_id, chain_instance_id, node_id, attempt, agent_name, status, queued_at, started_at, ended_at)
				values ($1, $2, $3, 'a', 1, 'agent-victim', 'success', $4, $4, $4)`,
				[task, run, chain, at],
			);
			await client.query(
				`insert into tasks (id, run_id, chain_instance_id, node_id, attempt, agent_name, status, queued_at, started_at)
				values ($1, $2, $3, 'b', 1, 'agent-victim', 'running', $4, $4)`,
				[runningTask, run, chain, at],
			);
			await client.query(
				`insert into sessions (id, project_id, title, status, created_by, created_at, last_activity_at)
				values ($1, 'default', '项目乙的会话', 'idle', '旧人', $2, $2)`,
				[session, at],
			);
		} finally {
			await client.end();
		}
		victim = {
			scenario,
			run,
			task,
			session,
			preset,
			agent: "agent-victim",
			pkg: "stub",
			bot: "bot-victim",
			project: "default",
			token: await accounts.tokenId(
				await accounts.projectToken("default", { name: "victim-token" }),
			),
		};

		// 项目甲 alpha 里的凭据：每一种都是它能有的最大权限（项目管理员、全部范围）。
		await accounts.project("alpha");
		const mallory = await accounts.user("mallory");
		await accounts.member("alpha", mallory, "project_admin");
		const cookie = await accounts.login(mallory);
		// 同时是项目甲和项目乙的成员（项目乙的项目管理员），个人令牌限定在项目甲：只有「限定的项目」这一条挡得住。
		const dual = await accounts.user("dual");
		await accounts.member("alpha", dual, "project_admin");
		await accounts.member("default", dual, "project_admin");
		attackers = [
			{ name: "登录 Cookie", headers: loginCookie(cookie), expected: () => 404 },
			{
				name: "个人令牌（没有限定项目）",
				headers: bearer(await accounts.personalToken(mallory)),
				expected: () => 404,
			},
			{
				name: "个人令牌（限定项目甲）",
				headers: bearer(await accounts.personalToken(mallory, { project: "alpha" })),
				expected: () => 404,
			},
			{
				name: "个人令牌（限定项目甲，用户也是项目乙的项目管理员）",
				headers: bearer(await accounts.personalToken(dual, { project: "alpha" })),
				expected: () => 404,
			},
			{
				name: "项目令牌（项目甲）",
				headers: bearer(await accounts.projectToken("alpha")),
				expected: () => 404,
			},
			{
				name: "会话令牌（项目甲的会话）",
				headers: bearer(await accounts.sessionToken(mallory, "alpha")),
				expected: () => 404,
			},
			{
				name: "会话令牌（项目甲的会话，发起人也是项目乙的项目管理员）",
				headers: bearer(await accounts.sessionToken(dual, "alpha")),
				expected: () => 404,
			},
			{
				name: "Agent 凭据（项目甲）",
				headers: bearer(await accounts.agentCredential("alpha", "agent-victim")),
				expected: expectedForAgent,
			},
			{
				name: "任务凭据（项目甲）",
				headers: bearer(await accounts.taskCredential("alpha", task)),
				expected: expectedForTask,
			},
		];

		// 项目乙自己的凭据。
		const boss = await accounts.user("boss");
		await accounts.member("default", boss, "project_admin");
		insiders = [
			{ name: "项目乙的项目管理员（登录）", headers: loginCookie(await accounts.login(boss)) },
			{ name: "项目乙的项目令牌", headers: bearer(await accounts.projectToken("default")) },
		];
	}, 60_000);

	afterAll(async () => {
		await accounts?.close();
		await cp?.close();
		await feishu?.close();
	});

	/** 发请求；事件流只等响应头，随即断开。 */
	const send = async (
		def: RouteDef,
		request: ReturnType<typeof requestFor>,
		headers: Record<string, string>,
		method = request.method,
	) => {
		const controller = new AbortController();
		const res = await cp.fetch(request.path, {
			method,
			headers: { ...request.headers, ...headers },
			...(request.body === undefined || method === "HEAD" ? {} : { body: request.body }),
			signal: controller.signal,
		});
		if ("kind" in def && def.kind === "stream" && res.ok) {
			// 事件流不会结束：只要响应头。
			controller.abort();
			return new Response(null, { status: res.status, headers: res.headers });
		}
		return res;
	};

	for (const def of projectRoutes()) {
		const key = routeKey(def);
		it(key, async () => {
			const request = requestFor(def, victim);
			const writes = def.effect === "write";
			const before = writes ? await settledFootprint(cp.database.url, cp.dataDir) : undefined;
			const feishuBefore = feishu.requests.length;

			for (const attacker of attackers) {
				const res = await send(def, request, attacker.headers);
				const text = await res.clone().text();
				const expected = attacker.expected(def);
				expect(res.status, `${attacker.name}：${text}`).toBe(expected);
				if (expected === 404) expect(await isAccessNotFound(res), attacker.name).toBe(true);
				// Fastify 为 GET 自动生成的 HEAD 路由走同一处检查。
				if (def.method === "GET") {
					const head = await send(def, request, attacker.headers, "HEAD");
					expect(head.status, `${attacker.name}（HEAD）`).toBe(expected);
				}
			}

			if (before) {
				const after = await settledFootprint(cp.database.url, cp.dataDir);
				expect(diffFootprints(before, after), "项目甲的凭据没有改动任何东西").toEqual([]);
				expect(feishu.requests.length, "没有往飞书发消息").toBe(feishuBefore);
			}

			// 对照：项目乙自己的凭据没有被访问检查拒绝（请求走到了处理函数，结果是什么不看）。
			// 没有人和程序能调用的接口（上传产物只给 Agent 凭据）：人和程序的凭据是 403。
			for (const insider of insiders) {
				const res = await send(def, request, insider.headers);
				if (requiredScope(def) === null) {
					expect(res.status, insider.name).toBe(403);
					continue;
				}
				// 项目令牌不能带「管理」：管理范围的接口对它是 403（缺少范围），不是 404；别的接口走到了处理函数。
				if (insider.name.includes("项目令牌") && requiredScope(def) === "manage") {
					expect(res.status, insider.name).toBe(403);
					expect(await isAccessNotFound(res), insider.name).toBe(false);
					continue;
				}
				expect([401, 403], `${insider.name}：${await res.clone().text()}`).not.toContain(
					res.status,
				);
				expect(await isAccessNotFound(res), insider.name).toBe(false);
			}
		}, 30_000);
	}

	it("会话：路径参数填的是项目乙里真实存在的会话 ID（请求真的打到了会话上，不是 404 因为 ID 不对）", async () => {
		const get = projectRoutes().find((d) => routeKey(d) === "GET /sessions/:id") as RouteDef;
		const request = requestFor(get, victim);
		expect(request.path).toBe(`/sessions/${victim.session}`);
		// 项目乙自己的凭据读到了这个会话：项目乙的 ID 不会被当成任务或场景去查。
		for (const insider of insiders) {
			const res = await send(get, request, insider.headers);
			expect(res.status, insider.name).toBe(200);
			expect(await res.json(), insider.name).toMatchObject({
				id: victim.session,
				project: "default",
			});
		}
		// 项目甲的凭据读同一个 ID：访问检查的 404（和资源不存在一样的说法）。
		for (const attacker of attackers.filter((a) => a.expected(get) === 404)) {
			expect(
				await isAccessNotFound(await send(get, request, attacker.headers)),
				attacker.name,
			).toBe(true);
		}
	});

	it("对照：项目乙自己的 Agent 凭据、任务凭据能调用清单里的接口（上传产物、下载节点包归档、下载产物）", async () => {
		const own = {
			agent: bearer(await accounts.agentCredential("default", "agent-victim")),
			task: bearer(await accounts.taskCredential("default", victim.task)),
		};
		const upload = projectRoutes().find(
			(d) => routeKey(d) === "PUT /tasks/:id/artifacts/*",
		) as RouteDef;
		const archive = projectRoutes().find(
			(d) => routeKey(d) === "GET /packages/:name/versions/:version/archive",
		) as RouteDef;
		const download = projectRoutes().find(
			(d) => routeKey(d) === "GET /tasks/:id/artifacts/*",
		) as RouteDef;
		const mine = { ...victim, task: runningTask };
		const uploaded = await send(upload, requestFor(upload, mine), own.agent);
		expect(uploaded.status, await uploaded.clone().text()).toBe(201);
		const archived = await send(archive, requestFor(archive, mine), own.agent);
		expect(archived.status).toBe(200);
		const downloaded = await send(download, requestFor(download, mine), own.task);
		expect(downloaded.status, await downloaded.clone().text()).toBe(200);
		expect(await downloaded.text()).toBe("x");
		// 别的 Agent 的任务：项目乙里同名但不是它的任务也不行（任务是派给 agent-victim 的）。
		const other = bearer(await accounts.agentCredential("default", "agent-other"));
		expect((await send(upload, requestFor(upload, mine), other)).status).toBe(404);
		// 任务已经结束的上传，被处理函数拒绝（409）：请求过了访问检查，走到了处理函数。
		const finished = await send(upload, requestFor(upload, victim), own.agent);
		expect(finished.status).toBe(409);
		expect(await finished.json()).toMatchObject({ error: { code: "task_not_running" } });
	});
});

describe("第二个 ID 指向别的项目", () => {
	// 生成的测试每个接口只带项目乙的资源。路径里有第二个 ID（运行预设）的接口，项目甲的凭据拿自己的场景加项目乙的预设 ID：
	// 访问检查只看第一个 ID（场景，在项目甲里，通过），预设要由处理函数按场景限定，不会碰项目乙的预设。
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	let alphaScenario: string;
	let victimPreset: string;
	let attacker: Record<string, string>;

	beforeAll(async () => {
		cp = await startTestControlPlane();
		accounts = new TestAccounts(cp.database.url);
		const api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		const victimScenario = await api.orchestrationWith(presetScenario(), "项目乙的场景");
		victimPreset = (
			await createPresetOk(api, victimScenario, {
				name: "预设",
				params: [{ name: "host", value: "h" }],
			})
		).id;
		await accounts.project("alpha");
		alphaScenario = "00000000-0000-4000-8000-0000000000c1";
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			await client.query(
				`insert into orchestrations (id, project_id, name, head_version, created_at)
				values ($1, 'alpha', '项目甲的场景', 0, now())`,
				[alphaScenario],
			);
		} finally {
			await client.end();
		}
		const mallory = await accounts.user("mallory");
		await accounts.member("alpha", mallory, "project_admin");
		attacker = bearer(await accounts.personalToken(mallory));
	}, 60_000);
	afterAll(async () => {
		await accounts?.close();
		await cp?.close();
	});

	it("项目甲的场景 + 项目乙的预设 ID：改、复制、删除都得到 404，项目乙的预设没有变", async () => {
		const before = await settledFootprint(cp.database.url, cp.dataDir);
		const base = `/orchestrations/${alphaScenario}/presets/${victimPreset}`;
		const send = (method: string, path: string, body?: unknown) =>
			cp.fetch(path, {
				method,
				headers: {
					...attacker,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		for (const res of [
			await send("PATCH", base, { name: "被改名" }),
			await send("POST", `${base}/copy`, { name: "副本" }),
			await send("DELETE", base),
		]) {
			expect(res.status, await res.clone().text()).toBe(404);
		}
		// 对照：这个用户在自己的项目里的场景上，访问检查是通过的（场景没有版本，处理函数回答 404 说明没有这个预设）。
		const own = await send("GET", `/orchestrations/${alphaScenario}`);
		expect(own.status).toBe(200);
		const after = await settledFootprint(cp.database.url, cp.dataDir);
		expect(diffFootprints(before, after)).toEqual([]);
	});
});

describe("不属于项目的接口：不需要凭据，带什么凭据都不影响", () => {
	let cp: TestControlPlane;
	beforeAll(async () => {
		cp = await startTestControlPlane();
	});
	afterAll(async () => {
		await cp.close();
	});

	for (const def of systemRoutes()) {
		it(routeKey(def), async () => {
			const path = def.path.replace(/:[A-Za-z_][A-Za-z0-9_]*|\*$/g, "x");
			for (const headers of [
				{},
				bearer("sfly_pat_unknown"),
				loginCookie("expired"),
				{ authorization: "Bearer sfly_pat_unknown", cookie: "sfly_login=expired" },
			]) {
				const res = await cp.fetch(path, { method: def.method, headers });
				await res.arrayBuffer();
				expect([401, 403], `${def.method} ${path} ${JSON.stringify(headers)}`).not.toContain(
					res.status,
				);
			}
		});
	}
});

describe("新加接口自动覆盖", () => {
	const fake = {
		method: "POST",
		path: "/fake-things/:id",
		summary: "演示用的假接口",
		effect: "write",
		resource: { kind: "scenario", target: { params: "id" } },
		client: false,
		key: ["fake", "create"],
		response:
			httpContract[0] && "response" in httpContract[0] ? httpContract[0].response : undefined,
	} as unknown as RouteDef;
	const fakeRules = {
		pathKinds: {
			"/fake-things": { kind: "scenario", why: "演示" },
		},
		nonGetReads: {},
	} as const;

	it("没写声明的接口让启动守卫报错", () => {
		const undeclared = {
			...fake,
			effect: undefined,
			resource: undefined,
			summary: undefined,
		} as unknown as RouteDef;
		expect(() => guardHttpContract(Fastify(), [undeclared], fakeRules)).toThrow(/缺少 summary/);
		expect(() => guardHttpContract(Fastify(), [undeclared], fakeRules)).toThrow(/缺少 resource/);
	});

	it("路径参数 :id 属于不认识的资源类别时，生成请求就失败：不会悄悄填成场景 ID", () => {
		const victim = {
			scenario: "s",
			run: "r",
			task: "t",
			session: "e",
			preset: "p",
			agent: "a",
			pkg: "k",
			bot: "b",
			project: "default",
			token: "k",
		};
		const get = { ...fake, method: "GET", effect: "read" };
		const other = { ...get, resource: { kind: "package", target: { params: "id" } } } as RouteDef;
		expect(() => requestFor(other, victim)).toThrow(/没有取值办法/);
		for (const kind of ["scenario", "run", "task", "session"] as const) {
			const def = { ...get, resource: { kind, target: { params: "id" } } } as RouteDef;
			expect(requestFor(def, victim).path).toBe(
				`/fake-things/${{ scenario: "s", run: "r", task: "t", session: "e" }[kind]}`,
			);
		}
	});

	it("写了声明之后，生成的测试里就有它", () => {
		expect(() => guardHttpContract(Fastify(), [fake], fakeRules)).not.toThrow();
		const generated = projectRoutes([...httpContract, fake]).map(routeKey);
		expect(generated).toContain("POST /fake-things/:id");
		// 它是新的有请求体的写接口：没有请求样本时生成请求就失败，提醒补样本。
		expect(() =>
			requestFor(fake, {
				scenario: "s",
				run: "r",
				task: "t",
				session: "e",
				preset: "p",
				agent: "a",
				pkg: "k",
				bot: "b",
				project: "default",
				token: "k",
			}),
		).toThrow(/请求样本/);
	});
});

describe("生成的请求打的是那一类资源（资源类别穷举，#554）", () => {
	/** 每个字段一个不同的值：请求路径里出现的是哪一个，就说明请求打的是哪一类资源。 */
	const sample: Victim = {
		scenario: "sample-scenario",
		run: "sample-run",
		task: "sample-task",
		session: "sample-session",
		preset: "sample-preset",
		agent: "sample-agent",
		pkg: "sample-package",
		bot: "sample-bot",
		project: "sample-project",
		token: "sample-token",
	};

	it("每个资源类别在生成器里都有自己的取值办法：加了类别而没有补，类型检查和这条测试都会失败", () => {
		expect(Object.keys(ID_PARAM_VALUES).sort()).toEqual([...RESOURCE_KINDS].sort());
		expect(Object.keys(NAME_PARAM_VALUES).sort()).toEqual([...RESOURCE_KINDS].sort());
	});

	it("路径里有 :id 或 :name 的接口，请求打的是它声明的那一类资源，不是场景（也不是别的）", () => {
		let checked = 0;
		for (const def of projectRoutes()) {
			const { kind } = def.resource;
			const { path } = requestFor(def, sample);
			if (/:id\b/.test(def.path)) {
				const expected = ID_PARAM_VALUES[kind](sample);
				expect(expected, `${routeKey(def)}：${kind} 没有 :id 的取值办法`).not.toBeNull();
				expect(path, routeKey(def)).toContain(`/${expected}`);
				// 别的类别的值不该出现在路径里（场景的 ID 出现在运行的路径里，说明请求打错了资源）。
				for (const other of ["scenario", "run", "task", "token"] as const) {
					if (sample[other] !== expected) expect(path, routeKey(def)).not.toContain(sample[other]);
				}
				checked++;
			}
			if (/:name\b/.test(def.path)) {
				const expected = NAME_PARAM_VALUES[kind](sample);
				expect(expected, `${routeKey(def)}：${kind} 没有 :name 的取值办法`).not.toBeNull();
				expect(path, routeKey(def)).toContain(`/${expected}`);
				checked++;
			}
		}
		expect(checked).toBeGreaterThan(30);
	});

	it("项目令牌的接口：项目写进路径，令牌 ID 是项目乙里的令牌", () => {
		const revoke = httpContract.find((d) => routeKey(d) === "DELETE /projects/:project/tokens/:id");
		expect(revoke && requestFor(revoke, sample).path).toBe(
			"/projects/sample-project/tokens/sample-token",
		);
	});
});
