// 全栈：会话构建（#795）。助手在会话里用 `sfly publish --session-build` 登记开发中的节点包（会话令牌、SFLY_SESSION_ID，
// 和工作台上一样），这个会话的场景锁定它、节点派到工作台以外的真实 Agent 上：Agent 下载、安装、执行的是这次构建的代码。
// 会话结束、运行结束之后周期清理回收它。
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sessionBuildTag } from "@sfly/schema";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { TestAccounts } from "./support/credentials.js";
import { describeWithAgent } from "./support/describe-with-agent.js";
import { eventually } from "./support/eventually.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { sfly } from "./support/sfly-cli.js";
import { makeTempDir } from "./support/temp-dir.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const AGENT = "sut-agent";

describeWithAgent("全栈：会话构建派到工作台以外的 Agent", () => {
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let agent: RealAgent;
	let dir: string;
	let session: string;
	let token: string;

	const call = async (path: string, body?: unknown) => {
		const res = await cp.fetch(path, {
			method: body === undefined ? "GET" : "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		expect(res.status, await res.clone().text()).toBeLessThan(300);
		return res.json() as Promise<Record<string, unknown>>;
	};
	const query = async (sql: string, args: unknown[] = []) => {
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			return (await client.query(sql, args)).rows;
		} finally {
			await client.end();
		}
	};

	beforeAll(async () => {
		dir = await makeTempDir("sfly-session-builds-");
		[cp, venv] = await Promise.all([startTestControlPlane(), createStubVenv({ sdkOnly: true })]);
		accounts = new TestAccounts(cp.database.url);
		const alice = await accounts.user("alice");
		await accounts.member("default", alice, "editor");
		session = await accounts.session(alice, "default");
		token = await accounts.sessionTokenIn(session, alice, "default");
		agent = await startRealAgent({ grpcUrl: cp.grpcUrl, name: AGENT, venv: venv.path });

		const src = join(dir, "src", "probe_demo");
		await mkdir(src, { recursive: true });
		await writeFile(
			join(dir, "pyproject.toml"),
			'[project]\nname = "probe-demo"\nversion = "0.3.1"\ndependencies = []\n',
		);
		await writeFile(join(src, "__init__.py"), "");
		await writeFile(
			join(src, "nodes.py"),
			[
				"from sfly import Context, node",
				"",
				'@node(title="探测", outputs=["where"])',
				"def probe(ctx: Context) -> dict:",
				'    return {"where": "开发中的代码"}',
				"",
			].join("\n"),
		);
	}, 600_000);

	afterAll(async () => {
		await agent?.close();
		await accounts?.close();
		await cp?.close();
		await venv?.remove();
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("登记、锁定、派到别的 Agent 上执行开发中的代码；会话结束、运行结束之后回收", async () => {
		const registered = await sfly(["publish", dir, "--session-build", "--server", cp.httpUrl], {
			env: { SFLY_API_TOKEN: token, SFLY_SESSION_ID: session },
		});
		expect(registered.code, registered.stderr).toBe(0);
		const version = `0.3.1+${sessionBuildTag(session)}.1`;
		expect(registered.stdout).toContain(`probe-demo@${version}`);

		const { id } = await call("/projects/default/orchestrations", { name: "联调副本" });
		await call(`/orchestrations/${id}/versions`, {
			base_version: 0,
			document: {
				default_agent: AGENT,
				nodes: [
					{ id: "entry", kind: "entry" },
					{ id: "a", kind: "package", package: "probe-demo", node: "probe", inputs: {} },
				],
				edges: [{ from: "entry", to: "a", kind: "chain" }],
				packages: { "probe-demo": version },
			},
		});
		const run = await call(`/orchestrations/${id}/runs`, { params: {} });
		await eventually(
			async () => expect((await call(`/runs/${run.id}`)).status).toBe("success"),
			120_000,
		);
		const view = (await call(`/runs/${run.id}`)) as {
			chains: Array<{ nodes: Array<{ node_id: string; agent: string; outputs: unknown }> }>;
		};
		expect(view.chains[0]?.nodes.find((n) => n.node_id === "a")).toMatchObject({
			agent: AGENT,
			outputs: { where: "开发中的代码" },
		});

		await query("update sessions set status = 'ended' where id = $1", [session]);
		await eventually(
			async () =>
				expect(await query("select 1 from node_packages where session_id = $1", [session])).toEqual(
					[],
				),
			30_000,
		);
	}, 300_000);
});
