// 同一台机器上两个项目各有一台 Agent（#500 验收第 2 条）：凭据经 `/projects/<项目>/agents/<名字>/credentials` 签发，
// 两台同时在线、各做各的；两边都能下载公共项目里的包（#501），别的项目的私有包下载不到。
// 真实控制面和数据库，假的 Agent；场景的列表和新建还在默认项目（#488），项目乙的场景和包用库里的一条 `update` 挪过去。
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { bearer, TestAccounts } from "./support/credentials.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import { packageArchive, packageMetadata, publishPackage } from "./support/package-archive.js";
import { publishIntoPublicProject } from "./support/std-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const ALPHA = "alpha";

const node = (id: string, pkg: string) => ({
	id,
	kind: "package",
	package: pkg,
	node: "run",
	inputs: {},
});

/** 入口 → 公共项目的包的节点 → 本项目私有包的节点。 */
const doc = (agent: string, own: string) => ({
	default_agent: agent,
	nodes: [
		{ id: "entry", kind: "entry", params: [] },
		node("shared", "shared-tools"),
		node("own", own),
	],
	edges: [
		{ from: "entry", to: "shared", kind: "chain" },
		{ from: "shared", to: "own", kind: "chain" },
	],
	packages: { "shared-tools": "1.0.0", [own]: "1.0.0" },
});

describe("一台机器给两个项目用：两台 Agent 同时在线、各做各的（#500、#501）", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let accounts: TestAccounts;
	let sql: pg.Client;
	const agents: FakeAgent[] = [];
	const admins: Record<string, Record<string, string>> = {};

	/** 项目管理员经接口给这台 Agent 签发凭据，Agent 用它连上。 */
	const connectIn = async (project: string, name: string) => {
		const res = await cp.fetch(`/projects/${project}/agents/${name}/credentials`, {
			method: "POST",
			headers: { "content-type": "application/json", ...admins[project] },
			body: "{}",
		});
		expect(res.status, await res.clone().text()).toBe(201);
		const { token } = (await res.json()) as { token: string };
		const agent = await FakeAgent.connect(cp.grpcUrl, { name, token, slots: 2 });
		agents.push(agent);
		return agent;
	};
	const listed = async (project: string) => {
		const res = await cp.fetch(`/projects/${project}/agents`, { headers: admins[project] });
		expect(res.status).toBe(200);
		return ((await res.json()) as { agents: { name: string }[] }).agents.map((a) => a.name);
	};
	const scenarioIn = async (project: string, document: unknown) => {
		const id = await api.orchestrationWith(document, `${project} 的巡检`);
		await sql.query("update orchestrations set project_id = $2 where id = $1", [id, project]);
		return id;
	};
	const download = (agent: FakeAgent, url: string) => fetch(url, { headers: agent.auth });
	const archiveUrl = (project: string, pkg: string) =>
		`${cp.httpUrl}/projects/${project}/packages/${pkg}/versions/1.0.0/archive`;

	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		accounts = new TestAccounts(cp.database.url);
		sql = new pg.Client({ connectionString: cp.database.url });
		await sql.connect();
		await accounts.project(ALPHA);
		for (const project of ["default", ALPHA]) {
			const boss = await accounts.user(`boss_${project}`);
			await accounts.member(project, boss, "project_admin");
			admins[project] = bearer(await accounts.personalToken(boss));
		}
		const metadata = (name: string) =>
			packageMetadata({
				name,
				version: "1.0.0",
				nodes: [
					{
						name: "run",
						title: "run",
						entry: `${name.replace(/-/g, "_")}.nodes:run`,
						inputs: { type: "object", properties: {}, additionalProperties: true },
						outputs: { type: "object", properties: {} },
					},
				],
			});
		await publishIntoPublicProject(cp, packageArchive(metadata("shared-tools")), {
			name: "shared-tools",
			version: "1.0.0",
		});
		await publishPackage(cp, "tools-default", "1.0.0", { run: [] });
		await publishPackage(cp, "tools-alpha", "1.0.0", { run: [] });
		await sql.query("update node_packages set project_id = $1 where name = 'tools-alpha'", [ALPHA]);
	});
	afterAll(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await sql?.end();
		await accounts?.close();
		await cp?.close();
	});

	it("两台同时在线，各自的项目里只看得到自己那台；两边的运行各自派发到自己的 Agent，都下载得到公共项目里的包，下载不到对方的私有包", async () => {
		const mine = await connectIn("default", "box-default");
		const theirs = await connectIn(ALPHA, "box-alpha");
		expect(await listed("default")).toEqual(["box-default"]);
		expect(await listed(ALPHA)).toEqual(["box-alpha"]);

		const runDefault = await api.triggerOk(
			await scenarioIn("default", doc("box-default", "tools-default")),
		);
		const runAlpha = await api.triggerOk(await scenarioIn(ALPHA, doc("box-alpha", "tools-alpha")));

		const steps: [FakeAgent, string, string][] = [
			[mine, "default", "tools-default"],
			[theirs, ALPHA, "tools-alpha"],
		];
		for (const [agent, project, own] of steps) {
			const shared: AssignedTask = await agent.nextAssign();
			expect(shared.nodeId).toBe("shared");
			// 公共项目里的包：地址在 /projects/public/… 下，别的项目的 Agent 也下载得到。
			expect(shared.packageUrl).toBe(archiveUrl("public", "shared-tools"));
			expect((await download(agent, shared.packageUrl)).status, project).toBe(200);
			await agent.succeed(shared, {});

			const task = await agent.nextAssign();
			expect(task.nodeId).toBe("own");
			expect(task.packageUrl).toBe(archiveUrl(project, own));
			expect((await download(agent, task.packageUrl)).status, project).toBe(200);
			await agent.succeed(task, {});
		}
		// 各做各的：谁也没收到对方的任务。
		await mine.expectNoAssign();
		await theirs.expectNoAssign();
		for (const runId of [runDefault, runAlpha]) {
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
		}

		// 对方的私有包：按自己的项目和按对方的项目都下载不到。
		for (const [agent, other] of [
			[mine, archiveUrl(ALPHA, "tools-alpha")],
			[theirs, archiveUrl("default", "tools-default")],
			[theirs, archiveUrl(ALPHA, "tools-default")],
		] as const) {
			expect((await download(agent, other)).status, other).toBe(404);
		}
	});
});
