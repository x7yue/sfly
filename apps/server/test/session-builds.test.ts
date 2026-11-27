// 会话构建（#795）：登记在会话下（POST /sessions/:id/builds），版本号带这个会话的标签；只能被这个会话的场景版本锁定，
// 不进包列表、最新和默认版本；会话结束之后不能再引用，没有没结束的运行用它之后周期清理删掉行和归档文件。
// 会话令牌只能访问自己的会话（安全修复：之前同一个项目里别的会话的读接口也放行）。
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionBuildTag } from "@sfly/schema";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestAccounts } from "./support/credentials.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { packageArchive, packageMetadata, publishInit } from "./support/package-archive.js";
import { sfly } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const PKG = "demo-checks";

interface Problem {
	code: string;
	message: string;
}

/** 这个版本号的 demo-checks 归档（`sfly build` 的格式）。 */
const archiveOf = (version: string) =>
	packageArchive(packageMetadata({ name: PKG, version }), {
		[`demo_checks-${version}-py3-none-any.whl`]: new TextEncoder().encode("wheel"),
	});

describe("会话构建", () => {
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	let alice: string;
	const agents: FakeAgent[] = [];
	/** 会话 A、会话 B 和它们的会话令牌（同一个项目、同一个发起人）。 */
	let sessionA: string;
	let sessionB: string;
	let tokenA: string;
	let tokenB: string;
	let personal: string;

	const as = (token: string, init: RequestInit = {}): RequestInit => ({
		...init,
		headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
	});
	const json = (body: unknown): RequestInit => ({
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const register = (token: string, session: string, version: string) =>
		cp.fetch(`/sessions/${session}/builds`, as(token, publishInit(archiveOf(version))));
	const buildOf = (session: string, seq: number, base = "1.2.0") =>
		`${base}+${sessionBuildTag(session)}.${seq}`;
	const document = (version: string) => ({
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry" },
			{ id: "a", kind: "package", package: PKG, node: "ping", inputs: { host: "h" } },
		],
		edges: [{ from: "entry", to: "a", kind: "chain" }],
		packages: { [PKG]: version },
	});
	/** 用这个凭据在项目里建一个场景，存一个锁定 `version` 的版本；返回场景 ID 和保存时的警告。 */
	const scenarioBy = async (token: string, version: string, project = "default") => {
		const created = await cp.fetch(
			`/projects/${project}/orchestrations`,
			as(token, json({ name: `锁定 ${version}` })),
		);
		expect(created.status, await created.clone().text()).toBe(201);
		const { id } = (await created.json()) as { id: string };
		const saved = await cp.fetch(
			`/orchestrations/${id}/versions`,
			as(token, json({ base_version: 0, document: document(version) })),
		);
		expect(saved.status, await saved.clone().text()).toBe(201);
		const { warnings } = (await saved.json()) as { warnings: Problem[] };
		return { id, warnings: warnings.map((w) => w.code) };
	};
	const preflight = async (token: string, id: string) =>
		(
			(await (await cp.fetch(`/orchestrations/${id}/preflight`, as(token))).json()) as {
				problems: Problem[];
			}
		).problems.map((p) => p.code);
	const trigger = (token: string, id: string) =>
		cp.fetch(`/orchestrations/${id}/runs`, as(token, json({ params: {} })));
	const query = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => {
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			return (await client.query(sql, args)).rows as T[];
		} finally {
			await client.end();
		}
	};

	beforeEach(async () => {
		cp = await startTestControlPlane();
		accounts = new TestAccounts(cp.database.url);
		alice = await accounts.user("alice");
		await accounts.member("default", alice, "editor");
		sessionA = await accounts.session(alice, "default");
		sessionB = await accounts.session(alice, "default");
		tokenA = await accounts.sessionTokenIn(sessionA, alice, "default");
		tokenB = await accounts.sessionTokenIn(sessionB, alice, "default");
		personal = await accounts.personalToken(alice);
		agents.push(await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" }));
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await accounts.close();
		await cp.close();
	});

	it("会话令牌登记到自己的会话：列在会话下，不进包列表和版本详情，归档照常下载", async () => {
		const version = buildOf(sessionA, 1);
		const res = await register(tokenA, sessionA, version);
		expect(res.status, await res.clone().text()).toBe(201);
		expect(await res.json()).toMatchObject({ name: PKG, version });

		const listed = (await (await cp.fetch(`/sessions/${sessionA}/builds`, as(tokenA))).json()) as {
			builds: Array<{ name: string; version: string }>;
		};
		expect(listed.builds.map((b) => [b.name, b.version])).toEqual([[PKG, version]]);

		const { packages } = (await (
			await cp.fetch("/projects/default/packages", as(personal))
		).json()) as { packages: unknown[] };
		expect(packages).toEqual([]);
		const detail = await cp.fetch(
			`/projects/default/packages/${PKG}/versions/${encodeURIComponent(version)}`,
			as(personal),
		);
		expect(detail.status).toBe(404);
		const archive = await cp.fetch(
			`/projects/default/packages/${PKG}/versions/${encodeURIComponent(version)}/archive`,
			as(personal),
		);
		expect(archive.status).toBe(200);
	});

	it("版本号的标签不对时 400：没有标签、别的会话的、序号带前导零、大写；正式上传不能带会话构建的标签", async () => {
		for (const version of [
			"1.2.0",
			buildOf(sessionB, 1),
			`1.2.0+${sessionBuildTag(sessionA)}.01`,
			`1.2.0+${sessionBuildTag(sessionA).toUpperCase()}.1`,
		]) {
			const res = await register(tokenA, sessionA, version);
			expect(res.status, version).toBe(400);
			expect(((await res.json()) as { error: Problem }).error.code).toBe("invalid_package");
		}
		const formal = await cp.fetch(
			"/projects/default/packages",
			as(personal, publishInit(archiveOf(buildOf(sessionA, 1)))),
		);
		expect(formal.status).toBe(400);
		expect(((await formal.json()) as { error: Problem }).error.message).toContain(
			"sfly publish --session-build",
		);
	});

	it("安全修复：会话 A 的令牌对会话 B 的登记、列出、读会话都 403；人的凭据照常", async () => {
		expect((await register(tokenA, sessionB, buildOf(sessionB, 1))).status).toBe(403);
		expect((await cp.fetch(`/sessions/${sessionB}/builds`, as(tokenA))).status).toBe(403);
		expect((await cp.fetch(`/sessions/${sessionB}`, as(tokenA))).status).toBe(403);
		expect(await query("select 1 from node_packages")).toEqual([]);

		expect((await register(personal, sessionB, buildOf(sessionB, 1))).status).toBe(201);
		expect((await cp.fetch(`/sessions/${sessionB}/builds`, as(personal))).status).toBe(200);
		expect((await cp.fetch(`/sessions/${sessionA}`, as(tokenA))).status).toBe(200);
	});

	it("只能被这个会话的场景版本锁定：本会话存的能触发、派发；人存的、别的会话存的、别的项目的场景都找不到它", async () => {
		const version = buildOf(sessionA, 1);
		expect((await register(tokenA, sessionA, version)).status).toBe(201);

		const own = await scenarioBy(tokenA, version);
		expect(own.warnings).not.toContain("package_version_missing");
		expect(await preflight(tokenA, own.id)).toEqual([]);
		const started = await trigger(tokenA, own.id);
		expect(started.status, await started.clone().text()).toBe(201);
		const assign = await (agents[0] as FakeAgent).nextAssign();
		expect(assign.packageVersion).toBe(version);
		expect(assign.packageUrl).toContain(encodeURIComponent(version));

		const human = await scenarioBy(personal, version);
		expect(human.warnings).toContain("package_version_missing");
		expect(await preflight(personal, human.id)).toContain("package_version_missing");
		expect((await trigger(personal, human.id)).status).toBe(400);

		const other = await scenarioBy(tokenB, version);
		expect(other.warnings).toContain("package_version_missing");
		expect((await trigger(tokenB, other.id)).status).toBe(400);

		await accounts.project("other");
		await accounts.member("other", alice, "editor");
		const elsewhere = await scenarioBy(personal, version, "other");
		expect(elsewhere.warnings).toContain("package_version_missing");
	});

	it("局部编辑：本会话加节点时写明会话构建的版本，找得到它的节点类型；不写版本时默认版本不会选到它", async () => {
		const version = buildOf(sessionA, 1);
		expect((await register(tokenA, sessionA, version)).status).toBe(201);
		const { id } = await scenarioBy(tokenA, version);
		const edit = (operations: unknown[]) =>
			cp.fetch(
				`/orchestrations/${id}/edits/check`,
				as(tokenA, json({ base_version: 1, operations })),
			);
		const named = await edit([
			{
				op: "add_node",
				id: "b",
				package: PKG,
				node: "ping",
				version,
				inputs: { host: "h" },
				after: "a",
			},
		]);
		expect(named.status, await named.clone().text()).toBe(200);
		const { warnings } = (await named.json()) as { warnings: Problem[] };
		expect(warnings.map((w) => w.code)).toEqual([]);

		// 另一个包、只有会话构建：不写版本时没有默认版本（会话构建不进最新和默认版本）。
		const other = "other-checks";
		const otherVersion = buildOf(sessionA, 1, "2.0.0");
		const archive = packageArchive(packageMetadata({ name: other, version: otherVersion }), {
			[`other_checks-${otherVersion}-py3-none-any.whl`]: new TextEncoder().encode("wheel"),
		});
		expect(
			(await cp.fetch(`/sessions/${sessionA}/builds`, as(tokenA, publishInit(archive)))).status,
		).toBe(201);
		const unnamed = await edit([
			{ op: "add_node", id: "c", package: other, node: "ping", inputs: { host: "h" }, after: "a" },
		]);
		expect(unnamed.status).toBe(400);
		expect(((await unnamed.json()) as { error: Problem }).error.code).toBe("invalid_operation");
	});

	it("sfly publish --session-build：按会话加上标签、序号递增，不改源码；没有会话时说明要在工作台上用", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sfly-session-build-"));
		try {
			await mkdir(join(dir, "src", "demo_session"), { recursive: true });
			const pyproject = '[project]\nname = "demo-session"\nversion = "0.3.1"\ndependencies = []\n';
			await writeFile(join(dir, "pyproject.toml"), pyproject);
			await writeFile(join(dir, "src", "demo_session", "__init__.py"), "");
			await writeFile(
				join(dir, "src", "demo_session", "nodes.py"),
				'from sfly import Context, node\n\n@node(title="回显", outputs=["text"])\ndef echo(ctx: Context, text: str) -> dict:\n    return {"text": text}\n',
			);
			const env = { SFLY_API_TOKEN: tokenA, SFLY_SESSION_ID: sessionA };
			const args = ["publish", dir, "--session-build", "--server", cp.httpUrl];
			const first = await sfly(args, { env });
			expect(first.code, first.stderr).toBe(0);
			expect(first.stdout).toContain(`demo-session@0.3.1+${sessionBuildTag(sessionA)}.1`);
			const second = await sfly(args, { env });
			expect(second.code, second.stderr).toBe(0);
			expect(second.stdout).toContain(`demo-session@0.3.1+${sessionBuildTag(sessionA)}.2`);
			expect(await readFile(join(dir, "pyproject.toml"), "utf8")).toBe(pyproject);

			const outside = await sfly(args, {
				env: { SFLY_API_TOKEN: personal, SFLY_SESSION_ID: undefined },
			});
			expect(outside.code).toBe(1);
			expect(outside.stderr).toContain("SFLY_SESSION_ID");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 120_000);

	it("会话结束：不能再登记、新的触发找不到它；已经触发的照常派发，运行结束之后周期清理删掉行和归档文件", async () => {
		const version = buildOf(sessionA, 1);
		expect((await register(tokenA, sessionA, version)).status).toBe(201);
		const own = await scenarioBy(tokenA, version);
		const started = await trigger(tokenA, own.id);
		expect(started.status).toBe(201);
		const { id: runId } = (await started.json()) as { id: string };
		const agent = agents[0] as FakeAgent;
		const assign = await agent.nextAssign();
		const [row] = await query<{ file_path: string }>(
			"select file_path from node_packages where version = $1",
			[version],
		);
		const file = join(cp.dataDir, row?.file_path ?? "");
		expect(existsSync(file)).toBe(true);

		await query("update sessions set status = 'ended' where id = $1", [sessionA]);
		const again = await register(personal, sessionA, buildOf(sessionA, 2));
		expect(again.status).toBe(409);
		expect(((await again.json()) as { error: Problem }).error.code).toBe("session_ended");
		expect(await preflight(personal, own.id)).toContain("package_version_missing");

		// 运行还没结束：不回收。
		await new Promise((r) => setTimeout(r, 200));
		expect(await query("select 1 from node_packages where version = $1", [version])).toHaveLength(
			1,
		);

		await agent.succeed(assign, { alive: true });
		await eventually(async () => {
			const [run] = await query<{ status: string }>("select status from runs where id = $1", [
				runId,
			]);
			expect(run?.status).toBe("success");
		});
		await eventually(async () =>
			expect(await query("select 1 from node_packages where version = $1", [version])).toEqual([]),
		);
		expect(existsSync(file)).toBe(false);
	});
});
