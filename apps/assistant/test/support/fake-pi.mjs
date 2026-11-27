// 照 RPC 协议说话的假 pi（pi docs/rpc.md）：读 stdin 的命令，按 prompt 的文字决定这一轮怎么走。
// 一起动先把自己的环境写成一条记录（测试看助手服务给了它哪些环境变量）；stdin 被关时写一条记录再退出。
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// `batch`：这一句 prompt 的回应和后面的事件攒起来、一次写出（和真的 pi 在一块数据里连着到的情形一样：助手服务收到回应之后，
// 紧接着同一块数据里的事件先于「收到回应之后的那一步」被处理）。
let batch;
const out = (record) => {
	const line = `${JSON.stringify(record)}\n`;
	if (batch) batch.push(line);
	else process.stdout.write(line);
};
out({
	type: "fake_env",
	env: process.env,
	argv: process.argv.slice(2),
	pid: process.pid,
	agentDir: readdirSync(process.env.PI_CODING_AGENT_DIR),
	t: Date.now(),
});

// 会话文件的替身（#545）：`--session-dir` 里的 `fake-session.json` 存着 `{ messages: 条数 }`。起动时读：读不了就当没有、悄悄开一个空会话
// （和真的 pi 一样，pi 1.6.0 读不了会话文件时不报错退出）；每接受一句 prompt 加两条（用户的、助手的）；`get_state` 回 `messageCount`。
const argv = process.argv.slice(2);
const sessionDir = argv[argv.indexOf("--session-dir") + 1];
let messageCount = 0;
try {
	messageCount =
		Number(JSON.parse(readFileSync(join(sessionDir, "fake-session.json"), "utf8")).messages) || 0;
} catch {
	messageCount = 0;
}
const persist = () => {
	if (!sessionDir) return;
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "fake-session.json"), JSON.stringify({ messages: messageCount }));
};

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
		// 会话目录的上一级（会话自己的目录）里有 `fake-slow-steer`：回应慢 800 毫秒（换会话的 pi 起来之后、交 prompt 之前
		// 有一段时间可以停止这一轮；会话目录会被挪走，标记放在挪不走的地方）。
		if (sessionDir && existsSync(join(sessionDir, "..", "fake-slow-steer"))) {
			setTimeout(() => respond(command), 800);
			return;
		}
		return respond(command);
	}
	if (command.type === "get_state") {
		out({ type: "fake_get_state", messageCount });
		// 会话目录里有 `fake-no-state`：回应里没有 messageCount（认不出）。
		if (sessionDir && existsSync(join(sessionDir, "fake-no-state"))) return respond(command, {});
		// 会话目录里有 `fake-slow-state`：回应慢 800 毫秒（让测试能在回应之前停止这一轮）。
		if (sessionDir && existsSync(join(sessionDir, "fake-slow-state"))) {
			const answer = { messageCount, sessionId: "fake", isStreaming: false };
			setTimeout(() => respond(command, answer), 800);
			return;
		}
		return respond(command, { messageCount, sessionId: "fake", isStreaming: false });
	}
	if (command.type !== "prompt") return respond(command);
	const full = String(command.message);
	let text = full;
	if (text.startsWith("batch-")) {
		batch = [];
		text = text.slice("batch-".length);
	}
	// 恢复不了时助手服务把摘要放在第一句前面（#545）：剧本照用户自己的那句话选。
	const marker = "【以上是之前的对话；下面是用户这一次说的话】\n";
	if (full.startsWith("【平台说明】") && full.includes(marker)) {
		text = full.slice(full.lastIndexOf(marker) + marker.length);
	}
	if (text.startsWith("reject-late")) {
		// `reject-late:<毫秒>`：收下这句话过这么久才拒绝，其间不理 stdin 被关和 SIGTERM（只有 SIGKILL 结束得了它）：
		// 拒绝到的时候助手服务已经在结束进程（#677 复审的探测 R）。
		out({ type: "fake_prompt_received" });
		stubborn = true;
		setInterval(() => {}, 60_000);
		process.on("SIGTERM", () => out({ type: "fake_ignored_sigterm" }));
		setTimeout(
			() =>
				out({
					id: command.id,
					type: "response",
					command: "prompt",
					success: false,
					error: "不接受",
				}),
			Number(text.split(":")[1] ?? 900),
		);
		return;
	}
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
	messageCount += 2;
	persist();
	// 收到的整句话（含摘要）记一条，测试看放在第一句前面的东西。
	out({ type: "fake_prompt_text", text: full });
	out({ type: "agent_start" });
	out({ type: "turn_start" });
	out({ type: "message_end", message: { role: "user", content: [{ type: "text", text: full }] } });
	onSteer = undefined;
	// 默认：收到 abort 就停下（agent_settled，aborted）。
	onAbort = () => settle(true);
	if (text.startsWith("run:")) {
		// `run:<命令>;;<剧本>`：先在 pi 的工作目录里用 sh 执行这条命令（改工作区、往 .git 里放东西……），再照后面的剧本走。
		const split = text.indexOf(";;");
		execFileSync("sh", ["-c", text.slice("run:".length, split)], { stdio: "ignore" });
		text = text.slice(split + 2);
	}
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
	} else if (text.startsWith("hold-stdout")) {
		// `hold-stdout:<秒>`：不理 abort、SIGTERM；留一个子进程拿着标准输出这么久：SIGKILL 之后助手服务仍认为它没退出，
		// 直到子进程退出（#677 复审的探测 S-a、S-b：卡死的旧进程）。
		onAbort = () => {};
		stubborn = true;
		process.on("SIGTERM", () => out({ type: "fake_ignored_sigterm" }));
		spawn("sleep", [text.split(":")[1] ?? "6"], { stdio: ["ignore", "inherit", "ignore"] }).unref();
		setInterval(() => {}, 60_000);
	} else if (text.startsWith("settle-stubborn")) {
		// 做完这一轮；之后 stdin 被关也不退出（只有 SIGKILL 结束得了它）。
		stubborn = true;
		setInterval(() => {}, 60_000);
		out(assistant("好的"));
		settle();
	} else if (text.startsWith("delay-settle:")) {
		// `delay-settle:<毫秒>`：做这么久（真的时间）自己做完，其间不需要任何命令（不刷新「最近一次收到命令」）。
		const ms = Number(text.split(":")[1]?.split(" ")[0] ?? 300);
		setTimeout(() => {
			out(assistant("好的"));
			settle();
		}, ms);
	} else if (text.startsWith("settle-ignore-term")) {
		// 做完这一轮；之后 stdin 被关、SIGTERM 都不退出（只有 SIGKILL 结束得了它）：空闲时被关的卡住的进程。
		stubborn = true;
		process.on("SIGTERM", () => out({ type: "fake_ignored_sigterm" }));
		setInterval(() => {}, 60_000);
		out(assistant("好的"));
		settle();
	} else if (text.startsWith("say:")) {
		// `say:<助手的话>||<其余>`：做完这一轮，助手说 `||` 之前的话（`||` 之后是用户的话里别的内容，助手不复述）。
		out(assistant(text.slice("say:".length).split("||")[0]));
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
	} else if (text.startsWith("model-error:")) {
		// `model-error:<做几步>:<上游的错误>`：先做几步工具调用，再模型出错、重试用尽（#548：每一类错误、已经做了几步）。
		const [, steps, ...rest] = text.split(":");
		const error = rest.join(":");
		for (let i = 1; i <= Number(steps); i += 1) {
			out({
				type: "tool_execution_start",
				toolCallId: `m${i}`,
				toolName: "read",
				args: { path: "a" },
			});
			out({
				type: "tool_execution_end",
				toolCallId: `m${i}`,
				toolName: "read",
				result: { content: [{ type: "text", text: "ok" }] },
				isError: false,
				durationMs: 1,
			});
		}
		out(assistant("", { stopReason: "error", errorMessage: error }));
		out({ type: "auto_retry_end", success: false, attempt: 3, finalError: error });
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
		// secret 环境变量的值分两次写进标准错误（一个值跨两块）。
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
		// 上游把 secret 环境变量的值、模型的密钥（FAKE_MODEL_KEY 的值）、请求头和带凭据的地址回显在错误里，还很长。
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
	if (batch) {
		process.stdout.write(batch.join(""));
		batch = undefined;
	}
}
