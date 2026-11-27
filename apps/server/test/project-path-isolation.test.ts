// 路径带项目的 Agent 和节点包接口（#488）：项目从路径里取。在库里建项目乙和它的 Agent、节点包，
// 对 `/projects/default/…` 逐个请求：响应里没有项目乙的东西，按名字取项目乙的 Agent、节点包是 404；
// 在默认项目里发布的节点包不出现在项目乙的列表里。不带凭据的请求照旧放行（到 #494），所以这里不带凭据，
// 平台管理员（在每个项目里都有项目管理员的权限）再请求一遍按名字定位的接口作对照。
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearer, TestAccounts } from "./support/credentials.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const OTHER = "beta";

describe("路径里的项目：默认项目读不到、改不了项目乙的 Agent 和节点包", () => {
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	let db: pg.Client;
	let admin: Record<string, string>;

	beforeAll(async () => {
		cp = await startTestControlPlane();
		accounts = new TestAccounts(cp.database.url);
		db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		await accounts.project(OTHER);
		admin = bearer(await accounts.personalToken(await accounts.user("root", { admin: true })));
		await db.query(
			`insert into agents (name, project_id, info, status, registered_at, last_seen_at)
			 values ('beta-agent', $1, '{}', 'offline', now(), now())`,
			[OTHER],
		);
		await db.query(
			`insert into node_packages (name, version, project_id, metadata, file_path, sha256, size, published_at)
			 values ('beta-pkg', '1.0.0', $1, '{"name":"beta-pkg","version":"1.0.0","nodes":[]}'::jsonb,
			 'packages/beta-pkg/1.0.0.sflypkg', 'x', 1, now())`,
			[OTHER],
		);
		await accounts.agentCredential(OTHER, "beta-agent");
		await publishPackage(cp, "mine", "1.0.0", { echo: ["v"] });
	});
	afterAll(async () => {
		await db?.end();
		await accounts?.close();
		await cp?.close();
	});

	const json = async (path: string, headers: Record<string, string> = {}) => {
		const res = await cp.fetch(path, { headers });
		expect(res.status, `${path}：${await res.clone().text()}`).toBe(200);
		return res.json() as Promise<Record<string, Array<{ name: string }>>>;
	};

	it("列表：默认项目的 Agent、节点包里没有项目乙的；项目乙的列表里没有默认项目里新发布的", async () => {
		const agents = (await json("/projects/default/agents")).agents ?? [];
		expect(agents.map((a) => a.name)).not.toContain("beta-agent");
		const packages = (await json("/projects/default/packages")).packages ?? [];
		expect(packages.map((p) => p.name)).toContain("mine");
		expect(packages.map((p) => p.name)).not.toContain("beta-pkg");

		const theirs = (await json(`/projects/${OTHER}/packages`)).packages ?? [];
		expect(theirs.map((p) => p.name)).toEqual(["beta-pkg"]);
		const theirAgents = (await json(`/projects/${OTHER}/agents`)).agents ?? [];
		expect(theirAgents.map((a) => a.name)).toEqual(["beta-agent"]);
	});

	it("按名字取项目乙的 Agent、节点包：在默认项目的路径下是 404（平台管理员也一样）", async () => {
		for (const headers of [{}, admin]) {
			for (const path of [
				"/projects/default/packages/beta-pkg",
				"/projects/default/packages/beta-pkg/versions/1.0.0",
				"/projects/default/packages/beta-pkg/versions/1.0.0/archive",
			]) {
				expect((await cp.fetch(path, { headers })).status, path).toBe(404);
			}
		}
		const credentials = await cp.fetch("/projects/default/agents/beta-agent/credentials", {
			headers: admin,
		});
		expect(credentials.status).toBe(200);
		expect(await credentials.json()).toEqual({ credentials: [] });
		for (const action of ["disable", "enable"]) {
			const res = await cp.fetch(`/projects/default/agents/beta-agent/${action}`, {
				method: "POST",
				headers: admin,
			});
			expect(res.status, action).toBe(404);
		}
		const row = await db.query("select disabled_at from agents where name = 'beta-agent'");
		expect(row.rows).toEqual([{ disabled_at: null }]);
	});
});
