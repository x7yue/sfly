import type { SessionEventBody } from "@sfly/schema";

// 会话页时间线定稿（#550）的固定事件序列：e2e、视觉基线和设计评审用的截图都用它们，内容固定，截图里没有随机的东西。
// 故事是虚构的（场景「接口巡检」、节点 http_check），不取自任何真实使用方。事件写的是「事件的内容」（没有 seq、at）：
// `seedSession` 按序写进库里，序号从 1 起，时间从第一条起每条晚一秒。

export const USAGE = { input: 1200, output: 80, cache_read: 900, cache_write: 0 };

export const SCENARIO_ID = "6a1e4f3c-9b7d-4e58-a2c1-5d0f8e7b3a96";
export const SCENARIO_NAME = "接口巡检";
/** 两次运行的 ID：时间线上写前 8 位（`shortId`）。 */
export const RUN_IDS = [
	"e5b8a0d2-4c36-4f19-8b7a-1d2c3e4f5a6b",
	"b17c93f4-6a28-4d05-9e3b-7c4d1a0e2f58",
] as const;
export const COMMIT_HASHES = [
	"8c2e41a9d0b7e5f36a1c4b8d2e7f90a3b5c6d1e4",
	"3f1c2ab9d0e4a5b6c7d8e9f00112233445566778",
	"a94d07c1e2b53f68d0c9a7b4e1f26358d4c0b7a9",
] as const;

const ID = (n: number) => `5d1c0a7e-3b2f-4c68-9a41-00000000000${n}`;
export const MESSAGE_IDS = { first: ID(1), steer: ID(2), steerLost: ID(3), second: ID(4) } as const;

const ESC = "\u001b";

type Body<T extends SessionEventBody["type"]> = Extract<SessionEventBody, { type: T }>;

const call = (id: string, tool: Body<"tool_call">["tool"], title: string): Body<"tool_call"> => ({
	type: "tool_call",
	call_id: id,
	tool,
	title,
});

const result = (id: string, over: Partial<Body<"tool_result">> = {}): Body<"tool_result"> => ({
	type: "tool_result",
	call_id: id,
	is_error: false,
	text: "",
	truncated: false,
	duration_ms: 420,
	...over,
});

/** pi 的命令工具在退出码不为 0 时，在输出后面接一个空行和这一句；输出本来就以换行结尾，页面上就多出空白（#550 评论）。 */
export const EXIT_LINE = "Command exited with code 1";

/**
 * 一次像真实会话的第 1 轮：用户要给 http_check 加超时参数并跑一遍巡检。助手读文件、跑命令（颜色码、失败、并行的两个调用）、改文件、
 * 写测试、被限流重试、上下文压缩，平台提交了工作区、保存了场景的一个版本、触发了两次运行。
 *
 * **答案**（设计评审用，只看「平台记录」就能答出来的，`REVIEW_PLATFORM_ANSWER`）：场景「接口巡检」保存了版本 4；触发了 2 次运行
 * （e5b8a0d2、b17c93f4）；提交了 2 次（会话开始之前工作区里留下的改动 1 次、这一轮做的改动 1 次）。
 */
