// 控制面读的数值类环境变量（#577）：端口、保留天数、各种上限、登录的空闲期限。启动时就检查：有限、在有意义的范围里；
// 不合法的写明变量名、填的原文和允许的范围，不留到运行时才出错。
// 以前只要求「大于 0」：`Infinity` 和很大的数都能通过——保留天数填得很大时，清理的截止时间早于数据库能表示的下限
// （约 247 万天起）或在控制面里就是无效的时间（约 1 亿天起），启动正常，清理任务每分钟报错、悄悄不清理。
import { describe, expect, it } from "vitest";
import { LOGIN_TOUCH_INTERVAL_MS } from "../src/auth/access-guard.js";
import {
	EnvSettingsError,
	MAX_LOGIN_IDLE_HOURS,
	MAX_RETENTION_DAYS,
	MIN_LOGIN_IDLE_MS,
	numericOptionProblems,
	readEnvSettings,
} from "../src/config/env-settings.js";

const MB = 1024 * 1024;
const HOUR = 3_600_000;
/** 换算成字节后还不超过 2^53 − 1 的最大整数 MB。 */
const LARGEST_MB = 2 ** 33 - 1;

/** 只读一个变量，其余不设置。 */
const one = (name: string, value: string | undefined) =>
	readEnvSettings(value === undefined ? {} : { [name]: value });

/** 不合法时抛出的说明（只有这一个变量不合法）。 */
const rejected = (name: string, value: string): string => {
	try {
		one(name, value);
	} catch (error) {
		expect(error).toBeInstanceOf(EnvSettingsError);
		return (error as Error).message;
	}
	throw new Error(`${name}=${JSON.stringify(value)} 应该被拒绝，却通过了`);
};

/** 不合法的原文：不是数、不是有限的数。 */
const NOT_NUMBERS = [
	"abc",
	"NaN",
	"Infinity",
	"-Infinity",
	"0x10",
	"1,5",
	"5 天",
	"--1",
	"1e",
	".",
];

describe("保留天数：SFLY_RETENTION_DAYS、SFLY_METRIC_RETENTION_DAYS", () => {
	const cases = [
		["SFLY_RETENTION_DAYS", "retentionDays"],
		["SFLY_METRIC_RETENTION_DAYS", "metricRetentionDays"],
	] as const;

	for (const [name, key] of cases) {
		describe(name, () => {
			it("没设置、空串、只有空白：用默认值（undefined）", () => {
				expect(one(name, undefined)[key]).toBeUndefined();
				expect(one(name, "")[key]).toBeUndefined();
				expect(one(name, "  ")[key]).toBeUndefined();
			});

			it.each([
				["30", 30],
				["0.5", 0.5],
				["1e2", 100],
				[" 7 ", 7],
				["36500", MAX_RETENTION_DAYS],
				["36499.99", 36499.99],
			])("%s 合法：%s 天", (raw, days) => {
				expect(one(name, raw)[key]).toBe(days);
			});

			it.each([
				["0"],
				["-1"],
				["-0.5"],
				["36501"],
				["2470000"],
				["2500000"],
				["100000000"],
				["1e9"],
				["1e308"],
				["1e400"],
				...NOT_NUMBERS.map((v) => [v]),
			])("%s 不合法：说明写明变量名、填的原文、范围，超限的还写怎么表示不想清理", (raw) => {
				const message = rejected(name, raw as string);

				expect(message).toContain(`${name} 不合法`);
				expect(message).toContain(JSON.stringify(raw));
				expect(message).toContain(`大于 0、不超过 ${MAX_RETENTION_DAYS} 的数（天）`);
				expect(message).toContain(`不想清理就填 ${MAX_RETENTION_DAYS}`);
			});

			it.each([
				["30d"],
				["30 天"],
				["Infinity"],
				["abc"],
				["1e400"],
			])("%s 不是（有限的）数：说明写明单位是天、只写数字，不带单位", (raw) => {
				const message = rejected(name, raw);

				expect(message).toContain("单位是天");
				expect(message).toContain("只写数字");
			});
		});
	}

	it("上限是 36500 天（100 年）", () => {
		expect(MAX_RETENTION_DAYS).toBe(36_500);
	});
});

