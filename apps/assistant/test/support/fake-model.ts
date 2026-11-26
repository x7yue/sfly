// 照剧本回复的假模型端点（OpenAI chat completions，流式）：和评测集的 evals/assistant/container/fake_model.py 同样的做法，
// 剧本走到第几步按请求里已有的工具结果条数算。记下收到的每个请求（看系统提示和发给模型的内容）。
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Step =
	| { tool: "read" | "write" | "edit" | "bash"; args: Record<string, unknown> }
	| { text: string };

export interface RecordedRequest {
	messages: Array<{ role: string; content: unknown; tool_calls?: unknown }>;
	tools?: Array<{ function?: { name?: string } }>;
}

export class FakeModel {
	readonly requests: RecordedRequest[] = [];
	/** 每个请求按第一条用户消息选剧本；没有对上的用 `default`。 */
	scripts = new Map<string, Step[]>();
	fallback: Step[] = [{ text: "好的。" }];
	/** 接下来的请求依次回这些 HTTP 错误（用完了照常回剧本）：看上游出错时助手服务怎么说。 */
	failures: Array<{ status: number; body: string }> = [];
	/** 按这是第几个请求（从 0 起）决定回不回 HTTP 错误；优先于 `failures`：造「先做了几步、之后一直出错」。 */
	failWhen?: (index: number) => { status: number; body: string } | undefined;

	private constructor(
		private readonly server: Server,
		readonly port: number,
	) {}

	static async start(): Promise<FakeModel> {
		const server = createServer();
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const model = new FakeModel(server, (server.address() as AddressInfo).port);
		server.on("request", async (req, res) => {
			if (req.method === "GET") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: [{ id: "fake", object: "model" }] }));
				return;
			}
			let text = "";
			for await (const chunk of req) text += chunk;
			const body = JSON.parse(text) as RecordedRequest & { stream?: boolean };
			const failWhen = model.failWhen?.(model.requests.length);
			model.requests.push(body);
			const failure = failWhen ?? model.failures.shift();
			if (failure) {
				res.writeHead(failure.status, { "content-type": "application/json" });
				res.end(failure.body);
				return;
			}
			const reply = model.#next(body);
			res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
			for (const chunk of chunks(reply)) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			res.end("data: [DONE]\n\n");
		});
		return model;
	}

	get baseUrl(): string {
		return `http://127.0.0.1:${this.port}/v1`;
	}

	/** 最近一个请求的系统提示。 */
	systemPrompt(index = -1): string {
		const request = this.requests.at(index);
		const system = request?.messages.find((m) => m.role === "system" || m.role === "developer");
		return contentText(system?.content);
	}

	async close(): Promise<void> {
		this.server.closeAllConnections();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	#next(body: RecordedRequest): Step & { id?: string } {
		const prompt = contentText(body.messages.find((m) => m.role === "user")?.content);
		const steps = [...this.scripts].find(([key]) => prompt.includes(key))?.[1] ?? this.fallback;
		const done = body.messages.filter((m) => m.role === "tool").length;
		const step = steps[done] ?? { text: "完成。" };
		return "tool" in step ? { ...step, id: `call_${done + 1}` } : step;
	}
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((p) => String(p?.text ?? "")).join("");
	return "";
}

function chunks(reply: Step & { id?: string }): unknown[] {
	const base = { id: "fake", object: "chat.completion.chunk", created: 0, model: "fake" };
	const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
	if ("tool" in reply) {
		const call = {
			index: 0,
			id: reply.id,
			type: "function",
			function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
		};
		return [
			{
				...base,
				choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [call] } }],
			},
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
		];
	}
	return [
		{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply.text } }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
	];
}

/** 指向这个假模型的 pi 模型文件。 */
export function modelsJson(model: { baseUrl: string }): string {
	return JSON.stringify({
		providers: {
			fake: {
				name: "假模型",
				baseUrl: model.baseUrl,
				api: "openai-completions",
				apiKey: "$FAKE_MODEL_KEY",
				models: [
					{
						id: "fake",
						name: "fake",
						reasoning: false,
						input: ["text"],
						contextWindow: 128000,
						maxTokens: 8192,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	});
}
