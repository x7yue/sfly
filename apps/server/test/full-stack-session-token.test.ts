// 全栈（规格 #547，验收标准：工作台上 `sfly` 带着会话令牌被认成这个会话的令牌；一轮结束之后哪里都搜不到令牌的原值）：
// 真的控制面、真的助手服务（`SessionManager` 加 HTTP 服务，在测试进程里）、真的 pi 和打包好的远程工具扩展、照剧本回复的假模型、
// 真的 Rust Agent 作工作台、真的 `sfly` 命令行。假模型照剧本依次：用 `sfly scenario copy` 复制一个场景（命令行读环境变量
// `SFLY_API_TOKEN`，带 `Authorization: Bearer`）、在命令里打印令牌（`echo`、列环境变量、拆成几段打印）。
//
// 看两件事：
// 1. 控制面认出这枚令牌是这个会话的：复制出来的场景的第 1 版记着这个会话，会话里有一条 `scenario_version` 的平台记录；
//    这一轮结束之后这枚令牌立即 401，下一轮拿到的是另一枚。
// 2. 一轮跑完，在 `session_events`、助手的 `events.jsonl`（和助手数据目录里别的文件，含 pi 自己的会话文件）、控制面和助手服务的日志、
//    工作台的文件系统（命令的工作目录、Agent 的工作目录和主目录、Agent 的标准错误）里搜令牌的原值，都搜不到；命令输出里的令牌在
//    `session_events` 里是掩码。
//
// 助手服务和控制面之间隔一个转发：控制面写死工作区在 `/work`（骨架期间的桩，#549 换掉），而这里的 Agent 是普通用户起的进程，建不了
// `/work`；转发把交给助手服务的 `prompt` 里的工作区换成测试自己的临时目录，别的请求原样转发。
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { SessionDetailResponse, SessionView } from "@sfly/schema";
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Harness, SECRET } from "../../assistant/test/support/harness.js";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { bearer } from "./support/credentials.js";
import { describeWithAgent } from "./support/describe-with-agent.js";
import { eventually } from "./support/eventually.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { repoRoot } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";
import { asUsers } from "./support/user-api.js";

const WORKBENCH = "workbench-token";
const SCRIPT = "剧本：复制场景并打印令牌";
const SOURCE = "原场景";
const COPY = "会话复制出来的场景";

/** 一个目录树里内容含 `needle` 的文件（路径）；读不了的文件（套接字、没有权限的）跳过。 */
async function filesContaining(root: string, needle: string): Promise<string[]> {
	const found: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) {
				const content = await readFile(path).catch(() => undefined);
				if (content?.includes(needle)) found.push(path);
			}
		}
	};
	await walk(root);
	return found;
}

interface Proxy {
	url: string;
	/** 控制面交给助手服务的每一个 `prompt` 里的会话令牌（`secret_env.SFLY_API_TOKEN`），按到达的先后。 */
	tokens: string[];
	close(): Promise<void>;
}