describe("三个上限（MB）：SFLY_LOG_LIMIT_MB、SFLY_ARTIFACT_LIMIT_MB、SFLY_METRIC_LIMIT_MB", () => {
	const cases = [
		["SFLY_LOG_LIMIT_MB", "logLimitBytes", "单个任务日志的上限"],
		["SFLY_ARTIFACT_LIMIT_MB", "artifactLimitBytes", "产物合计的上限"],
		["SFLY_METRIC_LIMIT_MB", "metricLimitBytes", "单个任务指标数据的上限"],
	] as const;

	for (const [name, key, what] of cases) {
		describe(name, () => {
			it("没设置、空串：用默认值（undefined）", () => {
				expect(one(name, undefined)[key]).toBeUndefined();
				expect(one(name, "")[key]).toBeUndefined();
			});

			it.each([
				["200", 200 * MB],
				["0.5", MB / 2],
				["1e3", 1000 * MB],
				[String(LARGEST_MB), LARGEST_MB * MB],
			])("%s 合法", (raw, bytes) => {
				expect(one(name, raw)[key]).toBe(bytes);
			});

			it.each([
				["0"],
				["-1"],
				["0.0000001"], // 换算后不到 1 字节
				[String(LARGEST_MB + 1)], // 换算后超过 2^53 − 1
				["1e300"],
			])("%s 是数，但换算成字节后不在范围里：说明写明变量名、填的原文、范围和换算后的字节数", (raw) => {
				const message = rejected(name, raw as string);

				expect(message).toContain(`${name} 不合法`);
				expect(message).toContain(
					`${what}换算成字节后必须是 1 到 ${Number.MAX_SAFE_INTEGER} 之间的整数`,
				);
				expect(message).toContain(JSON.stringify(raw));
				expect(message).toContain("换算后");
			});

			it.each([
				["10MB"],
				["10 MB"],
				["1GB"],
				["Infinity"],
				["-Infinity"],
				["NaN"],
				["abc"],
				["1e400"],
			])("%s 不是（有限的）数：说明写明单位是 MB、只写数字，不写「换算后 NaN 字节」", (raw) => {
				const message = rejected(name, raw);

				expect(message).toContain(`${name} 不合法`);
				expect(message).toContain(JSON.stringify(raw));
				expect(message).toContain("单位是 MB");
				expect(message).toContain("只写数字");
				// 范围仍然写明。
				expect(message).toContain(`要是 1 到 ${Number.MAX_SAFE_INTEGER} 之间的整数`);
				expect(message).not.toContain("NaN 字节");
				expect(message).not.toContain("换算后");
			});
		});
	}
});

describe("登录的空闲期限（小时）：SFLY_LOGIN_IDLE_HOURS", () => {
	const name = "SFLY_LOGIN_IDLE_HOURS";

	it("没设置、空串：用默认值（undefined）", () => {
		expect(one(name, undefined).loginIdleMs).toBeUndefined();
		expect(one(name, "").loginIdleMs).toBeUndefined();
	});

	it("下限是登录续期间隔的两倍（从常量算出来，不写死）：续期只在距上次续期满 LOGIN_TOUCH_INTERVAL_MS 之后的请求里做，期限比这短，一直在用的登录也会过期", () => {
		expect(MIN_LOGIN_IDLE_MS).toBe(2 * LOGIN_TOUCH_INTERVAL_MS);
		expect(MIN_LOGIN_IDLE_MS).toBe(120_000);
	});

	it.each([
		["12", 12 * HOUR],
		["0.5", HOUR / 2],
		["0.04", 144_000],
		["0.0334", 120_240], // 刚过下限
		["0.03333333333333333", MIN_LOGIN_IDLE_MS], // 2 分钟 = 1/30 小时，小数写不尽
		["0.0333333333333333", MIN_LOGIN_IDLE_MS], // 四舍五入过的写法：浮点数乘出来是 119999.99999999987，向下取整会差 1 毫秒不够下限
		["0.29", 1_044_000], // 浮点数乘出来是 1043999.9999999999：按最近的毫秒算，不能少 1 毫秒
		["12.0000000001", 43_200_000], // 精确值 43200000.0036 毫秒：四舍五入是 43200000，向上取整会多 1 毫秒
		[String(MAX_LOGIN_IDLE_HOURS), MAX_LOGIN_IDLE_HOURS * HOUR],
	])("%s 合法", (raw, ms) => {
		expect(one(name, raw).loginIdleMs).toBe(ms);
	});

	it.each([
		["0"],
		["-1"],
		["0.0000000001"],
		["0.0001"], // 0.36 秒：以前通过了检查，登录返回 200 却下发 Max-Age=0，谁都登录不了
		["0.01"], // 36 秒：比续期间隔还短
		["0.03"], // 1 分 48 秒
		["0.0333"], // 差一点到 2 分钟
		[String(MAX_LOGIN_IDLE_HOURS + 1)],
		["1e9"],
		...NOT_NUMBERS.map((v) => [v]),
	])("%s 不合法：说明写明变量名、填的原文、最小值和原因、最大值", (raw) => {
		const message = rejected(name, raw as string);

		expect(message).toContain(`${name} 不合法`);
		expect(message).toContain(JSON.stringify(raw));
		expect(message).toContain(`2 分钟到 ${MAX_LOGIN_IDLE_HOURS} 小时之间的数`);
		expect(message).toContain("单位是小时");
		expect(message).toContain("下限是登录续期间隔（60 秒）的两倍");
		expect(message).toContain("一直在用的登录也会过期");
	});

	it("说明里「写 X 或更大」的 X 是从下限算出来的：写成 X 能通过，比 X 小一步（最后一位减 1）通不过", () => {
		const message = rejected(name, "0.01");
		const hint = /写 ([0-9.]+) 或更大/.exec(message)?.[1];

		expect(hint, message).toBeDefined();
		const text = hint as string;
		expect(one(name, text).loginIdleMs).toBeGreaterThanOrEqual(MIN_LOGIN_IDLE_MS);
		const decimals = text.split(".")[1]?.length ?? 0;
		const below = (Number(text) - 10 ** -decimals).toFixed(decimals);
		expect(() => one(name, below), `${below} 应该比下限小`).toThrow(EnvSettingsError);
	});

	it.each([
		["12h"],
		["12 小时"],
		["Infinity"],
		["abc"],
		["1e400"],
	])("%s 不是（有限的）数：说明写明单位是小时、只写数字", (raw) => {
		const message = rejected(name, raw);

		expect(message).toContain("单位是小时");
		expect(message).toContain("只写数字");
	});
});

