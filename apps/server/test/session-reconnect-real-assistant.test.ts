// 控制面和**真的**助手服务（真的 pi、照剧本回复的假模型、本机临时目录里真的执行命令的假工作台）之间的重启（#545 R 块的集成测试）：
// 1. 一轮进行到一半重启控制面：起来后这一轮接着完成，库里的持久事件和助手服务发出的、助手容器卷上的 `events.jsonl` 对得上，没有缺、没有重复；
// 2. 一轮进行到一半重启助手服务（容器被杀）：会话出现「中断：助手服务重启了」并回到空闲；再说一句，发给模型的内容里有之前的对话，接着做。
// 控制面和助手服务之间隔一个转发（`support/assistant-proxy.ts`）：控制面写死工作区在 `/work`，转发把它换成测试自己的临时目录。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionDetailResponse, SessionView } from "@sfly/schema";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Harness, SECRET } from "../../assistant/test/support/harness.js";
import { ApiClient } from "./support/api-client.js";
import { type AssistantProxy, startAssistantProxy } from "./support/assistant-proxy.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import type { ManualClock } from "./support/manual-clock.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";
import { asUsers } from "./support/user-api.js";

const WORKBENCH = "workbench-real";
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

describe("真的助手服务：重启控制面、重启助手服务", () => {
	let assistant: Harness;
	let proxy: AssistantProxy;
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;

	const connectWorkbench = async () => {
		const [host, port] = assistant.workbench.address.split(":");
		return FakeAgent.connect(
			cp.grpcUrl,
			{ name: WORKBENCH, peer: { port: Number(port), publicAddress: host as string } },
			{ clock: cp.clock },
		);
	};

	beforeAll(async () => {
		assistant = await Harness.start();
		proxy = await startAssistantProxy(assistant.url, assistant.workdir);
		cp = await startTestControlPlane({
			assistantUrl: proxy.url,
			assistantSecret: SECRET,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 50, max: 200 },
			sessionStopGraceMs: 5_000,
		});
		api = new ApiClient(asUsers(cp));
		agent = await connectWorkbench();
		await eventually(() => expect(cp.current.assistantConnected()).toBe(true), 10_000);
	}, 180_000);

	afterAll(async () => {
		await agent?.disconnect();
		await cp?.close();
		await proxy?.close();
		await assistant?.close();
	});

	const advance = () => (cp.clock as ManualClock).advance(1_000);
	const detail = async (id: string) =>
		json<SessionDetailResponse>(await api.get(`/sessions/${id}`));
	async function query<T extends object>(text: string, params: unknown[] = []): Promise<T[]> {
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			return (await client.query(text, params)).rows as T[];
		} finally {
			await client.end();
		}
	}

	it("一轮进行到一半重启控制面：这一轮接着完成，库里的助手事件和助手服务发出的、events.jsonl 对得上，没有缺、没有重复", async () => {
		// 第一个工具调用在工作台上等一个文件出现：控制面停机的这段时间它还在跑，放行之后结局在停机期间产生。
		assistant.model.scripts.set("剧本：重启控制面", [
			{
				tool: "bash",
				args: {
					command: "while [ ! -f gate-cp ]; do sleep 0.1; done; echo 放行了",
					timeout: 120,
				},
			},
			{ text: "做完了。" },
		]);
		const created = await json<SessionView>(
			await api.post("/projects/default/sessions", { text: "剧本：重启控制面" }, "alice"),
		);
		advance();
		// 工具调用开始了（持久事件 `tool_call` 落了库）：这一轮进行到一半。
		await eventually(async () => {
			expect((await detail(created.id)).events.map((e) => e.type)).toContain("tool_call");
		}, 60_000);
		const stored = await query<{ n: string }>(
			"select count(*) as n from session_events where session_id = $1 and assistant_epoch is not null",
			[created.id],
		);
		expect(Number(stored[0]?.n)).toBeGreaterThan(0);
		// 重启控制面；停机期间放行工具，这一轮在控制面不在的时候做完。
		await cp.restart(async () => {
			writeFileSync(join(assistant.workdir, "gate-cp"), "go");
			await assistant.turnEnd(created.id);
		});
		await agent.disconnect();
		agent = await connectWorkbench();
		await eventually(async () => {
			expect((await detail(created.id)).status).toBe("idle");
		}, 30_000);
		const view = await detail(created.id);
		expect(view.last_turn_outcome).toBe("completed");

		// 助手服务发出的持久事件（它自己的事件流上看到的），和库里这个会话的助手事件：同一批，各一条。
		const emitted = assistant.events
			.of(created.id)
			.flatMap((record) => (record.seq === undefined ? [] : [record.seq]));
		const rows = await query<{ assistant_epoch: string; assistant_seq: string; type: string }>(
			"select assistant_epoch, assistant_seq, type from session_events where session_id = $1 and assistant_epoch is not null order by seq",
			[created.id],
		);
		expect(rows.map((r) => Number(r.assistant_seq))).toEqual(emitted);
		expect(new Set(rows.map((r) => r.assistant_seq)).size).toBe(rows.length);
		expect(rows.every((r) => r.assistant_epoch === assistant.bus.epoch)).toBe(true);

		// 助手容器卷上这个会话的 events.jsonl（pi 的原始事件）：工具调用、工具结果、助手消息、一轮结束各对上。
		interface RawEvent {
			type: string;
			message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
		}
		const raw = (await assistant.rawSettled(created.id))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as RawEvent);
		const count = (type: string) => rows.filter((r) => r.type === type).length;
		expect(count("tool_call")).toBe(raw.filter((e) => e.type === "tool_execution_start").length);
		expect(count("tool_result")).toBe(raw.filter((e) => e.type === "tool_execution_end").length);
		// 没有文字的助手消息（只调了工具）助手服务不发，所以只数有文字的。
		const spoken = raw.filter(
			(e) =>
				e.type === "message_end" &&
				e.message?.role === "assistant" &&
				(e.message.content ?? []).some((part) => part.type === "text" && (part.text ?? "") !== ""),
		);
		expect(spoken.length).toBeGreaterThan(0);
		expect(count("assistant_message")).toBe(spoken.length);
		expect(count("turn_end")).toBe(raw.filter((e) => e.type === "agent_settled").length);
		// 没有缺口的提示、没有被当成中断。
		const types = view.events.map((e) => e.type);
		expect(types.filter((t) => t === "turn_end")).toHaveLength(1);
		expect(view.events.some((e) => e.type === "notice" && e.kind === "events_lost")).toBe(false);
	}, 180_000);

	it("一轮进行到一半重启助手服务（容器被杀）：会话出现「中断：助手服务重启了」并回到空闲；再说一句，发给模型的内容里有之前的对话，接着做", async () => {
		assistant.model.scripts.clear();
		assistant.model.scripts.set("剧本：重启助手服务", [
			{ tool: "bash", args: { command: "sleep 600", timeout: 700 } },
			{ text: "不会走到这里。" },
		]);
		const created = await json<SessionView>(
			await api.post("/projects/default/sessions", { text: "剧本：重启助手服务" }, "alice"),
		);
		advance();
		await eventually(async () => {
			expect((await detail(created.id)).events.map((e) => e.type)).toContain("tool_call");
		}, 60_000);
		// 容器被杀、再起来（新的纪元）：命令在工作台上因为连接断开被结束，会话管理器和 pi 进程都没了。
		await assistant.restartService();
		await eventually(async () => {
			expect((await detail(created.id)).status).toBe("idle");
		}, 30_000);
		const view = await detail(created.id);
		expect(view.events.at(-1)).toMatchObject({
			type: "turn_end",
			turn: 1,
			outcome: "interrupted",
			reason: "助手服务重启了；工作区和已经触发的运行不受影响，说一句话可以接着做",
		});
		expect(view.last_turn_outcome).toBe("interrupted");
		// 再说一句：从新的助手服务开始新的一轮（第 2 轮），pi 从会话文件接着做——发给模型的内容里有之前的对话。
		assistant.model.scripts.clear();
		assistant.model.fallback = [{ text: "接着做完了。" }];
		const before = assistant.model.requests.length;
		advance();
		expect(
			(await api.post(`/sessions/${created.id}/messages`, { text: "接着做吧" }, "alice")).status,
		).toBe(200);
		await eventually(async () => {
			const events = (await detail(created.id)).events;
			expect(
				events.filter((e) => e.type === "turn_end").map((e) => (e as { outcome: string }).outcome),
			).toEqual(["interrupted", "completed"]);
		}, 60_000);
		const sent = JSON.stringify(assistant.model.requests.slice(before));
		expect(sent).toContain("剧本：重启助手服务");
		expect(sent).toContain("接着做吧");
		expect((await detail(created.id)).status).toBe("idle");
	}, 180_000);
});
