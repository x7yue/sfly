// 在测试进程里起一个助手服务：真的 SessionManager 和 HTTP 服务，pi 用真的（或假的，`piArgv`），
// 模型是 FakeModel，工作台是 FakeWorkbench。事件流由 {@link EventsClient} 收着。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	AssistantStreamHeartbeat,
	type AssistantStreamHello,
	AssistantStreamRecord,
	type PromptCommandBody,
	type TurnEndEvent,
} from "@sfly/schema";
import type { z } from "zod";
import { buildExtension } from "../../scripts/build-extension.js";
import { type AgentClient, type AgentOptions, connectAgent } from "../../src/agent.js";
import { EventBus } from "../../src/bus.js";
import { piPackage } from "../../src/launch.js";
import { createAssistantServer } from "../../src/server.js";
import { SessionManager, type SessionManagerOptions } from "../../src/sessions.js";
import { eventually } from "./eventually.js";
import { FakeModel, modelsJson } from "./fake-model.js";
import { FakeWorkbench } from "./fake-workbench.js";

export const SECRET = "assistant-test-shared-secret-0123456789abcdef";
export const repoRoot = resolve(import.meta.dirname, "../../../..");
export const skillsDir = join(repoRoot, "docs", "guide", "skills");

let extensionPromise: Promise<string> | undefined;
/** 打包好的远程工具扩展（每个测试进程打一次）。 */
export function extensionBundle(): Promise<string> {
	extensionPromise ??= buildExtension(
		join(mkdtempSync(join(tmpdir(), "sfly-assistant-ext-")), "extension.mjs"),
	);
	return extensionPromise;
}

export interface HarnessOptions {
	piArgv?: string[];
	limits?: SessionManagerOptions["limits"];
	maxProcesses?: number;
	killGraceMs?: number;
	hostEnv?: NodeJS.ProcessEnv;
	heartbeatMs?: number;
	/** 助手服务连工作台时的期限（测试里改短）。 */
	agentDeadlines?: AgentOptions;
	/** 换掉助手服务拿到的工作台客户端的某几样（造工作台连接之外的错误）。 */
	wrapAgent?: (client: AgentClient) => AgentClient;
}

export class Harness {
	events!: EventsClient;
	/** 助手服务自己（不是扩展）开过、关过几个工作台的客户端：探工作台、写 skill 用完都要关。 */
	connections = { opened: 0, closed: 0 };

	private constructor(
		readonly root: string,
		readonly dataDir: string,
		readonly workdir: string,
		readonly model: FakeModel,
		readonly workbench: FakeWorkbench,
		readonly sessions: SessionManager,
		readonly bus: EventBus,
		readonly server: Server,
		readonly url: string,
		/** 助手服务写的日志。 */
		readonly logs: string[],
	) {}