describe("端口：SFLY_HTTP_PORT、SFLY_GRPC_PORT", () => {
	const cases = [
		["SFLY_HTTP_PORT", "httpPort", 8080],
		["SFLY_GRPC_PORT", "grpcPort", 50051],
	] as const;

	for (const [name, key, fallback] of cases) {
		describe(name, () => {
			it(`没设置、空串：默认 ${fallback}（以前空串读成 0，让系统随机选一个端口）`, () => {
				expect(one(name, undefined)[key]).toBe(fallback);
				expect(one(name, "")[key]).toBe(fallback);
			});

			it.each([
				["8080", 8080],
				["0", 0],
				["65535", 65535],
			])("%s 合法", (raw, port) => {
				expect(one(name, raw)[key]).toBe(port);
			});

			it.each([
				["65536"],
				["-1"],
				["-0"],
				["+8080"],
				["8080.0"],
				["1.5"],
				["1e3"],
				["0x1F90"],
				["80 80"],
				["99999999999"],
				...NOT_NUMBERS.map((v) => [v]),
			])("%s 不合法：说明写明变量名、填的原文、范围，只认不带符号的十进制整数", (raw) => {
				const message = rejected(name, raw as string);

				expect(message).toContain(`${name} 不合法`);
				expect(message).toContain("端口必须是 0 到 65535 之间的整数");
				expect(message).toContain("只认不带符号的十进制整数");
				expect(message).toContain(JSON.stringify(raw));
			});
		});
	}
});

