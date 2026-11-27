// 记录「经哪个 AI 编程助手」（规格 #238、ADR 0020）：控制面从 `x-sfly-client` 请求头里的 `agent/<名称>`
// 记在触发的运行、取消请求和保存的场景版本上，接口返回；只是标注，不影响昵称。
import { cp as copy, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orchestrationsApi, runListApi, runsApi } from "@sfly/schema";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir } from "../src/db/database.js";
import { ApiClient } from "./support/api-client.js";
import { actAs } from "./support/credentials.js";
import { FakeAgent } from "./support/fake-agent.js";
import { appendStartupStubs, dropStartupStubs } from "./support/migrations.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const DOCUMENT = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [] },
		{ id: "a", kind: "package", package: "stub", node: "echo" },
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
};

const CLAUDE_CODE = "sfly-cli/0.5.0 agent/claude-code";
const CODEX = "sfly-cli/0.5.0 agent/codex";

describe("经哪个 AI 编程助手", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	/** 带昵称的写请求；client 是 `x-sfly-client` 请求头的值，不给就不带这个头（浏览器的请求就是这样）。 */
	const write = (path: string, body: unknown, client?: string, nickname = "小明") =>
		cp.fetch(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...actAs(nickname),
				...(client === undefined ? {} : { "x-sfly-client": client }),
			},
			body: JSON.stringify(body),
		});

	const trigger = async (scenario: string, client?: string) => {
		const res = await write(`/orchestrations/${scenario}/runs`, { params: {} }, client);
		expect(res.status, await res.clone().text()).toBe(201);
		return runsApi.trigger.response.parse(await res.json());
	};

	const save = async (scenario: string, base: number, client?: string) => {
		const res = await write(
			`/orchestrations/${scenario}/versions`,
			{ base_version: base, document: DOCUMENT },
			client,
		);
		expect(res.status, await res.clone().text()).toBe(201);
		return orchestrationsApi.saveVersion.response.parse(await res.json());
	};

	it("带 agent/claude-code 触发运行：触发的响应、运行详情和两个运行列表都返回 claude-code，昵称不变", async () => {
		const scenario = await api.orchestrationWith(DOCUMENT);

		const triggered = await trigger(scenario, CLAUDE_CODE);
		expect(triggered).toMatchObject({ triggered_by: "小明", triggered_via: "claude-code" });

		expect(await api.run(triggered.id)).toMatchObject({
			triggered_by: "小明",
			triggered_via: "claude-code",
		});
		const perScenario = runsApi.listForOrchestration.response.parse(
			await api.getJson(`/orchestrations/${scenario}/runs`),
		);
		expect(perScenario.runs[0]).toMatchObject({ id: triggered.id, triggered_via: "claude-code" });
		const records = runListApi.list.response.parse(await api.getJson("/runs"));
		expect(records.runs[0]).toMatchObject({ id: triggered.id, triggered_via: "claude-code" });
	});

	it("取消运行：取消请求带 agent/codex 时记在 cancel.requested_via，触发和取消各记各的", async () => {
		const scenario = await api.orchestrationWith(DOCUMENT);
		const triggered = await trigger(scenario, CLAUDE_CODE);
		await agent.nextAssign();

		const res = await write(`/runs/${triggered.id}/cancel`, {}, CODEX, "小红");
		expect(res.status, await res.clone().text()).toBe(200);
		const cancelled = runsApi.cancel.response.parse(await res.json());
		expect(cancelled).toMatchObject({
			triggered_via: "claude-code",
			cancel: { requested_by: "小红", requested_via: "codex" },
		});
		expect((await api.run(triggered.id)).cancel).toMatchObject({ requested_via: "codex" });
	});

	it("取消请求没有这个请求头时 requested_via 为空，即使触发时带了", async () => {
		const scenario = await api.orchestrationWith(DOCUMENT);
		const triggered = await trigger(scenario, CLAUDE_CODE);
		await agent.nextAssign();

		expect((await api.cancelOk(triggered.id)).cancel).toMatchObject({
			requested_by: "tester",
			requested_via: null,
		});
	});

	it("没有请求头，或请求头里没有可用的 agent/ 部分时为空（人在浏览器里的操作就是这样）", async () => {
		const scenario = await api.orchestrationWith(DOCUMENT);
		for (const client of [undefined, "", "sfly-cli/0.5.0", "sfly-cli/0.5.0 agent/", "agent"]) {
			const run = await trigger(scenario, client);
			expect(run.triggered_via, `x-sfly-client: ${client}`).toBeNull();
			const version = await save(scenario, await api.headVersion(scenario), client);
			expect(version.author_via, `x-sfly-client: ${client}`).toBeNull();
		}
	});

	it("名称原样记录，不限于已知的助手；agent/ 部分可以在任意位置", async () => {
		const scenario = await api.orchestrationWith(DOCUMENT);
		expect((await trigger(scenario, "sfly-cli/0.5.0 agent/my-assistant")).triggered_via).toBe(
			"my-assistant",
		);
		expect((await trigger(scenario, "agent/codex sfly-cli/0.5.0")).triggered_via).toBe("codex");
	});

	// 客户端自己报的、存下来之后显示在别人的命令行和控制台里（#670）：只留字母、数字和 . _ + -，最多 64 个字符；
	// 别的整段丢掉（和没有这个请求头一样），请求照常成功。HTTP 请求头的值里能到服务端的是可见的 ASCII 和 U+0080–U+00FF
	// （8 位的控制序列 U+009B、下一行 U+0085、软连字符 U+00AD 都在里面）。字符都用码位造出来。
	it("名称里有 8 位的控制序列、软连字符、符号、空格以外的字符，或超过 64 个字符：存固定的占位值 ?（不可能是合格的名称，显示成「未知」，和库里旧的不合格值一样），请求照常成功；合格的照常记；没有 agent/ 的照旧没有标注", async () => {
		const scenario = await api.orchestrationWith(DOCUMENT);
		const c = (...points: number[]) => String.fromCodePoint(...points);
		for (const bad of [
			`sfly-cli/0.5.0 agent/codex${c(0x9b)}2J`,
			`sfly-cli/0.5.0 agent/${c(0x85)}codex`,
			`sfly-cli/0.5.0 agent/co${c(0xad)}dex`,
			"sfly-cli/0.5.0 agent/<b>codex</b>",
			"sfly-cli/0.5.0 agent/a:b",
			`sfly-cli/0.5.0 agent/${"a".repeat(65)}`,
			`sfly-cli/0.5.0 agent/${c(0xe9)}`,
		]) {
			const run = await trigger(scenario, bad);
			expect(run.triggered_via, JSON.stringify(bad)).toBe("?");
			expect(await api.run(run.id), JSON.stringify(bad)).toMatchObject({
				triggered_via: "?",
			});
			const version = await save(scenario, await api.headVersion(scenario), bad);
			expect(version.author_via, JSON.stringify(bad)).toBe("?");
		}
		// 正好 64 个、各种允许的符号：照常记。
		// `unknown` 本身是合格的名称，照常记，和占位值 `?` 分得开。
		for (const good of ["a".repeat(64), "my_assistant-1.2+beta", "Claude-Code", "unknown"]) {
			const run = await trigger(scenario, `sfly-cli/0.5.0 agent/${good}`);
			expect(run.triggered_via, good).toBe(good);
		}
		// 请求头里没有 agent/ 部分、名称为空：照旧没有标注。
		for (const none of ["sfly-cli/0.5.0", "sfly-cli/0.5.0 agent/", "agent"]) {
			expect((await trigger(scenario, none)).triggered_via, none).toBeNull();
		}
		// 第一个 agent/ 不合格、后面还有合格的：用后面的。
		expect(
			(await trigger(scenario, `agent/bad${c(0x9b)} agent/codex sfly-cli/0.5.0`)).triggered_via,
		).toBe("codex");
	});

	it("保存场景版本：保存的响应、版本列表、版本详情和编辑起点都返回作者经哪个助手", async () => {
		const scenario = await api.orchestrationWith(DOCUMENT);
		const byBrowser = await save(scenario, 1);
		const byClaude = await save(scenario, 2, CLAUDE_CODE);
		expect(byBrowser).toMatchObject({ number: 2, author: "小明", author_via: null });
		expect(byClaude).toMatchObject({ number: 3, author: "小明", author_via: "claude-code" });

		const listed = orchestrationsApi.versions.response.parse(
			await api.getJson(`/orchestrations/${scenario}/versions`),
		);
		expect(listed.versions.map((v) => [v.number, v.author_via])).toEqual([
			[3, "claude-code"],
			[2, null],
			[1, null],
		]);
		expect(
			orchestrationsApi.version.response.parse(
				await api.getJson(`/orchestrations/${scenario}/versions/3`),
			),
		).toMatchObject({ author_via: "claude-code" });
		expect(
			orchestrationsApi.head.response.parse(await api.getJson(`/orchestrations/${scenario}/head`)),
		).toMatchObject({ number: 3, author_via: "claude-code" });
	});

	it("保存冲突的响应里，最新版本的 head 带着它的 author_via", async () => {
		const scenario = await api.orchestrationWith(DOCUMENT);
		await save(scenario, 1, CODEX);

		const res = await write(
			`/orchestrations/${scenario}/versions`,
			{ base_version: 1, document: DOCUMENT },
			CLAUDE_CODE,
		);
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			error: { details: { head: { number: 2, author_via: "codex" } } },
		});
	});

	it("复制场景和恢复历史版本生成的新版本，同样记录经哪个助手", async () => {
		const scenario = await api.orchestrationWith(DOCUMENT);
		await save(scenario, 1);

		const restored = await write(`/orchestrations/${scenario}/versions/1/restore`, {}, CODEX);
		expect(restored.status, await restored.clone().text()).toBe(201);
		expect(orchestrationsApi.restoreVersion.response.parse(await restored.json())).toMatchObject({
			number: 3,
			author_via: "codex",
		});

		const copied = await write(`/orchestrations/${scenario}/copy`, { name: "副本" }, CLAUDE_CODE);
		expect(copied.status, await copied.clone().text()).toBe(201);
		const copyId = ((await copied.json()) as { id: string }).id;
		expect(
			orchestrationsApi.version.response.parse(
				await api.getJson(`/orchestrations/${copyId}/versions/1`),
			),
		).toMatchObject({ author: "小明", author_via: "claude-code" });
	});
});

