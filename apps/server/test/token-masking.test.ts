// 令牌原值不会出现在任务日志、运行视图里（ADR 0029「凭据」，规格 #491）：打码规则认得令牌的前缀（`sfly_pat_…`、`sfly_prj_…` 等），
// 不用先知道是哪个令牌，没有 secret 参数的运行也一样打码；它是现有的值集合（`SecretSet`）的一部分，写入时打码
// （日志文件里没有原值），读取时也打码。
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { logsApi, SECRET_MASK, TOKEN_PREFIXES, TOKEN_VALUE_PATTERN } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	maskParams,
	maskRecord,
	maskTokens,
	maskValue,
	NO_SECRETS,
	secretSetOf,
} from "../src/logs/secrets.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const HEX = "0123456789abcdef0123456789abcdef0123456789abcdef";
const TOKENS = Object.values(TOKEN_PREFIXES).map((prefix) => `${prefix}${HEX}`);

describe("打码规则认得令牌的前缀", () => {
	it("每种前缀的令牌原值都换成掩码，周围的文字不动", () => {
		for (const token of TOKENS) {
			expect(NO_SECRETS.mask(`Authorization: Bearer ${token} 结束`)).toBe(
				`Authorization: Bearer ${SECRET_MASK} 结束`,
			);
		}
		// 一行里有好几个；token 在引号、等号、JSON 里。
		expect(maskTokens(`a=${TOKENS[0]} b="${TOKENS[1]}" {"t":"${TOKENS[2]}"}`)).toBe(
			`a=${SECRET_MASK} b="${SECRET_MASK}" {"t":"${SECRET_MASK}"}`,
		);
	});

	it("不是令牌的不动：前缀本身、后面太短的、别的以 sfly_ 开头的名字", () => {
		for (const text of [
			"sfly_pat_",
			"sfly_pat_abc",
			"sfly_std",
			"sfly_stub.nodes",
			"我的 sfly_ses 变量",
			"普通的日志行",
		]) {
			expect(NO_SECRETS.mask(text)).toBe(text);
		}
	});

	it("值集合：没有 secret 值时也打码令牌；有 secret 值时两样都打码", () => {
		expect(NO_SECRETS.mask(`t=${TOKENS[0]}`)).toBe(`t=${SECRET_MASK}`);
		const set = secretSetOf(["hunter2"]);
		expect(set.mask(`s=hunter2 t=${TOKENS[0]}`)).toBe(`s=${SECRET_MASK} t=${SECRET_MASK}`);
	});

	it("@sfly/schema 导出的那个带 g 标志的正则被别处用脏（lastIndex 不是 0）：mask、maskTokens、wouldChange 的结果不变，文字开头的令牌照样认", () => {
		const text = `${TOKENS[0]} 之后的文字 ${TOKENS[1]}`;
		const masked = `${SECRET_MASK} 之后的文字 ${SECRET_MASK}`;
		const set = secretSetOf(["hunter2"]);
		const dirty = [
			() => {
				TOKEN_VALUE_PATTERN.lastIndex = 5;
			},
			() => {
				// 别处对它调一次 test()：lastIndex 留在匹配的结尾
				TOKEN_VALUE_PATTERN.lastIndex = 0;
				TOKEN_VALUE_PATTERN.test(`xx ${TOKENS[2]}`);
			},
		];
		try {
			for (const spoil of dirty) {
				spoil();
				expect(maskTokens(text)).toBe(masked);
				spoil();
				expect(NO_SECRETS.mask(text)).toBe(masked);
				spoil();
				expect(set.mask(`${text} hunter2`)).toBe(`${masked} ${SECRET_MASK}`);
				spoil();
				expect(NO_SECRETS.wouldChange(text)).toBe(true);
				spoil();
				expect(set.wouldChange(text)).toBe(true);
			}
		} finally {
			TOKEN_VALUE_PATTERN.lastIndex = 0;
		}
	});

	it("maskValue、maskRecord、maskParams：对象、数组里的字符串都打码；没有变化的部分原样返回（不复制）", () => {
		const value = { a: [`x ${TOKENS[0]}`, 1, null], b: { c: TOKENS[1] }, d: "没有令牌" };
		expect(maskValue(value, NO_SECRETS)).toEqual({
			a: [`x ${SECRET_MASK}`, 1, null],
			b: { c: SECRET_MASK },
			d: "没有令牌",
		});
		expect(maskRecord({ out: TOKENS[3] }, NO_SECRETS)).toEqual({ out: SECRET_MASK });
		expect(maskParams({ env: `t=${TOKENS[0]}`, n: 1 }, new Set(), NO_SECRETS)).toEqual({
			env: `t=${SECRET_MASK}`,
			n: 1,
		});
		const clean = { a: ["普通", { b: 1 }], c: "文字" };
		expect(maskValue(clean, NO_SECRETS)).toBe(clean);
		expect(maskValue(clean.a, NO_SECRETS)).toBe(clean.a);
		expect(maskRecord(clean, NO_SECRETS)).toBe(clean);
	});
});