/** 控制面和助手服务之间的转发：`prompt` 里的工作区换成 `workdir`，记下 `secret_env.SFLY_API_TOKEN`；别的请求原样转发（事件流照常流式）。 */
async function startProxy(target: string, workdir: string): Promise<Proxy> {
	const tokens: string[] = [];
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			let body = Buffer.concat(chunks);
			if (req.method === "POST" && /\/prompt$/.test(req.url ?? "")) {
				const parsed = JSON.parse(body.toString()) as {
					workbench: { workdir: string };
					secret_env: Record<string, string>;
				};
				const token = parsed.secret_env.SFLY_API_TOKEN;
				if (token !== undefined) tokens.push(token);
				parsed.workbench.workdir = workdir;
				body = Buffer.from(JSON.stringify(parsed));
			}
			const headers = { ...req.headers };
			if (body.length > 0) headers["content-length"] = String(body.length);
			const upstream = request(`${target}${req.url}`, { method: req.method, headers }, (answer) => {
				res.writeHead(answer.statusCode ?? 502, answer.headers);
				answer.pipe(res);
			});
			upstream.on("error", () => res.destroy());
			res.on("close", () => upstream.destroy());
			upstream.end(body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		tokens,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

describeWithAgent("全栈：会话令牌（真的 pi、假的模型、真的 Agent 作工作台、真的 sfly）", () => {
	let assistant: Harness;
	let cp: TestControlPlane;
	let agent: RealAgent;
	let proxy: Proxy;
	let api: ApiClient;
	let dir: string;
	let workdir: string;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	/** 控制面写到终端和 Fastify 日志里的全部内容。 */
	const controlPlaneLog: string[] = [];
	const spies: Array<{ mockRestore(): void }> = [];

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "sfly-full-session-token-"));
		workdir = join(dir, "work");
		const bin = join(dir, "bin");
		await mkdir(workdir, { recursive: true });
		await mkdir(bin, { recursive: true });
		// 工作台上的 `sfly`：用这个仓库里的命令行（uv 运行），在命令的工作目录里跑。
		await writeFile(
			join(bin, "sfly"),
			`#!/bin/sh\nexec uv run --locked --project ${JSON.stringify(repoRoot)} sfly "$@"\n`,
			{ mode: 0o755 },
		);
		assistant = await Harness.start();
		// 控制面的输出都收下来：Fastify 的日志、`printError`、`printInfo`（写到标准输出和标准错误）。
		const sink = new Writable({
			write(chunk, _encoding, done) {
				controlPlaneLog.push(String(chunk));
				done();
			},
		});
		for (const stream of [process.stdout, process.stderr]) {
			const spy = vi.spyOn(stream, "write");
			spy.mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
				controlPlaneLog.push(String(chunk));
				const callback = rest.find((arg) => typeof arg === "function") as
					| ((error?: Error | null) => void)
					| undefined;
				callback?.();
				return true;
			}) as never);
			spies.push(spy);
		}
		proxy = await startProxy(assistant.url, workdir);
		cp = await startTestControlPlane({
			assistantUrl: proxy.url,
			assistantSecret: SECRET,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 20, max: 100 },
			logger: { stream: sink },
		});
		api = new ApiClient(asUsers(cp));
		venv = await createStubVenv({ sdkOnly: true });
		agent = await startRealAgent({
			grpcUrl: cp.grpcUrl,
			name: WORKBENCH,
			venv: venv.path,
			bin: agentBinary(),
			captureStderr: true,
			// 命令行连这个控制面；令牌（`SFLY_API_TOKEN`）由控制面经助手服务放进每条命令的环境。
			env: { SFLY_SERVER: cp.httpUrl },
		});
		await eventually(async () => {
			const readiness = (await (await cp.fetch("/projects/default/sessions")).json()) as {
				readiness: { ready: boolean; problems: Array<{ message: string }> };
			};
			expect(readiness.readiness.problems.map((p) => p.message)).toEqual([]);
		}, 60_000);
		// 源场景：人建的，只有入口节点。
		await api.orchestrationWith(
			{ nodes: [{ id: "entry", kind: "entry", params: [] }], edges: [], packages: {} },
			SOURCE,
		);
	}, 600_000);

	afterAll(async () => {
		for (const spy of spies) spy.mockRestore();
		await agent?.close();
		await venv?.remove();
		await cp?.close();
		await proxy?.close();
		await assistant?.close();
		if (dir) await rm(dir, { recursive: true, force: true });
	}, 120_000);

	/** 直接读库。 */
	const query = async <T extends pg.QueryResultRow>(
		text: string,
		params: unknown[] = [],
	): Promise<T[]> => {
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			return (await client.query<T>(text, params)).rows;
		} finally {
			await client.end();
		}
	};
	const tokenStatus = async (token: string, sessionId: string): Promise<number> =>
		(await cp.fetch(`/sessions/${sessionId}`, { headers: bearer(token) })).status;
	const detail = async (id: string) =>
		(await (await api.get(`/sessions/${id}`)).json()) as SessionDetailResponse;

	it("工作台上的 sfly 被认成这个会话的令牌；命令里打印出令牌，哪里都搜不到原值；一轮结束令牌立即 401，下一轮是另一枚", async () => {
		assistant.model.scripts.set(SCRIPT, [
			{
				tool: "bash",
				args: {
					// 绝对路径：命令经登录 shell 运行（`bash -lc`），登录 shell 会重设 PATH，不认测试给 Agent 的 PATH。
					command: `${join(dir, "bin", "sfly")} scenario copy ${SOURCE} --name ${COPY}; echo "exit=$?"`,
					timeout: 280,
				},
			},
			{
				tool: "bash",
				args: { command: 'echo "token=$SFLY_API_TOKEN"; env | grep SFLY_API', timeout: 30 },
			},
			{
				tool: "bash",
				args: { command: "printf '%s' \"$SFLY_API_TOKEN\" | fold -w 5", timeout: 30 },
			},
			{ text: "做完了。" },
		]);
		const created = await api.post("/projects/default/sessions", { text: SCRIPT }, "alice");
		expect(created.status, await created.clone().text()).toBe(201);
		const view = (await created.json()) as SessionView;
		await eventually(
			async () => expect((await detail(view.id)).events.map((e) => e.type)).toContain("turn_end"),
			280_000,
		);
		const first = await detail(view.id);
		const shown = JSON.stringify(
			first.events.map((e) => [e.type, e.type === "tool_result" ? e.text : ""]),
		);
		expect(
			first.events.find((e) => e.type === "turn_end"),
			shown,
		).toMatchObject({
			outcome: "completed",
		});

		// 1. 工作台上的 sfly 的请求在控制面被认成这个会话的令牌：复制出来的场景的第 1 版记着这个会话，会话里有平台记录。
		const [value] = proxy.tokens;
		expect(value).toMatch(/^sfly_ses_[0-9a-f]{48}$/);
		const token = value as string;
		const [copy] = await query<{ id: string }>("select id from orchestrations where name = $1", [
			COPY,
		]);
		expect(copy, `会话的 sfly 复制出了场景：${shown}`).toBeDefined();
		expect(
			await query(
				"select session_id, author_token from orchestration_versions where orchestration_id = $1 and number = 1",
				[copy?.id],
			),
		).toEqual([{ session_id: view.id, author_token: `会话：${view.title}` }]);
		expect(first.events.filter((e) => e.type === "platform")).toEqual([
			expect.objectContaining({
				kind: "scenario_version",
				scenario_id: copy?.id,
				name: COPY,
				version: 1,
			}),
		]);

		// 2. 命令里打印出来的令牌，在 session_events 里是掩码。
		const results = first.events.flatMap((e) => (e.type === "tool_result" ? [e.text] : []));
		expect(results, shown).toHaveLength(3);
		expect(results[0]).toContain("exit=0");
		expect(results[1]).toContain("******");

		// 3. 一轮跑完，令牌的原值哪里都搜不到。
		const eventsJsonl = await assistant.rawSettled(view.id);
		expect(eventsJsonl).toContain("******");
		const where: Record<string, string> = {
			session_events: JSON.stringify(await query("select * from session_events")),
			"助手的 events.jsonl": eventsJsonl,
			控制面的日志: controlPlaneLog.join("\n"),
			助手服务的日志: assistant.logs.join("\n"),
			"Agent 的标准错误": agent.stderr(),
		};
		for (const [name, text] of Object.entries(where)) {
			expect(text, name).not.toContain(token);
		}
		// 库里每一张表：只有哈希。
		const tables = await query<{ tablename: string }>(
			"select tablename from pg_tables where schemaname = 'public'",
		);
		for (const { tablename } of tables) {
			const rows = await query<{ row: string }>(
				`select to_jsonb(t)::text as row from "${tablename}" t`,
			);
			for (const { row } of rows) expect(row, `表 ${tablename}`).not.toContain(token);
		}
		expect(
			(
				await query<{ token_hash: string }>(
					"select token_hash from api_tokens where session_id = $1",
					[view.id],
				)
			).map((row) => row.token_hash),
		).toEqual([createHash("sha256").update(token).digest("hex")]);
		// 文件系统：助手数据目录（含 pi 自己的会话文件、扩展的配置文件）、工作台上命令的工作目录和 Agent 的工作目录与主目录。
		for (const [name, root] of [
			["助手的数据目录", assistant.dataDir],
			["工作台的工作目录", workdir],
			["Agent 的工作目录和主目录", agent.workDir],
		] as const) {
			expect(await filesContaining(root, token), name).toEqual([]);
		}

		// 4. 一轮结束：这一轮的令牌立即 401；下一轮拿到另一枚，旧的仍然 401，下一轮结束它也 401。
		expect(await tokenStatus(token, view.id)).toBe(401);
		const said = await api.post(`/sessions/${view.id}/messages`, { text: "再说一句" }, "alice");
		expect(said.status, await said.clone().text()).toBe(200);
		await eventually(() => expect(proxy.tokens).toHaveLength(2));
		const second = proxy.tokens[1] as string;
		expect(second).toMatch(/^sfly_ses_[0-9a-f]{48}$/);
		expect(second).not.toBe(token);
		expect(await tokenStatus(token, view.id)).toBe(401);
		await eventually(
			async () =>
				expect((await detail(view.id)).events.filter((e) => e.type === "turn_end")).toHaveLength(2),
			120_000,
		);
		expect(await tokenStatus(second, view.id)).toBe(401);
	}, 600_000);
});
