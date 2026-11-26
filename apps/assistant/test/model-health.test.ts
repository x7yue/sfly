// 模型的就绪状态（#548）：配没配好、试连（启动时和之后每 5 分钟）、新的一轮能不能开始。试连只建连接，不调模型。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantModelHealth } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	connectProbe,
	MODEL_PROBE_INTERVAL_MS,
	ModelHealth,
	type Probe,
	type ProbeResult,
} from "../src/model-health.js";
import { eventually } from "./support/eventually.js";
import { ManualClock } from "./support/manual-clock.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sfly-model-health-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const KEY = "sk-do-not-echo-0123456789";

/** 一份指向 `baseUrl` 的模型文件，密钥是环境变量 `ACME_KEY` 的引用。 */
function modelsFile(baseUrl = "http://llm.internal:8177/v1/chat?token=do-not-echo"): string {
	const path = join(dir, "models.json");
	writeFileSync(
		path,
		JSON.stringify({
			providers: {
				acme: { baseUrl, api: "openai-completions", apiKey: "$ACME_KEY", models: [{ id: "big" }] },
			},
		}),
	);
	return path;
}

/** 试连的替身：记下每次试的端点，结果由测试给。 */
function fakeProbe(results: ProbeResult[]) {
	const calls: Array<{ host: string; port: number; tls: boolean }> = [];
	const probe: Probe = async (endpoint) => {
		calls.push({ host: endpoint.host, port: endpoint.port, tls: endpoint.tls });
		return results.shift() ?? { ok: true };
	};
	return { probe, calls };
}

function start(
	options: {
		path?: string;
		model?: string | undefined;
		env?: NodeJS.ProcessEnv;
		clock?: ManualClock;
		probe?: Probe;
	} = {},
) {
	const logs: string[] = [];
	const health = new ModelHealth({
		modelsFile: options.path ?? modelsFile(),
		model: "model" in options ? options.model : "acme/big",
		env: options.env ?? { ACME_KEY: KEY },
		clock: options.clock,
		probe: options.probe,
		log: (line) => logs.push(line),
	});
	return { health, logs };
}

describe("配没配好", () => {
	it("没有模型文件：照常能起，/health 报「没有配置」并写明缺什么；新的一轮 503 model_not_configured", () => {
		const { health } = start({ path: join(dir, "missing.json") });
		health.start();
		const snapshot = health.snapshot();
		expect(AssistantModelHealth.parse(snapshot)).toMatchObject({
			configured: false,
			endpoint: null,
			reachable: null,
			checked_at: null,
			reason: expect.stringContaining(join(dir, "missing.json")),
			error_class: null,
		});
		expect(health.gate()).toEqual({
			status: 503,
			code: "model_not_configured",
			message: snapshot.reason,
		});
		health.close();
	});

	it("SFLY_ASSISTANT_MODEL 没设、不在文件里、引用的变量没有值：各自写明缺什么", () => {
		const unset = start({ model: undefined }).health;
		expect(unset.snapshot().reason).toContain("SFLY_ASSISTANT_MODEL 没有设置");
		const absent = start({ model: "acme/other" }).health;
		expect(absent.snapshot().reason).toContain("SFLY_ASSISTANT_MODEL 选的模型不在模型文件");
		const noKey = start({ env: {} }).health;
		expect(noKey.snapshot()).toMatchObject({
			configured: false,
			reason: "模型文件引用了环境变量 ACME_KEY，助手服务的环境里没有值",
		});
		for (const { health } of [{ health: unset }, { health: absent }, { health: noKey }]) {
			expect(health.gate()).toMatchObject({ status: 503, code: "model_not_configured" });
		}
	});

	it("文件修好之后不用重启：下一次看就是配好的", () => {
		const path = join(dir, "later.json");
		const { health } = start({ path });
		expect(health.snapshot().configured).toBe(false);
		writeFileSync(path, readModels());
		expect(health.snapshot().configured).toBe(true);
	});
});

function readModels(): string {
	return JSON.stringify({
		providers: {
			acme: {
				baseUrl: "http://llm.internal:8177/v1",
				apiKey: "$ACME_KEY",
				models: [{ id: "big" }],
			},
		},
	});
}

