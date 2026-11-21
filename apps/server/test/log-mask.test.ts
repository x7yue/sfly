// 读日志时的打码（#517，logs/log-mask.ts）：没有 secret 值时什么都不做；行里没有 secret 值时原样返回同一个对象；
// 有时只改正文，行里其余字段和顺序不变。
import { describe, expect, it } from "vitest";
import { logMask, NO_LOG_MASK } from "../src/logs/log-mask.js";
import { SECRET_MASK as MASK, NO_SECRETS, secretSetOf } from "../src/logs/secrets.js";

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
