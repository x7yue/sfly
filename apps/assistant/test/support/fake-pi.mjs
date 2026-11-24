// 照 RPC 协议说话的假 pi（pi docs/rpc.md）：读 stdin 的命令，按 prompt 的文字决定这一轮怎么走。
// 一起动先把自己的环境写成一条记录（测试看助手服务给了它哪些环境变量）；stdin 被关时写一条记录再退出。
import { readdirSync } from "node:fs";

const out = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
out({
	type: "fake_env",
	env: process.env,
	argv: process.argv.slice(2),
	agentDir: readdirSync(process.env.PI_CODING_AGENT_DIR),
	t: Date.now(),
});

let pending = "";
process.stdin.on("data", (chunk) => {
	pending += chunk.toString("utf8");
	let lf = pending.indexOf("\n");
	while (lf !== -1) {
		const line = pending.slice(0, lf);
		pending = pending.slice(lf + 1);
		if (line.trim()) handle(JSON.parse(line));
		lf = pending.indexOf("\n");
	}
});
// `ignore-term`：stdin 被关、收到 SIGTERM 都不退出（只有 SIGKILL 结束得了它）。
let stubborn = false;
// `slow-close`：stdin 被关之后过一会儿才退出（退出之前写一条带时间的记录）。
let slowClose = false;
process.stdin.on("end", () => {
	out({ type: "fake_stdin_closed" });
	if (slowClose) {
		setTimeout(() => {
			out({ type: "fake_exiting", t: Date.now() });
			setTimeout(() => process.exit(0), 20);
		}, 2000);
		return;
	}
	if (!stubborn) process.exit(0);
});

const settle = () => {
	out({ type: "agent_end", messages: [], willRetry: false });
	out({ type: "agent_settled", aborted: false });
};
const assistant = (text, extra = {}) => ({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0 },
		stopReason: "stop",
		...extra,
	},
});