/** 数据目录里所有文件的内容里有没有这段文字。 */
async function dataDirContains(dir: string, needle: string): Promise<boolean> {
	for (const name of await readdir(dir)) {
		const path = join(dir, name);
		if ((await stat(path)).isDirectory()) {
			if (await dataDirContains(path, needle)) return true;
		} else if ((await readFile(path)).includes(needle)) {
			return true;
		}
	}
	return false;
}

describe("任务日志里的令牌原值", () => {
	let cp: TestControlPlane;
	let agent: FakeAgent;
	beforeEach(async () => {
		cp = await startTestControlPlane();
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	it("节点把令牌打印到日志里：写入时打码（文件里没有原值），分页读取、运行视图里也只有掩码；没有 secret 参数的运行也一样", async () => {
		const api = new ApiClient(cp);
		const scenario = await api.orchestrationWith({
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "a", kind: "package", package: "stub", node: "echo" },
			],
			edges: [{ from: "entry", to: "a", kind: "chain" }],
			packages: { stub: "1.0.0" },
		});
		await api.triggerOk(scenario);
		const task = await agent.nextAssign();
		const token = `${TOKEN_PREFIXES.personal}${HEX}`;
		agent.logs(task, [
			[1, `export SFLY_API_TOKEN=${token}`],
			[2, "这一行没有令牌"],
		]);
		await eventually(async () => {
			const res = await cp.fetch(`/tasks/${task.taskId}/logs?limit=100`);
			const page = logsApi.page.response.parse(await res.json());
			expect(page.lines.map((l) => l.text)).toEqual([
				`export SFLY_API_TOKEN=${SECRET_MASK}`,
				"这一行没有令牌",
			]);
		});
		// 下载的日志、文件里都没有原值。
		const download = await cp.fetch(`/tasks/${task.taskId}/logs/download`);
		expect(await download.text()).not.toContain(HEX);
		expect(await dataDirContains(cp.dataDir, HEX)).toBe(false);
	});
	it("任务凭据本身（AssignTask 带来的 sfly_tsk_ 原值，执行器里的 SFLY_TASK_TOKEN）：节点把它打印出来，日志文件、分页读取、下载里都只有掩码（按前缀认，不用先知道是哪个令牌）", async () => {
		const api = new ApiClient(cp);
		const scenario = await api.orchestrationWith({
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "a", kind: "package", package: "stub", node: "echo" },
			],
			edges: [{ from: "entry", to: "a", kind: "chain" }],
			packages: { stub: "1.0.0" },
		});
		await api.triggerOk(scenario);
		const task = await agent.nextAssign();
		expect(task.taskToken).toMatch(/^sfly_tsk_[0-9a-f]{48}$/);
		agent.logs(task, [
			[1, `env SFLY_TASK_TOKEN=${task.taskToken}`],
			[2, "这一行没有令牌"],
		]);
		await eventually(async () => {
			const res = await cp.fetch(`/tasks/${task.taskId}/logs?limit=100`);
			const page = logsApi.page.response.parse(await res.json());
			expect(page.lines.map((l) => l.text)).toEqual([
				`env SFLY_TASK_TOKEN=${SECRET_MASK}`,
				"这一行没有令牌",
			]);
		});
		const download = await cp.fetch(`/tasks/${task.taskId}/logs/download`);
		expect(await download.text()).not.toContain(task.taskToken.slice(TOKEN_PREFIXES.task.length));
		expect(await dataDirContains(cp.dataDir, task.taskToken)).toBe(false);
	});
});
