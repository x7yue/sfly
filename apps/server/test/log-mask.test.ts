// 读日志时的打码（#517，logs/log-mask.ts）：没有 secret 值时什么都不做；行里没有 secret 值时原样返回同一个对象；
// 有时只改正文，行里其余字段和顺序不变。
import { describe, expect, it } from "vitest";
import { logMask, NO_LOG_MASK } from "../src/logs/log-mask.js";
import {
	SECRET_MASK as MASK,
	NO_SECRETS,
	OVERSIZE_NOTICE,
	secretSetOf,
	WorkBudget,
} from "../src/logs/secrets.js";
import { allForms } from "./support/secret-forms.js";
import { withSecretLimitsSync } from "./support/secret-limits.js";

const rowOf = (fields: Record<string, unknown>) => Buffer.from(JSON.stringify(fields));
/** 一组 secret 值（每个值是一个 secret 参数的值）的读日志打码。 */
const maskOf = (...values: unknown[]) => logMask(secretSetOf(values));
const row = { seq: 1, time: "2026-01-01T00:00:00.000Z", source: "stdout", level: "info" };

describe("读日志时的打码", () => {
	it("没有 secret 值：用 NO_LOG_MASK，不处理任何东西", () => {
		expect(logMask(NO_SECRETS)).toBe(NO_LOG_MASK);
		// 只有没有内容的容器：什么都不用打，同样是 NO_LOG_MASK。
		expect(maskOf({}, [], { k: "" })).toBe(NO_LOG_MASK);
		expect(NO_LOG_MASK.active).toBe(false);
		const line = { text: "hello" };
		expect(NO_LOG_MASK.line(line)).toBe(line);
		const bytes = rowOf({ ...row, text: "hello" });
		expect(NO_LOG_MASK.row(bytes)).toBe(bytes);
	});

	it("行（对象）：正文里没有 secret 值时是同一个对象，有时只换正文", () => {
		const mask = maskOf("s3cr3t");
		expect(mask.active).toBe(true);
		const plain = { seq: 1, text: "nothing here" };
		expect(mask.line(plain)).toBe(plain);
		const secret = { seq: 2, text: "a s3cr3t b s3cr3t" };
		expect(mask.line(secret)).toEqual({ seq: 2, text: `a ${MASK} b ${MASK}` });
		expect(secret.text).toBe("a s3cr3t b s3cr3t");
	});

	it("文件里的一行：没有 secret 值时是同一个 Buffer（不解析）；有时换掉正文，其余字段和顺序不变", () => {
		const mask = maskOf("s3cr3t");
		const plain = rowOf({ ...row, text: "nothing here" });
		expect(mask.row(plain)).toBe(plain);
		const secret = rowOf({ ...row, text: "token=s3cr3t" });
		const masked = mask.row(secret);
		expect(masked.toString("utf8")).toBe(JSON.stringify({ ...row, text: `token=${MASK}` }));
	});

	it("升级之前写入的行（只有 Agent 时间）同样只换正文", () => {
		const mask = maskOf("s3cr3t");
		const legacy = rowOf({
			seq: 1,
			time: "2026-01-01T00:00:00.000Z",
			level: "info",
			text: "s3cr3t",
		});
		expect(JSON.parse(mask.row(legacy).toString("utf8"))).toEqual({
			seq: 1,
			time: "2026-01-01T00:00:00.000Z",
			level: "info",
			text: MASK,
		});
	});

	it("secret 值里有引号、反斜杠、换行：文件里是转义后的写法，照样找得到、换得掉", () => {
		const tricky = 'pa"ss\\word\nend';
		const mask = maskOf(tricky);
		const bytes = rowOf({ ...row, text: `login ${tricky} ok` });
		expect(bytes.toString("utf8")).not.toContain(tricky);
		const masked = mask.row(bytes);
		expect(JSON.parse(masked.toString("utf8")).text).toBe(`login ${MASK} ok`);
		expect(masked.toString("utf8")).not.toContain("word");
	});

	it("没有 text 字段或不是字符串的行原样返回", () => {
		const mask = maskOf("s3cr3t");
		const odd = rowOf({ ...row, extra: "s3cr3t" });
		expect(mask.row(odd)).toBe(odd);
	});

	it("对象类型的 secret 参数：不少于 4 个字符的叶子按值打码，更短的叶子不单独打码；整个对象原样写出时整段盖住", () => {
		const config = { env: "prod", region: "a", user: "admin", pin: 8260413 };
		const mask = maskOf(config);
		const single = mask.row(rowOf({ ...row, text: "env=prod region=a user=admin pin=8260413" }));
		expect(JSON.parse(single.toString("utf8")).text).toBe(
			`env=${MASK} region=a user=${MASK} pin=${MASK}`,
		);
		const whole = mask.row(rowOf({ ...row, text: `cfg=${JSON.stringify(config)}` }));
		expect(JSON.parse(whole.toString("utf8")).text).toBe(`cfg=${MASK}`);
		// 只有短叶子的行没有任何可打码的内容：同一个 Buffer，不解析。
		const shortOnly = rowOf({ ...row, text: "region a, took 1 s" });
		expect(mask.row(shortOnly)).toBe(shortOnly);
	});

	it("多行的 secret 值：日志按行写，每一行（不少于 4 个字符的）单独出现也打码", () => {
		const mask = maskOf("-----BEGIN TEST KEY-----\ntest-pem-line-one\nxy\n-----END TEST KEY-----");
		const masked = mask.row(rowOf({ ...row, text: "test-pem-line-one" }));
		expect(JSON.parse(masked.toString("utf8")).text).toBe(MASK);
		const short = rowOf({ ...row, text: "xy" });
		expect(mask.row(short)).toBe(short);
	});

	it("非 ASCII 的 secret 值：文件里是原文（JSON.stringify 不转义），行对象里也是原文", () => {
		const mask = maskOf("口令一二三");
		const masked = mask.row(rowOf({ ...row, text: "login 口令一二三 ok" }));
		expect(JSON.parse(masked.toString("utf8")).text).toBe(`login ${MASK} ok`);
		expect(mask.line({ text: "口令一二三" })).toEqual({ text: MASK });
	});
});