describe("试连：启动时一次，之后每 5 分钟一次", () => {
	it("启动时试一次，/health 报连得上、上次检查的时间、端点的主机和端口（不带路径和参数）", async () => {
		const clock = new ManualClock();
		const { probe, calls } = fakeProbe([{ ok: true }]);
		const { health } = start({ clock, probe });
		// 还没试：不知道。
		expect(health.snapshot()).toMatchObject({
			configured: true,
			reachable: null,
			checked_at: null,
		});
		health.start();
		await eventually(() => expect(health.snapshot().reachable).toBe(true));
		const snapshot = AssistantModelHealth.parse(health.snapshot());
		expect(snapshot).toEqual({
			configured: true,
			endpoint: { host: "llm.internal", port: 8177 },
			reachable: true,
			checked_at: new Date(clock.now()).toISOString(),
			reason: null,
			error_class: null,
		});
		expect(JSON.stringify(snapshot)).not.toContain("do-not-echo");
		expect(calls).toEqual([{ host: "llm.internal", port: 8177, tls: false }]);
		expect(health.gate()).toBeUndefined();
		health.close();
	});

	it("连不上：reachable false、原因和 error_class；新的一轮 503 model_unreachable；5 分钟后再试，连上了就好了", async () => {
		const clock = new ManualClock();
		const { probe, calls } = fakeProbe([
			{ ok: false, errorClass: "unreachable", cause: "连接被拒绝" },
			{ ok: true },
		]);
		const { health, logs } = start({ clock, probe });
		health.start();
		await eventually(() => expect(health.snapshot().reachable).toBe(false));
		const failed = health.snapshot();
		expect(failed).toMatchObject({
			reachable: false,
			reason: "连不上模型端点 llm.internal:8177：连接被拒绝",
			error_class: "unreachable",
			checked_at: new Date(clock.now()).toISOString(),
		});
		expect(health.gate()).toEqual({
			status: 503,
			code: "model_unreachable",
			message: "连不上模型端点 llm.internal:8177：连接被拒绝",
		});
		expect(logs.join("\n")).toContain("连不上模型端点 llm.internal:8177：连接被拒绝");
		// 5 分钟之内不再试。
		clock.advance(MODEL_PROBE_INTERVAL_MS - 1);
		expect(calls).toHaveLength(1);
		clock.advance(1);
		await eventually(() => expect(health.snapshot().reachable).toBe(true));
		expect(calls).toHaveLength(2);
		expect(health.snapshot().checked_at).toBe(new Date(clock.now()).toISOString());
		expect(health.gate()).toBeUndefined();
		// 之后一直每 5 分钟一次。
		clock.advance(MODEL_PROBE_INTERVAL_MS);
		await eventually(() => expect(calls).toHaveLength(3));
		health.close();
	});

	it("关闭时清掉定时器；关闭之后不再试连，在途的结果不记", async () => {
		const clock = new ManualClock();
		let release: (result: ProbeResult) => void = () => {};
		const calls: number[] = [];
		const probe: Probe = () => {
			calls.push(calls.length);
			return new Promise<ProbeResult>((resolve) => {
				release = resolve;
			});
		};
		const { health } = start({ clock, probe });
		health.start();
		await eventually(() => expect(calls).toHaveLength(1));
		expect(clock.pending).toBe(1);
		health.close();
		expect(clock.pending).toBe(0);
		release({ ok: false, errorClass: "unreachable", cause: "连接被拒绝" });
		await Promise.resolve();
		clock.advance(MODEL_PROBE_INTERVAL_MS * 3);
		expect(calls).toHaveLength(1);
		expect(health.snapshot().reachable).toBeNull();
	});

	it("没配好时不试连；配好之后下一次到点就试", async () => {
		const clock = new ManualClock();
		const path = join(dir, "later.json");
		const { probe, calls } = fakeProbe([{ ok: true }]);
		const { health } = start({ clock, probe, path });
		health.start();
		clock.advance(MODEL_PROBE_INTERVAL_MS);
		expect(calls).toHaveLength(0);
		writeFileSync(path, readModels());
		clock.advance(MODEL_PROBE_INTERVAL_MS);
		await eventually(() => expect(calls).toHaveLength(1));
		health.close();
	});

	it("模型文件换了端点：之前的结果不算，马上试新的", async () => {
		const clock = new ManualClock();
		const path = modelsFile("http://old.internal:1/v1");
		const { probe, calls } = fakeProbe([
			{ ok: false, errorClass: "timeout", cause: "连接超时" },
			{ ok: true },
		]);
		const { health } = start({ clock, probe, path });
		health.start();
		await eventually(() => expect(health.snapshot().reachable).toBe(false));
		writeFileSync(path, readModels());
		expect(health.snapshot()).toMatchObject({
			endpoint: { host: "llm.internal", port: 8177 },
			reachable: null,
		});
		await eventually(() => expect(health.snapshot().reachable).toBe(true));
		expect(calls.map((c) => c.host)).toEqual(["old.internal", "llm.internal"]);
		health.close();
	});

	it("不知道端点（提供方没写 baseUrl）：不试连、放行", () => {
		const path = join(dir, "builtin.json");
		writeFileSync(
			path,
			JSON.stringify({ providers: { acme: { apiKey: "$ACME_KEY", models: [{ id: "big" }] } } }),
		);
		const { probe, calls } = fakeProbe([]);
		const { health } = start({ path, probe });
		health.start();
		expect(health.snapshot()).toMatchObject({ configured: true, endpoint: null, reachable: null });
		expect(health.gate()).toBeUndefined();
		expect(calls).toHaveLength(0);
		health.close();
	});

	it("密钥的值不在 /health、日志、新的一轮的拒绝里", async () => {
		const { probe } = fakeProbe([{ ok: false, errorClass: "unreachable", cause: "连接被拒绝" }]);
		const bad = start({ probe });
		bad.health.start();
		await eventually(() => expect(bad.health.snapshot().reachable).toBe(false));
		const text = JSON.stringify([bad.health.snapshot(), bad.health.gate(), bad.logs]);
		expect(text).not.toContain(KEY);
		expect(text).not.toContain("do-not-echo");
		expect(text).not.toContain("token=");
		bad.health.close();
	});
});