	static async start(options: HarnessOptions = {}): Promise<Harness> {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "sfly-assistant-")));
		const dataDir = join(root, "data");
		const workdir = join(root, "workbench", "work");
		const configDir = join(root, "config");
		for (const dir of [dataDir, workdir, configDir]) mkdirSync(dir, { recursive: true });
		const model = await FakeModel.start();
		const workbench = await FakeWorkbench.start();
		const modelsFile = join(configDir, "models.json");
		writeFileSync(modelsFile, modelsJson(model));
		const logs: string[] = [];
		const counts = { opened: 0, closed: 0 };
		const bus = new EventBus();
		const sessions = new SessionManager({
			dataDir,
			modelsFile,
			model: "fake/fake",
			piArgv: options.piArgv ?? [process.execPath, piPackage().cli],
			extension: await extensionBundle(),
			skillsDir,
			hostEnv: options.hostEnv ?? {
				PATH: process.env.PATH,
				FAKE_MODEL_KEY: "fake-key",
				SFLY_ASSISTANT_SECRET: SECRET,
				UNRELATED: "not-for-pi",
			},
			bus,
			connect: (address, log) => {
				const connected = connectAgent(address, { ...options.agentDeadlines, log });
				const client = options.wrapAgent ? options.wrapAgent(connected) : connected;
				counts.opened += 1;
				return {
					...client,
					close: () => {
						counts.closed += 1;
						client.close();
					},
				};
			},
			log: (message) => logs.push(message),
			limits: options.limits,
			maxProcesses: options.maxProcesses,
			killGraceMs: options.killGraceMs,
			tmpRoot: join(root, "tmp"),
		});
		const server = createAssistantServer({
			secret: SECRET,
			bus,
			sessions,
			versions: { assistant: "0.0.0-test", pi: piPackage().version },
			modelsFile,
			log: (message) => logs.push(message),
			heartbeatMs: options.heartbeatMs,
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const harness = new Harness(
			root,
			dataDir,
			workdir,
			model,
			workbench,
			sessions,
			bus,
			server,
			url,
			logs,
		);
		harness.events = await EventsClient.connect(url);
		// 计数从启动时就开始：和 SessionManager 用的是同一个对象。
		harness.connections = counts;
		return harness;
	}

	prompt(
		sessionId: string,
		overrides: Partial<PromptCommandBody> = {},
		secret: string = SECRET,
	): Promise<Response> {
		const body: PromptCommandBody = {
			turn: 1,
			message_id: crypto.randomUUID(),
			text: "你好",
			session: { title: "测试", created_by: "tester" },
			workbench: { name: "fake-workbench", address: this.workbench.address, workdir: this.workdir },
			env: { SFLY_NICKNAME: "tester", AI_AGENT: "pi" },
			secret_env: {},
			...overrides,
		};
		return fetch(`${this.url}/sessions/${sessionId}/prompt`, {
			method: "POST",
			headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	/** 结束第 `turn` 轮（默认第 1 轮）。 */
	abort(sessionId: string, turn = 1): Promise<Response> {
		return fetch(`${this.url}/sessions/${sessionId}/abort`, {
			method: "POST",
			headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
			body: JSON.stringify({ turn }),
		});
	}

	/** 等这个会话的第 `turn` 轮结束，返回 `turn_end`。 */
	async turnEnd(
		sessionId: string,
		turn = 1,
		timeoutMs = 60_000,
	): Promise<z.infer<typeof TurnEndEvent>> {
		let found: z.infer<typeof TurnEndEvent> | undefined;
		await eventually(() => {
			const record = this.events
				.of(sessionId)
				.find((r) => r.turn === turn && r.event.type === "turn_end");
			if (!record || record.event.type !== "turn_end") throw new Error(`第 ${turn} 轮还没有结束`);
			found = record.event;
		}, timeoutMs);
		return found as z.infer<typeof TurnEndEvent>;
	}

	async close(): Promise<void> {
		this.events.close();
		await this.sessions.shutdown();
		this.server.closeAllConnections();
		await new Promise<void>((done) => this.server.close(() => done()));
		await this.model.close();
		await this.workbench.close();
		rmSync(this.root, { recursive: true, force: true });
	}
}

/** `GET /events` 的客户端：收下每一行（经协议的 schema 检查）。 */
export class EventsClient {
	hello: AssistantStreamHello | undefined;
	/** 收到的心跳行数。 */
	heartbeats = 0;
	readonly records: AssistantStreamRecord[] = [];
	readonly lines: string[] = [];

	private constructor(private readonly controller: AbortController) {}

	static async connect(url: string, secret = SECRET): Promise<EventsClient> {
		const controller = new AbortController();
		const client = new EventsClient(controller);
		const res = await fetch(`${url}/events`, {
			headers: { authorization: `Bearer ${secret}` },
			signal: controller.signal,
		});
		if (!res.ok || !res.body) throw new Error(`事件流 ${res.status}`);
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let pending = "";
		void (async () => {
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) return;
					pending += decoder.decode(value, { stream: true });
					const lines = pending.split("\n");
					pending = lines.pop() ?? "";
					for (const line of lines) client.#take(line);
				}
			} catch {
				// 关掉了
			}
		})();
		await eventually(() => {
			if (!client.hello) throw new Error("还没有 hello");
		});
		return client;
	}

	#take(line: string): void {
		this.lines.push(line);
		const json = JSON.parse(line) as { type?: string };
		if (json.type === "hello") {
			this.hello = json as AssistantStreamHello;
			return;
		}
		if (json.type === "heartbeat") {
			AssistantStreamHeartbeat.parse(json);
			this.heartbeats += 1;
			return;
		}
		this.records.push(AssistantStreamRecord.parse(json));
	}

	of(sessionId: string): AssistantStreamRecord[] {
		return this.records.filter((r) => r.session_id === sessionId);
	}

	close(): void {
		this.controller.abort();
	}
}