describe("全部变量一起读", () => {
	it("什么都不设置：端口用默认值，别的数值都用各自的默认值（undefined；字符串类的见 env-settings-strings.test.ts）", () => {
		expect(readEnvSettings({})).toMatchObject({
			retentionDays: undefined,
			metricRetentionDays: undefined,
			logLimitBytes: undefined,
			artifactLimitBytes: undefined,
			metricLimitBytes: undefined,
			loginIdleMs: undefined,
			httpPort: 8080,
			grpcPort: 50051,
		});
	});

	it("全部填上限以内的最大值：都通过", () => {
		expect(
			readEnvSettings({
				SFLY_RETENTION_DAYS: String(MAX_RETENTION_DAYS),
				SFLY_METRIC_RETENTION_DAYS: String(MAX_RETENTION_DAYS),
				SFLY_LOG_LIMIT_MB: String(LARGEST_MB),
				SFLY_ARTIFACT_LIMIT_MB: String(LARGEST_MB),
				SFLY_METRIC_LIMIT_MB: String(LARGEST_MB),
				SFLY_LOGIN_IDLE_HOURS: String(MAX_LOGIN_IDLE_HOURS),
				SFLY_HTTP_PORT: "65535",
				SFLY_GRPC_PORT: "65535",
			}),
		).toMatchObject({
			retentionDays: MAX_RETENTION_DAYS,
			metricRetentionDays: MAX_RETENTION_DAYS,
			logLimitBytes: LARGEST_MB * MB,
			artifactLimitBytes: LARGEST_MB * MB,
			metricLimitBytes: LARGEST_MB * MB,
			loginIdleMs: MAX_LOGIN_IDLE_HOURS * HOUR,
			httpPort: 65535,
			grpcPort: 65535,
		});
	});

	it("几个变量同时不合法：一次报完，每个一条，其余合法的不受影响", () => {
		let caught: unknown;
		try {
			readEnvSettings({
				SFLY_RETENTION_DAYS: "Infinity",
				SFLY_METRIC_RETENTION_DAYS: "30",
				SFLY_LOG_LIMIT_MB: "1e300",
				SFLY_METRIC_LIMIT_MB: "abc",
				SFLY_HTTP_PORT: "70000",
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(EnvSettingsError);
		const { problems, message } = caught as EnvSettingsError;
		expect(problems).toHaveLength(4);
		for (const name of [
			"SFLY_RETENTION_DAYS",
			"SFLY_LOG_LIMIT_MB",
			"SFLY_METRIC_LIMIT_MB",
			"SFLY_HTTP_PORT",
		]) {
			expect(message, name).toContain(`${name} 不合法`);
		}
		expect(message).not.toContain("SFLY_METRIC_RETENTION_DAYS");
		expect(message).toContain("4 个环境变量不合法");
	});

	it("EnvSettingsError 的说明开头写的是它说的东西：环境变量，或者程序的选项", () => {
		expect(new EnvSettingsError(["甲", "乙"]).message).toBe("2 个环境变量不合法：\n  - 甲\n  - 乙");
		expect(new EnvSettingsError(["甲", "乙"], "选项").message).toBe(
			"2 个选项不合法：\n  - 甲\n  - 乙",
		);
		expect(new EnvSettingsError(["甲"], "选项").message).toBe("甲");
	});

	it("只有一个不合法时，说明就是那一条，不带「N 个」的前缀", () => {
		expect(rejected("SFLY_HTTP_PORT", "x")).toBe(
			'SFLY_HTTP_PORT 不合法：端口必须是 0 到 65535 之间的整数（0 是让系统选一个空闲端口），只认不带符号的十进制整数（不要写 +8080、8080.0、1e3、0x1F90），实际是 "x"',
		);
	});
});

describe("程序里直接给 startControlPlane 的数值选项：同一个范围", () => {
	it("没给、合法的：没有问题", () => {
		expect(numericOptionProblems({})).toEqual([]);
		expect(
			numericOptionProblems({
				retentionDays: MAX_RETENTION_DAYS,
				metricRetentionDays: 0.001,
				logLimitBytes: 500,
				artifactLimitBytes: 1,
				metricLimitBytes: 3 * 28,
				loginIdleMs: MIN_LOGIN_IDLE_MS,
			}),
		).toEqual([]);
	});

	it.each([
		["retentionDays", { retentionDays: MAX_RETENTION_DAYS + 1 }],
		["retentionDays", { retentionDays: Number.POSITIVE_INFINITY }],
		["retentionDays", { retentionDays: 0 }],
		["retentionDays", { retentionDays: Number.NaN }],
		["metricRetentionDays", { metricRetentionDays: 1e9 }],
		["metricRetentionDays", { metricRetentionDays: -1 }],
		["logLimitBytes", { logLimitBytes: Number.POSITIVE_INFINITY }],
		["logLimitBytes", { logLimitBytes: 0 }],
		["logLimitBytes", { logLimitBytes: 1.5 }],
		["metricLimitBytes", { metricLimitBytes: 2 ** 53 }],
		["artifactLimitBytes", { artifactLimitBytes: Number.NaN }],
		["loginIdleMs", { loginIdleMs: 0 }],
		["loginIdleMs", { loginIdleMs: 1 }],
		["loginIdleMs", { loginIdleMs: 500 }],
		["loginIdleMs", { loginIdleMs: 30_000 }],
		["loginIdleMs", { loginIdleMs: MIN_LOGIN_IDLE_MS - 1 }],
		["loginIdleMs", { loginIdleMs: Number.POSITIVE_INFINITY }],
		["loginIdleMs", { loginIdleMs: MAX_LOGIN_IDLE_HOURS * HOUR + 1 }],
	])("%s 不合法：说明写明选项名", (name, options) => {
		const problems = numericOptionProblems(options);

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain(`${name} 不合法`);
	});

	it("loginIdleMs 的说明用毫秒写（选项的单位是毫秒，不是环境变量的小时），写明最小值和原因", () => {
		const [problem] = numericOptionProblems({ loginIdleMs: 500 });

		expect(problem).toContain("loginIdleMs 不合法");
		expect(problem).toContain(
			`必须是 ${MIN_LOGIN_IDLE_MS} 到 ${MAX_LOGIN_IDLE_HOURS * HOUR} 毫秒之间的整数`,
		);
		expect(problem).toContain("2 分钟到 876000 小时");
		expect(problem).toContain("实际是 500");
		expect(problem).not.toContain("（小时）");
	});
});