describe("真的试连（只建连接，不发请求）", () => {
	const servers: Array<Server | ReturnType<typeof createTcpServer>> = [];
	const sockets = new Set<Socket>();
	afterEach(async () => {
		for (const socket of sockets) socket.destroy();
		sockets.clear();
		await Promise.all(
			servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
		);
	});

	/** 一个只接连接、不回话的 TCP 服务；`received.bytes` 是它收到的字节数，`closed` 在第一条连接关掉时兑现。 */
	async function silentServer(onConnect?: (socket: Socket) => void) {
		const received = { bytes: 0 };
		let closed: () => void = () => {};
		const whenClosed = new Promise<void>((resolve) => {
			closed = resolve;
		});
		const server = createTcpServer((socket) => {
			sockets.add(socket);
			socket.on("data", (chunk) => {
				received.bytes += chunk.length;
			});
			socket.on("error", () => {});
			socket.on("close", closed);
			onConnect?.(socket);
		});
		servers.push(server);
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const { port } = server.address() as { port: number };
		return { port, received, whenClosed };
	}

	it("连得上：成功；对端没有收到任何字节（不发请求、不带密钥）", async () => {
		const { port, received, whenClosed } = await silentServer();
		const result = await connectProbe()(
			{ host: "127.0.0.1", port, tls: false },
			new AbortController().signal,
		);
		expect(result).toEqual({ ok: true });
		// 试连连上就关：对端看到连接关闭，这之前没有收到任何字节。
		await whenClosed;
		expect(received.bytes).toBe(0);
	});

	it("端点回 401 也是连得上：只看能不能连上（HTTP 服务回什么都不管）", async () => {
		const http = createServer((_, res) => res.writeHead(401).end());
		servers.push(http);
		await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
		const { port } = http.address() as { port: number };
		expect(
			await connectProbe()({ host: "127.0.0.1", port, tls: false }, new AbortController().signal),
		).toEqual({ ok: true });
	});

	it("连接被拒绝：unreachable", async () => {
		const closed = createTcpServer();
		await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
		const { port } = closed.address() as { port: number };
		await new Promise<void>((done) => closed.close(() => done()));
		expect(
			await connectProbe()({ host: "127.0.0.1", port, tls: false }, new AbortController().signal),
		).toEqual({ ok: false, errorClass: "unreachable", cause: "连接被拒绝" });
	});

	it("域名解析不了：unreachable", async () => {
		const result = await connectProbe()(
			{ host: "no-such-host.invalid", port: 443, tls: false },
			new AbortController().signal,
		);
		expect(result).toMatchObject({ ok: false, errorClass: "unreachable" });
	});

	it("https 要握手：对端是个不说 TLS 的服务时，TCP 连得上、握手不成，算连不上", async () => {
		const { port } = await silentServer((socket) => socket.end());
		const tls = await connectProbe()(
			{ host: "127.0.0.1", port, tls: true },
			new AbortController().signal,
		);
		expect(tls).toMatchObject({ ok: false, errorClass: "unreachable" });
		// 同一个服务，不握手就算连上了：说明上面失败是握手的缘故。
		const { port: other } = await silentServer();
		expect(
			await connectProbe()(
				{ host: "127.0.0.1", port: other, tls: false },
				new AbortController().signal,
			),
		).toEqual({ ok: true });
	});

	it("握手不回话：超时，timeout", async () => {
		const { port } = await silentServer();
		const result = await connectProbe(150)(
			{ host: "127.0.0.1", port, tls: true },
			new AbortController().signal,
		);
		expect(result).toEqual({ ok: false, errorClass: "timeout", cause: "连接超时" });
	});
});