describe("升级前已有的运行和版本", () => {
	let cp: TestControlPlane;
	let oldMigrations: string;

	/** 只含升级前（0000–0022）的迁移的目录，模拟旧版控制面的数据库。 */
	const migrationsBefore = async (next: number) => {
		const dir = await mkdtemp(join(tmpdir(), "sfly-migrations-"));
		await copy(defaultMigrationsDir, dir, { recursive: true });
		const journalPath = join(dir, "meta", "_journal.json");
		const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
			entries: { idx: number }[];
		};
		journal.entries = journal.entries.filter((e) => e.idx < next);
		await writeFile(journalPath, JSON.stringify(journal));
		// 当前代码启动时读写的 agent_credentials：旧迁移里没有，补一个占位，升级前删掉。
		await appendStartupStubs(dir);
		return dir;
	};

	beforeEach(async () => {
		oldMigrations = await migrationsBefore(23);
		cp = await startTestControlPlane({ migrationsDir: oldMigrations });
	});
	afterEach(async () => {
		await cp.close();
		await rm(oldMigrations, { recursive: true, force: true });
	});

	it("升级后照常可读，经哪个助手为空", async () => {
		const ids = {
			scenario: "00000000-0000-4000-8000-000000000001",
			version: "00000000-0000-4000-8000-000000000002",
			run: "00000000-0000-4000-8000-000000000003",
		};
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			const at = "2026-01-01T00:00:00Z";
			await client.query(
				"insert into orchestrations (id, name, description, head_version, created_at) values ($1, '旧场景', '', 1, $2)",
				[ids.scenario, at],
			);
			await client.query(
				`insert into orchestration_versions (id, orchestration_id, number, document, author, created_at)
				values ($1, $2, 1, $3, '旧人', $4)`,
				[
					ids.version,
					ids.scenario,
					JSON.stringify({
						default_agent: "agent-a",
						nodes: [{ id: "entry", kind: "entry", params: [] }],
						edges: [],
						packages: {},
					}),
					at,
				],
			);
			await client.query(
				`insert into runs (id, orchestration_id, orchestration_version_id, triggered_by, params, status,
					started_at, ended_at, cancel_requested_at, cancel_requested_by)
				values ($1, $2, $3, '旧人', '{}', 'cancelled', $4, $4, $4, '旧人')`,
				[ids.run, ids.scenario, ids.version, at],
			);
		} finally {
			await client.end();
		}

		await cp.restart(() => dropStartupStubs(cp.database.url), {
			migrationsDir: defaultMigrationsDir,
		});

		const api = new ApiClient(cp);
		expect(await api.run(ids.run)).toMatchObject({
			triggered_by: "旧人",
			triggered_via: null,
			cancel: { requested_by: "旧人", requested_via: null },
		});
		const versions = orchestrationsApi.versions.response.parse(
			await api.getJson(`/orchestrations/${ids.scenario}/versions`),
		);
		expect(versions.versions).toEqual([
			{ number: 1, author: "旧人", author_via: null, created_at: "2026-01-01T00:00:00.000Z" },
		]);
		const records = runListApi.list.response.parse(await api.getJson("/runs"));
		expect(records.runs[0]).toMatchObject({ id: ids.run, triggered_via: null });
	});
});