describe("文件里的一行：每种写法读出来都和写入时打码的结果一样（任务日志下载用的 row）", () => {
	/** 各类 secret 值（都是假值）：普通、带引号、带反斜杠、带制表符、带换行、非 ASCII、对象（含只有短叶子的）、数字。 */
	const values: Record<string, unknown> = {
		plain: "FAKE-tok-0123456789abcdef",
		quote: 'FAKE"tok"quoted',
		backslash: "FAKE\\tok\\path",
		tab: "FAKE\ttok\tabbed",
		newline: "FAKE-line-one\nFAKE-line-two",
		nonascii: "口令一二三四五六",
		object: { env: "fake-env-value", user: "fake-user", pin: 8260413 },
		shortOnly: { a: "b", n: 1, on: true },
		number: 8260413,
		small: 0.000025,
	};

	/** 这个值的每种写法，各自写成日志行的正文（带前后文字），经 row 读出的正文，和写入时的打码结果（`SecretSet.mask`）比。 */
	for (const [kind, value] of Object.entries(values)) {
		it(`${kind}：全部写法，下载读出的和写入时打码的逐条相同`, () => {
			const set = secretSetOf([value]);
			const mask = logMask(set);
			const forms = allForms({ value });
			expect(forms.length).toBeGreaterThan(0);
			let changed = 0;
			for (const form of forms) {
				const text = `before ${form} after`;
				const decoded = JSON.parse(mask.row(rowOf({ ...row, text })).toString("utf8")).text;
				expect(decoded, `${kind}：${JSON.stringify(form)}`).toBe(set.mask(text));
				if (set.mask(text) !== text) changed += 1;
			}
			// 每一类至少有一种写法是被打码的（不是整个都没盖）
			expect(changed, kind).toBeGreaterThan(0);
		});
	}

	it("按页读取的 line 和下载的 row 对同一行结果相同", () => {
		const set = secretSetOf(Object.values(values));
		const mask = logMask(set);
		for (const form of allForms(values)) {
			const text = `x ${form} y`;
			const fromRow = JSON.parse(mask.row(rowOf({ ...row, text })).toString("utf8")).text;
			expect(fromRow, JSON.stringify(form)).toBe(mask.line({ text }).text);
		}
	});

	it("行里有反斜杠但没有 secret 值：原样返回同一个 Buffer；格式坏的行不抛错，也不放行 secret 值", () => {
		const mask = maskOf("FAKE-tok-0123456789abcdef");
		const escaped = rowOf({ ...row, text: 'say "hi"\n' });
		expect(escaped.toString("utf8")).toContain("\\");
		expect(mask.row(escaped)).toBe(escaped);
		const broken = Buffer.from('{"seq":1,"text":"FAKE-tok-0123456789abcdef\\');
		expect(mask.row(broken).toString("utf8")).not.toContain("FAKE-tok");
		const brokenPlain = Buffer.from('{"seq":1,"text":"ok\\');
		expect(mask.row(brokenPlain)).toBe(brokenPlain);
	});
});

