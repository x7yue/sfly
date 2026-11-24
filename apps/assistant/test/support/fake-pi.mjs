// 照 RPC 协议说话的假 pi（pi docs/rpc.md）：读 stdin 的命令，按 prompt 的文字决定这一轮怎么走。
// 一起动先把自己的环境写成一条记录（测试看助手服务给了它哪些环境变量）；stdin 被关时写一条记录再退出。
import { spawn } from "node:child_process";
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
// 插话进了队列之后做什么（这一轮的剧本决定）。
let onSteer;
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

// 插话的队列（只有文字，和真的 pi 一样）、插话的模式；在做的这一轮收到 `abort` 时做什么（没有一轮在做时 undefined）。
let queue = [];
let onAbort;
const queueUpdate = () => out({ type: "queue_update", steering: [...queue], followUp: [] });
const respond = (command, data) =>
	out({
		id: command.id,
		type: "response",
		command: command.type,
		success: true,
		...(data && { data }),
	});
const settle = (aborted = false) => {
	onAbort = undefined;
	out({ type: "agent_end", messages: [], willRetry: false });
	out({ type: "agent_settled", aborted });
};
// 队列里的插话送到模型：各一条用户消息（真的 pi 一次全送时也是各一条，rpcprobe 第 15 题），然后队列变空。
const deliver = () => {
	if (queue.length === 0) return;
	for (const text of queue) {
		out({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
	}
	queue = [];
	queueUpdate();
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
	// 「SLOW」开头的插话像真的 pi 那样先过一遍输入处理：40 毫秒之后才进队列、才回应（rpcprobe 第 13 题的竞争）。
	if (command.type === "steer" && String(command.message).startsWith("SLOW")) {
		const text = String(command.message);
		setTimeout(() => {
			queue.push(text);
			queueUpdate();
			respond(command, { disposition: "queued" });
			onSteer?.();
		}, 40);
		return;
	}
	if (command.type === "steer") {
		const text = String(command.message);
		// 以 HANDLE 开头的像被扩展的输入处理器吃掉了（rpcprobe 第 16 题），以 REFUSE 开头的回应失败。
		if (text.startsWith("HANDLE")) return respond(command, { disposition: "handled" });
		if (text.startsWith("REFUSE")) {
			out({ id: command.id, type: "response", command: "steer", success: false, error: "不收" });
			return;
		}
		queue.push(text);
		queueUpdate();
		respond(command, { disposition: "queued" });
		onSteer?.();
		return;
	}
	if (command.type === "clear_queue") {
		const steering = queue;
		queue = [];
		queueUpdate();
		out({ type: "fake_clear_queue", steering });
		return respond(command, { steering, followUp: [] });
	}
	if (command.type === "abort") {
		out({ type: "fake_abort" });
		respond(command);
		onAbort?.();
		return;
	}
	if (command.type === "set_steering_mode") {
		out({ type: "fake_steering_mode", mode: command.mode });
		return respond(command);
	}
	if (command.type !== "prompt") return respond(command);
	const text = String(command.message);
	if (text.startsWith("reject-slow")) {
		// 收下这句话 300 毫秒之后才拒绝（这中间可以停止）。
		out({ type: "fake_prompt_received" });
		setTimeout(
			() =>
				out({
					id: command.id,
					type: "response",
					command: "prompt",
					success: false,
					error: "不接受",
				}),
			300,
		);
		return;
	}
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
	out({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
	onSteer = undefined;
	// 默认：收到 abort 就停下（agent_settled，aborted）。
	onAbort = () => settle(true);
	if (text.startsWith("race2")) {
		// 命令执行中；收到 abort 之后 80 毫秒才收尾，收尾时把队列里的插话放进对话（各一条用户消息）再 agent_settled
		// （rpcprobe 第 13 题「命令执行中、同一次写」时真的 pi 就是这样）。
		onAbort = () => {
			setTimeout(() => {
				deliver();
				settle(true);
			}, 80);
		};
	} else if (text.startsWith("slow-abort")) {
		// 收到 abort 之后 150 毫秒才停下（agent_settled），进程留着。
		onAbort = () => setTimeout(() => settle(true), 150);
	} else if (text.startsWith("flush-settle")) {
		// 一开始就把队列里还有的插话送到模型（上一轮留下的），再做完。
		deliver();
		out(assistant("好的"));
		settle();
	} else if (text.startsWith("settle-then-die")) {
		// 做完这一轮，之后退出，留下一个子进程拿着标准输出（同上）。
		out(assistant("好的"));
		settle();
		setTimeout(() => {
			spawn("sleep", ["3"], { stdio: ["ignore", "inherit", "ignore"] }).unref();
			out({ type: "fake_stdin_destroyed" });
			setTimeout(() => process.exit(0), 20);
		}, 50);
	} else if (text.startsWith("close-stdin")) {
		// 收下 prompt 之后退出，留下一个子进程拿着标准输出：助手服务要等标准输出也关了才知道它退出，这 3 秒里往它的 stdin 写会出错。
		setTimeout(() => {
			spawn("sleep", ["3"], { stdio: ["ignore", "inherit", "ignore"] }).unref();
			out({ type: "fake_stdin_destroyed" });
			setTimeout(() => process.exit(0), 20);
		}, 50);
	} else if (text.startsWith("settle-stubborn")) {
		// 做完这一轮；之后 stdin 被关也不退出（只有 SIGKILL 结束得了它）。
		stubborn = true;
		setInterval(() => {}, 60_000);
		out(assistant("好的"));
		settle();
	} else if (text.startsWith("settle-slow-close")) {
		slowClose = true;
		out(assistant("好的"));
		settle();
	} else if (text.startsWith("settle")) {
		out(assistant("好的"));
		settle();
	} else if (text.startsWith("deaf")) {
		// 不理 abort（不报 agent_settled），SIGTERM 照常退出。
		onAbort = () => {};
	} else if (text.startsWith("chatty-term")) {
		// 不理 abort；收到 SIGTERM 之后还在吐事件（一条新的工具调用），过一会儿才退出。
		onAbort = () => {};
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
	} else if (text.startsWith("work")) {
		// 一直在做（像一条长命令），每 30 毫秒把队列里的插话送到模型；收到 abort 才停下。
		const timer = setInterval(deliver, 30);
		onAbort = () => {
			clearInterval(timer);
			settle(true);
		};
	} else if (text.startsWith("quit-on-steer")) {
		// 插话进了队列之后 pi 进程退出了（还没送到它）。
		onSteer = () => setTimeout(() => process.exit(7), 20);
	} else if (text.startsWith("done-on-steer")) {
		// 插话进了队列就停下（这一轮做完了），没有送到它。
		onSteer = () => {
			out(assistant("好的"));
			settle();
		};
	} else if (text.startsWith("deliver-two")) {
		// 两句插话都进了队列之后一次送完，再说一句话、做完。
		onSteer = () => {
			if (queue.length < 2) return;
			onSteer = undefined;
			deliver();
			out(assistant("看到了"));
			settle();
		};
	} else if (text.startsWith("deliver-then-settle")) {
		// 插话进了队列之后过一会儿一次送完，再说一句话、做完。
		onSteer = () => {
			onSteer = undefined;
			setTimeout(() => {
				deliver();
				out(assistant("看到了"));
				settle();
			}, 50);
		};
	} else if (text.startsWith("loop")) {
		let n = 0;
		const timer = setInterval(() => {
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
		onAbort = () => {
			clearInterval(timer);
			settle(true);
		};
	} else if (text.startsWith("ignore-term")) {
		// 不理 abort、不理 SIGTERM：只有 SIGKILL 结束得了它。
		onAbort = () => {};
		stubborn = true;
		process.on("SIGTERM", () => out({ type: "fake_ignored_sigterm" }));
		// stdin 关了之后事件循环里就没有别的了，不留一个定时器进程会自己退出（Linux 上比 SIGTERM 先到）。
		setInterval(() => {}, 60_000);
	} else if (text.startsWith("term-143")) {
		// 不理 abort；照 pi 只收到 SIGTERM 时的样子：退出码 143（#539 第 8 题）。
		onAbort = () => {};
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
		// 保密值分两次写进标准错误（一个值跨两块）。
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
		// 上游把保密值、模型的密钥（FAKE_MODEL_KEY 的值）、请求头和带凭据的地址回显在错误里，还很长。
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
