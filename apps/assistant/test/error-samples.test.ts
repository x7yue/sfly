// 产品的错误分类和评测集的一致（#548 验收标准）：同一份夹具（evals/assistant/tests/fixtures/error-samples.json，评测集的测试
// 里已有的错误样本加上产品自己的边界样本），评测集的结论由 evals/assistant/tests/test_error_samples.py 守着；
// 这里断言产品的类别对应到同一个评测集类别。**例外逐条列在 EXCEPTIONS 里、每条一句理由**：产品故意更保守的几种。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ErrorClass } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { describeUpstreamError } from "../src/upstream-error.js";

const FIXTURE = join(
	import.meta.dirname,
	"../../../evals/assistant/tests/fixtures/error-samples.json",
);

interface Sample {
	name: string;
	message: string;
	/** 评测集的失败分类（classify.py 的 `primary`）。 */
	eval: string;
}
const SAMPLES = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { samples: Sample[] }).samples;

/**
 * 评测集只分三种（环境故障 = 模型端点的问题；上下文耗尽；认不出的错误），产品分八种：产品的六种端点类别都对应评测集的「环境故障」，
 * `context_overflow` 对应「上下文耗尽」，`other` 对应「认不出的错误」。
 */
const EVAL_CATEGORY: Record<ErrorClass, string> = {
	unreachable: "环境故障",
	timeout: "环境故障",
	auth: "环境故障",
	quota: "环境故障",
	rate_limit: "环境故障",
	upstream: "环境故障",
	context_overflow: "上下文耗尽",
	other: "认不出的错误",
};

/**
 * 产品和评测集对不上的样本：产品的类别在这里钉死，并且必须真的和评测集不同（夹具或规则改了、例外不再成立时，这里会失败，
 * 不会留一条过期的例外）。产品都是故意更保守的：`error_class` 落库之后改不了，所以认不准的分到 `other`，不猜；评测集
 * 按正文里出现的词判，宁可多作废几次会话（那只是重跑一次）。评测集的规则不改。
 */
const EXCEPTIONS: Record<string, { productClass: ErrorClass; reason: string }> = {
	"流读到一半断开，没有错误码": {
		productClass: "other",
		reason:
			"没有状态码也没有连接层的错误码，整句又不是 SDK 固定的「terminated」：产品不凭措辞猜是连接断了",
	},
	"真 400，正文提到 insufficient": {
		productClass: "other",
		reason: "状态码 400 定了是上游拒绝请求，正文里的 insufficient（权限）不能改判成端点故障",
	},
	"真 404，正文提到 rate limit": {
		productClass: "other",
		reason: "状态码 404 定了是上游拒绝请求，正文里提到限流文档不能改判成限流",
	},
	"真 400，正文提到 fetch failed": {
		productClass: "other",
		reason: "状态码 400 定了是上游拒绝请求，正文里的 fetch failed 说的是别的资源",
	},
	"429，正文提到上下文": {
		productClass: "rate_limit",
		reason:
			"状态码 429 定了是限流，正文里提到上下文不改变类别；评测集看到上下文的词就记成上下文耗尽",
	},
	"没有状态码，正文说超时": {
		productClass: "other",
		reason: "没有状态码时只认连接层的错误码和 SDK 固定的整句，不看正文里的「timed out」",
	},
	"没有状态码，正文说限流": {
		productClass: "other",
		reason: "没有状态码时只认连接层的错误码和 SDK 固定的整句，不看正文里的「rate limit」",
	},
	"没有状态码，正文说上下文超长": {
		productClass: "other",
		reason: "上下文超长只在有状态码（4xx）时按正文细分；没有状态码时不看正文里的词",
	},
	"没有状态码，正文里提到连接被拒": {
		productClass: "other",
		reason: "连接层的错误码只认消息开头的 Node 写法或末尾括号里的，正文中途出现的不算",
	},
};

describe("产品的错误类别和评测集的失败分类一致（同一份夹具）", () => {
	it("夹具里的名字不重复、每个例外都在夹具里", () => {
		const names = SAMPLES.map((s) => s.name);
		expect(new Set(names).size).toBe(names.length);
		for (const name of Object.keys(EXCEPTIONS)) expect(names, name).toContain(name);
	});

	it.each(SAMPLES.map((s) => [s.name, s] as const))("%s", (name, sample) => {
		const { errorClass } = describeUpstreamError(sample.message);
		const exception = EXCEPTIONS[name];
		if (exception === undefined) {
			expect(EVAL_CATEGORY[errorClass]).toBe(sample.eval);
			return;
		}
		// 例外：产品的类别钉死在这里，并且对应的评测集类别确实和评测集的不同。
		expect(errorClass).toBe(exception.productClass);
		expect(EVAL_CATEGORY[errorClass], exception.reason).not.toBe(sample.eval);
	});
});