describe("读日志的预算：一页、一块、一批共用一份（完整的出现的段数）（#517）", () => {
	// 读取预算调小（只给测试用）：用几行就能用完预算；真实的上限是 2^20 段
	const VALUE = "fake-secret-value-00";
	const line = (i: number) => `line ${i} ${VALUE} end`;
	const set = secretSetOf([VALUE]);

	it("按页读取（line）：一页的行共用一份预算，用完之后剩下有完整出现的行整行盖住，没有的原样；换一份新的（fresh）照常", () => {
		withSecretLimitsSync({ readMasks: 3 }, () => {
			const mask = logMask(set);
			const out = Array.from({ length: 6 }, (_, i) => mask.line({ seq: i, text: line(i) }).text);
			expect(out).toEqual([
				`line 0 ${MASK} end`,
				`line 1 ${MASK} end`,
				`line 2 ${MASK} end`,
				MASK,
				MASK,
				MASK,
			]);
			// 预算用完之后，没有 secret 值的行原样（再长也是）；有的整行盖住
			expect(mask.line({ text: "clean line" }).text).toBe("clean line");
			const long = "z".repeat(1_000_000);
			expect(mask.line({ text: long }).text).toBe(long);
			expect(mask.line({ text: line(9) }).text).toBe(MASK);
			// 下一页、下一块、下一批：新的预算
			const next = mask.fresh();
			expect(next).not.toBe(mask);
			expect(next.active).toBe(true);
			expect(next.line({ text: "clean line" }).text).toBe("clean line");
			expect(next.line({ text: "a fake-secret-value-00 b" }).text).toBe(`a ${MASK} b`);
		});
	});

	it("下载（row）：同样，一块里的行共用一份预算，每一块（fresh）一份新的；一行里的一处完整的出现只记一次", () => {
		withSecretLimitsSync({ readMasks: 3 }, () => {
			const mask = logMask(set);
			const texts = Array.from(
				{ length: 6 },
				(_, i) =>
					JSON.parse(mask.row(rowOf({ ...row, seq: i, text: line(i) })).toString("utf8")).text,
			);
			// 一行里只有一处：预算 3 正好够前面三行，后面的整行盖住（记两次的话只够一行半）
			expect(texts).toEqual([
				`line 0 ${MASK} end`,
				`line 1 ${MASK} end`,
				`line 2 ${MASK} end`,
				MASK,
				MASK,
				MASK,
			]);
			// 用完之后：没有 secret 值的行原样返回同一个 Buffer
			const clean = rowOf({ ...row, text: "clean line" });
			expect(mask.row(clean)).toBe(clean);
			// 有反斜杠的行（正文里有换行）：解析之后在正文上打码，同样只记一次
			const escaped = rowOf({ ...row, text: `a\n${VALUE}` });
			expect(JSON.parse(mask.row(escaped).toString("utf8")).text).toBe(MASK);
			const fresh = mask.fresh();
			expect(fresh.row(clean)).toBe(clean);
			expect(JSON.parse(fresh.row(escaped).toString("utf8")).text).toBe(`a\n${MASK}`);
			expect(NO_LOG_MASK.fresh()).toBe(NO_LOG_MASK);
		});
	});

	it("一页的预算可以由调用方给（共用同一份预算的两个读取）", () => {
		const budget = new WorkBudget(2);
		const first = logMask(set, budget);
		const second = logMask(set, budget);
		expect(first.line({ text: line(1) }).text).toBe(`line 1 ${MASK} end`);
		expect(second.line({ text: line(2) }).text).toBe(`line 2 ${MASK} end`);
		expect(first.line({ text: line(3) }).text).toBe(MASK);
		expect(budget.masks).toBe(0);
	});

	it("正常的读取不会用光预算：一页 1000 行，每行出现一个 secret 值；任意长的行没有 secret 值也一个字不盖", () => {
		const values = Array.from({ length: 100 }, (_, i) => `fake-secret-${i}-value`);
		const mask = logMask(secretSetOf(values));
		for (let i = 0; i < 1000; i++) {
			const masked = mask.line({ text: `request ${i} used ${values[i % 100]} and finished` });
			expect(masked.text).toBe(`request ${i} used ${MASK} and finished`);
		}
		expect(mask.line({ text: "still clean" }).text).toBe("still clean");
		const huge = "y".repeat(1024 * 1024);
		for (let i = 0; i < 40; i++) expect(mask.line({ text: huge }).text).toBe(huge);
	});

	it("值集合太大（建不了自动机）：每行整行盖住，只有平台写的那一行说明（OVERSIZE_NOTICE）原样，读取（line、row）一样", () => {
		withSecretLimitsSync({ automatonChars: 50 }, () => {
			const big = secretSetOf([`fake-oversize-${"v".repeat(100)}`]);
			expect(big.oversize).toBe(true);
			const mask = logMask(big);
			expect(mask.line({ text: "clean line" }).text).toBe(MASK);
			expect(mask.line({ text: OVERSIZE_NOTICE }).text).toBe(OVERSIZE_NOTICE);
			expect(
				JSON.parse(mask.row(rowOf({ ...row, text: "clean line" })).toString("utf8")).text,
			).toBe(MASK);
			const notice = rowOf({ ...row, source: "system", level: "warn", text: OVERSIZE_NOTICE });
			expect(mask.row(notice)).toBe(notice);
		});
	});
});