function handle(command) {
	if (command.type !== "prompt") {
		out({ id: command.id, type: "response", command: command.type, success: true });
		return;
	}
	const text = String(command.message);
	if (text.startsWith("reject")) {
		out({ id: command.id, type: "response", command: "prompt", success: false, error: "不接受" });
		return;
	}
	out({
		id: command.id,
		type: "response",
		command: "prompt",
		success: true,
		data: { disposition: "started" },
	});
	out({ type: "agent_start" });
	out({ type: "turn_start" });
	if (text.startsWith("settle-slow-close")) {
		slowClose = true;
		out(assistant("好的"));
		settle();
	} else if (text.startsWith("settle")) {
		out(assistant("好的"));
		settle();
	} else if (text.startsWith("chatty-term")) {
		// 收到 SIGTERM 之后还在吐事件（一条新的工具调用），过一会儿才退出。
		stubborn = true;
		process.on("SIGTERM", () => {
			out({
				type: "tool_execution_start",
				toolCallId: "late",
				toolName: "bash",
				args: { command: "late" },
			});
			out({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "后来的话" }] },
			});
			setTimeout(() => process.exit(0), 50);
		});
		setInterval(() => {}, 60_000);
	} else if (text.startsWith("error-once")) {
		// 最后一条助手消息出错，没有重试（不是重试用尽）。
		out(assistant("", { stopReason: "error", errorMessage: "401 unauthorized" }));
		settle();
	} else if (text.startsWith("nul")) {
		out({
			type: "tool_execution_start",
			toolCallId: "n1",
			toolName: "read",
			args: { path: "bin" },
		});
		out({
			type: "tool_execution_end",
			toolCallId: "n1",
			toolName: "read",
			result: { content: [{ type: "text", text: "a\u0000b\ud800c" }] },
			isError: false,
		});
		out(assistant("好的"));
		settle();
	} else if (text.startsWith("loop")) {
		let n = 0;
		setInterval(() => {
			n += 1;
			out({
				type: "tool_execution_start",
				toolCallId: `c${n}`,
				toolName: "bash",
				args: { command: "true" },
			});
			out({
				type: "tool_execution_end",
				toolCallId: `c${n}`,
				toolName: "bash",
				result: { content: [] },
				isError: false,
			});
			out({ type: "turn_start" });
		}, 5);
	} else if (text.startsWith("ignore-term")) {
		stubborn = true;
		process.on("SIGTERM", () => out({ type: "fake_ignored_sigterm" }));
		// stdin 关了之后事件循环里就没有别的了，不留一个定时器进程会自己退出（Linux 上比 SIGTERM 先到）。
		setInterval(() => {}, 60_000);
	} else if (text.startsWith("term-143")) {
		// 照 pi 只收到 SIGTERM 时的样子：退出码 143（#539 第 8 题）。
		stubborn = true;
		process.on("SIGTERM", () => {
			out({ type: "fake_exit_143" });
			process.exit(143);
		});
		setInterval(() => {}, 60_000);
	} else if (text.startsWith("exit")) {
		setTimeout(() => process.exit(7), 20);
	} else if (text.startsWith("compact-fail")) {
		out({
			type: "compaction_end",
			reason: "threshold",
			aborted: false,
			willRetry: false,
			errorMessage: "Auto-compaction failed: 401: Authorization: Bearer sk-compact-1",
		});
		out(assistant("好的。"));
		settle();
	} else if (text.startsWith("error")) {
		// pi 的先后：这次模型调用以出错结束，再是重试的提示；重试用尽带的是最后一次的原文。
		out(assistant("", { stopReason: "error", errorMessage: "503 upstream" }));
		out({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 1,
			delayMs: 10,
			errorMessage: "503 upstream",
		});
		out(assistant("", { stopReason: "error", errorMessage: "503 upstream" }));
		out({ type: "auto_retry_end", success: false, attempt: 1, finalError: "503 upstream" });
		settle();
	} else if (text.startsWith("stderr:")) {
		// secret 值分两次写进标准错误（一个值跨两块）。
		const value = text.slice("stderr:".length);
		const half = Math.floor(value.length / 2);
		process.stderr.write(`warning: token ${value.slice(0, half)}`);
		setTimeout(() => {
			process.stderr.write(`${value.slice(half)} rejected\n`);
			out(assistant("好的"));
			settle();
		}, 50);
	} else if (text.startsWith("secret:")) {
		const value = text.slice("secret:".length);
		const half = Math.floor(value.length / 2);
		out({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: `令牌是 ${value.slice(0, half)}` },
		});
		out({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: `${value.slice(half)} 。` },
		});
		out(assistant(`令牌是 ${value} 。`));
		out({
			type: "tool_execution_start",
			toolCallId: "s1",
			toolName: "bash",
			args: { command: `echo ${value}` },
		});
		out({
			type: "tool_execution_update",
			toolCallId: "s1",
			toolName: "bash",
			partialResult: { content: [{ type: "text", text: `TOKEN=${value.slice(0, half)}` }] },
		});
		out({
			type: "tool_execution_update",
			toolCallId: "s1",
			toolName: "bash",
			partialResult: {
				content: [{ type: "text", text: `TOKEN=${value}\nJSON={"t":${JSON.stringify(value)}}\n` }],
			},
		});
		out({
			type: "tool_execution_end",
			toolCallId: "s1",
			toolName: "bash",
			result: { content: [{ type: "text", text: `TOKEN=${value}\n` }] },
			isError: false,
			durationMs: 3,
		});
		// 上游把 secret 值、模型的密钥（FAKE_MODEL_KEY 的值）、请求头和带凭据的地址回显在错误里，还很长。
		const upstream =
			`bad key ${value} (fake-key) Authorization: Bearer sk-shape-123\n` +
			`via https://user:pw-shape@proxy.example/ ${"x".repeat(600)}`;
		out(assistant("", { stopReason: "error", errorMessage: upstream }));
		out({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 2,
			delayMs: 5,
			errorMessage: upstream,
		});
		settle();
	}
	// 其余（hang）：开始了，不结束。
}