export const firstTurn = (): SessionEventBody[] => [
	{
		type: "user_message",
		message_id: MESSAGE_IDS.first,
		text: `给 http_check 加一个超时参数（秒，默认 30），改好后把「${SCENARIO_NAME}」保存成新版本并跑两遍，看结果。`,
		steer: false,
		author: "alice",
		author_user_id: null,
	},
	{ type: "turn_started", turn: 1 },
	{
		// 会话开始之前工作区里留下的改动：第 1 轮开始前补提交的。
		type: "platform",
		kind: "commit",
		turn: 1,
		hash: COMMIT_HASHES[0],
		files: [{ path: "NOTES.md", additions: 2, deletions: 0 }],
		diff: "diff --git a/NOTES.md b/NOTES.md\nindex 1c2d3e4..5f6a7b8 100644\n--- a/NOTES.md\n+++ b/NOTES.md\n@@ -3,0 +4,2 @@\n+- 巡检的超时先按 30 秒\n+- 参数名待定\n",
		truncated: false,
	},
	{
		type: "assistant_message",
		text: "我先看一下 http_check 现在怎么写的，再看场景里用到它的地方。",
		usage: USAGE,
	},
	call("c1", "read", "nodes/http_check.py"),
	result("c1", {
		text: "import requests\n\n\ndef run(url: str) -> int:\n    return requests.get(url).status_code\n",
		duration_ms: 8,
	}),
	call("c2", "command", "sfly package list"),
	result("c2", { text: "http_check 0.3.0\nmetric_rate 0.2.1\n", exit_code: 0 }),
	// 模型一次发出两个调用：它们同时跑，后开始的先出结果。
	call("c3", "command", "uv run pytest -q tests/test_http_check.py"),
	call("c4", "command", "sfly scenario show 接口巡检"),
	result("c4", { text: "接口巡检  版本 3  4 个节点\n", exit_code: 0, duration_ms: 310 }),
	result("c3", {
		is_error: true,
		// 颜色码；输出以换行结尾，pi 再接一个空行和退出说明。
		text: `${ESC}[1m${ESC}[31mFAILED${ESC}[0m tests/test_http_check.py::test_timeout - TypeError: run() got an unexpected keyword argument 'timeout'\n\n\n${EXIT_LINE}`,
		exit_code: 1,
		duration_ms: 2_900,
	}),
	{
		type: "notice",
		kind: "retry",
		message: "模型限流（429），12 秒后第 1 次重试（最多 3 次）",
		attempt: 1,
		max_attempts: 3,
		retry_delay_ms: 12_000,
		error_class: "rate_limit",
	},
	call("c5", "edit", "nodes/http_check.py"),
	result("c5", {
		text: "Successfully replaced 1 block(s) in nodes/http_check.py.",
		diff: "-1 def run(url: str) -> int:\n+1 def run(url: str, timeout: float = 30.0) -> int:\n 2     return requests.get(url).status_code\n-3\n+3     return requests.get(url, timeout=timeout).status_code",
		duration_ms: 12,
	}),
	call("c6", "write", "tests/test_timeout.py"),
	result("c6", { text: "Successfully wrote 312 bytes to tests/test_timeout.py", duration_ms: 6 }),
	{ type: "notice", kind: "compaction", message: "上下文太长，已经压缩成一段摘要" },
	call("c7", "command", "uv run pytest -q tests/test_http_check.py"),
	result("c7", {
		text: "..                                                                       [100%]\n2 passed in 0.31s\n",
		exit_code: 0,
		duration_ms: 2_100,
	}),
	{
		type: "platform",
		kind: "commit",
		turn: 1,
		hash: COMMIT_HASHES[1],
		files: [
			{ path: "nodes/http_check.py", additions: 2, deletions: 2 },
			{ path: "tests/test_timeout.py", additions: 14, deletions: 0 },
		],
		diff: "diff --git a/nodes/http_check.py b/nodes/http_check.py\nindex 8c2e41a..f31b7d0 100644\n--- a/nodes/http_check.py\n+++ b/nodes/http_check.py\n@@ -1,5 +1,5 @@\n import requests\n \n \n-def run(url: str) -> int:\n-    return requests.get(url).status_code\n+def run(url: str, timeout: float = 30.0) -> int:\n+    return requests.get(url, timeout=timeout).status_code\n",
		truncated: false,
	},
	{
		type: "platform",
		kind: "scenario_version",
		turn: 1,
		scenario_id: SCENARIO_ID,
		name: SCENARIO_NAME,
		version: 4,
	},
	{ type: "platform", kind: "run", turn: 1, run_id: RUN_IDS[0], scenario_name: SCENARIO_NAME },
	{ type: "platform", kind: "run", turn: 1, run_id: RUN_IDS[1], scenario_name: SCENARIO_NAME },
	{
		type: "assistant_message",
		text: "改好了，两次运行都已触发：\n\n- `http_check` 新增参数 `timeout`（秒，默认 30）\n- 补了 `tests/test_timeout.py`，两个用例通过\n- 场景「接口巡检」保存成了版本 4\n\n之后可以这样单独跑一遍：\n\n```bash\nsfly run start 接口巡检 --wait --timeout 90s\n```\n\n详见[用户文档](https://example.com/docs)。",
		usage: USAGE,
	},
	{
		type: "turn_end",
		turn: 1,
		outcome: "completed",
		reason: "助手已完成",
		steps: 7,
		model_calls: 9,
		duration_ms: 84_000,
		usage: USAGE,
	},
];

/** 设计评审的答案：这次会话真实做了什么（只看平台记录就能答出来的）。 */
export const REVIEW_PLATFORM_ANSWER = {
	scenario: SCENARIO_NAME,
	version: 4,
	runs: 2,
	commits: 2,
} as const;

/**
 * 「全部条目」：在第 1 轮后面接上其余的条目和状态——第 2 轮里用户插话（一句等待送达之外已送到、一句没有送到）、
 * 命令一直没有结果就被中断（已中止）；第 3 轮到了上限；第 4 轮模型不可用；第 5 轮出错；最后会话结束。
 */
export const allItems = (): SessionEventBody[] => [
	...firstTurn(),
	{
		type: "user_message",
		message_id: MESSAGE_IDS.second,
		text: "再把超时参数写进用户文档里。",
		steer: false,
		author: "alice",
		author_user_id: null,
	},
	{ type: "turn_started", turn: 2 },
	{
		type: "user_message",
		message_id: MESSAGE_IDS.steer,
		text: "顺便把默认值改成 20 秒",
		steer: true,
		author: "bob",
		author_user_id: null,
	},
	{
		type: "user_message",
		message_id: MESSAGE_IDS.steerLost,
		text: "文档里加一个例子",
		steer: true,
		author: "bob",
		author_user_id: null,
	},
	{
		type: "notice",
		kind: "steer_dropped",
		message: "这句插话没有确认送到助手（助手服务没有及时回应），需要的话再说一次",
		message_id: MESSAGE_IDS.steerLost,
	},
	call("d1", "command", "sfly docs build --watch"),
	{
		type: "turn_end",
		turn: 2,
		outcome: "interrupted",
		reason: "助手服务重启了；工作区和已经触发的运行不受影响，说一句话可以接着做",
		steps: 1,
		duration_ms: 31_000,
	},
	{ type: "notice", kind: "events_lost", message: "控制面和助手服务断开太久，这一段过程没有记下" },
	{ type: "notice", kind: "context_reset", message: "接不上之前的上下文，换成了一段摘要" },
	{
		type: "turn_end",
		turn: 3,
		outcome: "limit",
		reason: "到了模型调用次数的上限",
		limit_kind: "model_calls",
		steps: 38,
		model_calls: 40,
		duration_ms: 610_000,
	},
	{
		type: "turn_end",
		turn: 4,
		outcome: "model_unavailable",
		reason: "额度不足（402）",
		error_class: "quota",
		steps: 7,
		duration_ms: 19_000,
	},
	{
		type: "turn_end",
		turn: 5,
		outcome: "failed",
		reason: "工作台连不上：bench-1",
		steps: 2,
		duration_ms: 8_000,
	},
	{ type: "session_ended", by: "alice" },
];
