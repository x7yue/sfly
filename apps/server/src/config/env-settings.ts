// 控制面读的环境变量里，数值类（#577）和字符串类（#619：代理信任、跨域来源、初始管理员、对外地址、数据库地址、镜像地址）
// 启动时就检查，不合法的写明变量名、填的值和要求，控制面不启动，不留到运行时才出错；全部收集起来一次报完。
// 报错里不回显填的值，只有数值类的回显（最多 12 个字符，echo.ts）：地址类、名单类、代理类的写变量名、第几项、哪里不对和一个例子，数据库地址、
// 管理员密码是固定的文字，管理员登录名、显示名的说明里从不出现填的值；所以凭据不会进启动输出和容器日志。
// 报错的顺序是读的顺序（稳定）：先是网关端口、对外地址、网关地址（网关的对外地址要用它们算），再是数据目录、保留天数……端口、两个监听地址、数据库地址、
// 代理信任、来源名单、初始管理员、镜像。
//
// 以前只要求「大于 0」：`Infinity`、很大的数都能通过。保留天数填得很大时，清理用它算的截止时间早于数据库能表示的下限
// （约 247 万天起，清理的查询被数据库拒绝）或在控制面里就是无效的时间（约 1 亿天起）：启动正常、进程不退出，清理任务每分钟
// 报错然后悄悄不清理，日志、产物、指标永远不删，也没有任何地方告诉部署者这个值不合法。
//
// 每个变量一个合理的范围（常量在下面），别的由部署者设置的数字（程序里给 `startControlPlane` 的选项）按同一个范围检查
// （{@link numericOptionProblems}）。取值的范围和「不想清理怎么写」写在 deploy/.env.example、README 的部署部分和
// docs/ARCHITECTURE.md。
import { LOGIN_TOUCH_INTERVAL_MS } from "../auth/access-guard.js";
import { parseInitialAdmin } from "../auth/bootstrap.js";
import type { ControlPlaneOptions } from "../control-plane.js";
import { parseCorsOrigins } from "../http/cors.js";
import { parseTrustProxy } from "../http/trust-proxy.js";
import { byteLimitBytesFromMb, byteLimitMessage, isByteLimit } from "./byte-limit.js";
import { DEFAULT_DATA_DIR, dataDirFromEnv } from "./data-dir.js";
import { decimalOf, isUnset } from "./decimal.js";
import { echoNumber } from "./echo.js";
import { DEFAULT_LISTEN_HOST, hostFromEnv } from "./host-setting.js";
import {
	databaseUrlFromEnv,
	gatewayUrlFrom,
	type HttpUrlRule,
	httpUrlFromEnv,
} from "./url-setting.js";

/**
 * 保留天数（日志和产物、指标）的上限：36500 天（100 年）。再大的值没有意义，写它就是「永不清理」：不支持专门的写法，
 * 要这个效果就填 36500。
 */
export const MAX_RETENTION_DAYS = 36_500;
/** 登录的空闲期限（小时）的上限：和保留天数同一个量级，100 年。 */
export const MAX_LOGIN_IDLE_HOURS = MAX_RETENTION_DAYS * 24;
/** TCP 端口的上限。 */
const MAX_PORT = 65_535;

const HOUR_MS = 3_600_000;

/** 保留天数合不合格：大于 0、不超过 {@link MAX_RETENTION_DAYS} 的有限的数。 */
export const isRetentionDays = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_RETENTION_DAYS;

/** 填的不是（有限的）数时补的一句：只写数字，单位在变量名里说了，不要带。 */
const numbersOnly = (unit: string, example: string): string =>
	`。只写数字，单位是${unit}（写 ${example}，不要带单位，也不要写 Infinity）`;

/**
 * 保留天数不合格的说明；`source` 是它的来源（环境变量名、选项名），`actual` 是写的值，`notANumber` 是填的不是
 * （有限的）数：这时补一句只写数字、单位是天。
 */
export const retentionDaysMessage = (source: string, actual: unknown, notANumber = false): string =>
	`${source} 不合法：保留天数必须是大于 0、不超过 ${MAX_RETENTION_DAYS} 的数（天），实际是 ${String(actual)}${notANumber ? numbersOnly("天", "30") : ""}。不想清理就填 ${MAX_RETENTION_DAYS}（约 100 年）`;

/**
 * 登录的空闲期限（毫秒）的下限：登录续期间隔（{@link LOGIN_TOUCH_INTERVAL_MS}）的两倍，现在是 2 分钟。
 * 登录的空闲期限只在「距上次续期满续期间隔之后的请求」里顺延，期限比续期间隔短，一直在用的登录也会过期
 * （30 秒的期限：第 20 秒用一次，第 40 秒已经 401）；两倍，隔着不到一个续期间隔发一次请求的登录就一直不会过期。
 * 期限小于 1 秒时下发的 Cookie 是 `Max-Age=0`，浏览器立刻删掉，谁都登录不了，日志里还没有提示。
 */
export const MIN_LOGIN_IDLE_MS = 2 * LOGIN_TOUCH_INTERVAL_MS;

/** 登录的空闲期限（毫秒）合不合格：{@link MIN_LOGIN_IDLE_MS} 到 {@link MAX_LOGIN_IDLE_HOURS} 小时之间的整数。 */
export const isLoginIdleMs = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isInteger(value) &&
	value >= MIN_LOGIN_IDLE_MS &&
	value <= MAX_LOGIN_IDLE_HOURS * HOUR_MS;

/** 登录的空闲期限的范围，和为什么有下限（写进两种单位的说明里）。 */
const LOGIN_IDLE_RANGE = `${MIN_LOGIN_IDLE_MS / 60_000} 分钟到 ${MAX_LOGIN_IDLE_HOURS} 小时`;
/** 下限换算成小时、向上取到 4 位小数的写法（2 分钟是 0.0334）：说明里「写 … 或更大」用它，不写死。 */
const MIN_LOGIN_IDLE_HOURS_TEXT = String(
	Math.ceil((MIN_LOGIN_IDLE_MS / HOUR_MS) * 10_000) / 10_000,
);
const LOGIN_IDLE_WHY = `下限是登录续期间隔（${LOGIN_TOUCH_INTERVAL_MS / 1000} 秒）的两倍：续期只在距上次续期满这么久之后的请求里做，期限比这短，一直在用的登录也会过期`;

/** 环境变量（单位是小时）里登录的空闲期限不合格的说明；`notANumber` 同 {@link retentionDaysMessage}。 */
export const loginIdleHoursMessage = (
	source: string,
	actual: unknown,
	notANumber = false,
): string =>
	`${source} 不合法：登录的空闲期限必须是 ${LOGIN_IDLE_RANGE}之间的数（单位是小时，可以带小数；${MIN_LOGIN_IDLE_MS / 60_000} 分钟换算成小时要写 ${MIN_LOGIN_IDLE_HOURS_TEXT} 或更大），实际是 ${String(actual)}${notANumber ? numbersOnly("小时", "12") : ""}。${LOGIN_IDLE_WHY}`;

/** 程序选项（单位是毫秒）里登录的空闲期限不合格的说明。 */
export const loginIdleMsMessage = (source: string, actual: unknown): string =>
	`${source} 不合法：登录的空闲期限必须是 ${MIN_LOGIN_IDLE_MS} 到 ${MAX_LOGIN_IDLE_HOURS * HOUR_MS} 毫秒之间的整数（${LOGIN_IDLE_RANGE}），实际是 ${String(actual)}。${LOGIN_IDLE_WHY}`;

/** 端口合不合格：0 到 65535 之间的整数（0 是让系统选一个空闲端口）。 */
const isPort = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_PORT;

const portMessage = (source: string, actual: unknown): string =>
	`${source} 不合法：端口必须是 0 到 ${MAX_PORT} 之间的整数（0 是让系统选一个空闲端口），只认不带符号的十进制整数（不要写 +8080、8080.0、1e3、0x1F90），实际是 ${String(actual)}`;

/** 把环境变量 `name` 的原文（天，可以带小数）变成保留天数；没设置时是 undefined（用默认值）。 */
function retentionDaysFromEnv(name: string, raw: string | undefined): number | undefined {
	if (isUnset(raw)) return undefined;
	const days = decimalOf(raw);
	if (!isRetentionDays(days)) {
		throw new Error(retentionDaysMessage(name, echoNumber(raw), !Number.isFinite(days)));
	}
	return days;
}

/** 把环境变量 `name` 的原文（小时，可以带小数）变成毫秒；没设置时是 undefined（用默认值）。 */
function loginIdleMsFromEnv(name: string, raw: string | undefined): number | undefined {
	if (isUnset(raw)) return undefined;
	const hours = decimalOf(raw);
	// 按最近的毫秒算：小时的小数乘 3600000 有浮点误差（0.29 小时乘出来是 1043999.9999999999），向下取整会少 1 毫秒；
	// 2 分钟是 1/30 小时，写成 0.0333333333333333（四舍五入过的）时向下取整是 119999 毫秒，差 1 毫秒不够下限。
	const ms = Math.round(hours * HOUR_MS);
	if (!isLoginIdleMs(ms)) {
		throw new Error(loginIdleHoursMessage(name, echoNumber(raw), !Number.isFinite(hours)));
	}
	return ms;
}

/** 把环境变量 `name` 的原文变成端口；没设置时用 `fallback`。 */
function portFromEnv(name: string, raw: string | undefined, fallback: number): number {
	if (isUnset(raw)) return fallback;
	// 端口只认数字（不认 `1e3`、`0x1F90`）。
	const port = /^\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN;
	if (!isPort(port)) throw new Error(portMessage(name, echoNumber(raw)));
	return port;
}

/** 对外地址（HTTP）：写进 Agent 的配置、通知卡片的链接，后面拼路径。 */
const PUBLIC_URL_RULE: HttpUrlRule = {
	requirement:
		"要写成带协议和主机的 http 或 https 地址（例如 https://sfly.example.com，不带用户名密码、? 和 #）",
	strict: true,
};
/** Agent 网关（gRPC）的对外地址：主机加端口。 */
const PUBLIC_GRPC_URL_RULE: HttpUrlRule = {
	requirement:
		"要写成带协议和主机的 http 或 https 地址（例如 http://sfly.example.com:50051，不带路径、用户名密码、? 和 #）",
	strict: true,
	noPath: true,
};
/**
 * PyPI 镜像：下发给 Agent 的 uv（`--default-index`）用，可以带用户名和密码；uv 认的 `file://` 和绝对路径也认（内网、离线的
 * 部署用共享目录做镜像）。
 */
const PYPI_MIRROR_RULE: HttpUrlRule = {
	requirement:
		"要写成 http 或 https 地址（例如 https://mirrors.ustc.edu.cn/pypi/simple），或者 file:// 地址、绝对路径（本地目录，例如 file:///mnt/mirror/pypi/simple）",
	strict: false,
	allowFile: true,
	allowAbsolutePath: true,
};
/**
 * GitHub Release 镜像：下发给 Agent 安装 uv（curl 下载安装脚本）、下载 Python（uv 的 `UV_PYTHON_INSTALL_MIRROR`）用，
 * 可以带用户名和密码；两者都认 `file://`（本地目录）。裸的绝对路径 curl 不认（要写成 `file:///…`），所以这里不认它。
 */
const GITHUB_MIRROR_RULE: HttpUrlRule = {
	requirement:
		"要写成 http 或 https 地址（例如 https://mirrors.ustc.edu.cn/github-release），或者 file:// 地址（本地目录，例如 file:///mnt/mirror/github-release）",
	strict: false,
	allowFile: true,
};

/** 这一份检查读的字符串类环境变量（报错回显的测试按它逐个检查，新加的变量要进这张清单，也要进测试里的表）。 */
export const STRING_ENV_NAMES = [
	"SFLY_DATA_DIR",
	"SFLY_HTTP_HOST",
	"SFLY_GRPC_HOST",
	"DATABASE_URL",
	"SFLY_TRUST_PROXY",
	"SFLY_CORS_ORIGINS",
	"SFLY_DEV_ORIGINS",
	"SFLY_ADMIN_LOGIN",
	"SFLY_ADMIN_PASSWORD",
	"SFLY_ADMIN_DISPLAY_NAME",
	"SFLY_PUBLIC_URL",
	"SFLY_PUBLIC_GRPC_URL",
	"SFLY_PYPI_MIRROR",
	"SFLY_GITHUB_RELEASE_MIRROR",
	"SFLY_AGENT_TOKEN",
] as const;
/** 这一份检查读的数字类环境变量。 */
export const NUMERIC_ENV_NAMES = [
	"SFLY_RETENTION_DAYS",
	"SFLY_METRIC_RETENTION_DAYS",
	"SFLY_LOG_LIMIT_MB",
	"SFLY_ARTIFACT_LIMIT_MB",
	"SFLY_METRIC_LIMIT_MB",
	"SFLY_LOGIN_IDLE_HOURS",
	"SFLY_HTTP_PORT",
	"SFLY_GRPC_PORT",
] as const;
type StringEnvName = (typeof STRING_ENV_NAMES)[number];

/** 环境变量换成、直接交给控制面的设置：键和类型取自 {@link ControlPlaneOptions}，键名写错、类型对不上编译不过。 */
type PassedSettingKey =
	| "dataDir"
	| "retentionDays"
	| "metricRetentionDays"
	| "logLimitBytes"
	| "artifactLimitBytes"
	| "metricLimitBytes"
	| "loginIdleMs"
	| "databaseUrl"
	| "trustProxy"
	| "corsOrigins"
	| "sameOrigins"
	| "initialAdmin"
	| "publicHttpUrl"
	| "publicGrpcUrl"
	| "pypiMirror"
	| "githubReleaseMirror"
	| "agentToken";

/**
 * 环境变量换成的设置；没设置的项是 undefined（用各自的默认值）。端口（`httpPort`、`grpcPort`）另外传（`main.ts` 把它们放进
 * `http`、`grpc` 选项里），其余的整个交给 `startControlPlane`（`...settings`，放在选项的最后：前面没有同名的项，后面也不能再有）。
 * 各项的含义见 {@link ControlPlaneOptions}；网关的对外地址（`publicGrpcUrl`）在端口是确定的（不是 0）时启动时就算好。
 */
export type EnvSettings = { [K in PassedSettingKey]: ControlPlaneOptions[K] } & {
	httpPort: number;
	grpcPort: number;
	/** 监听地址（`SFLY_HTTP_HOST`、`SFLY_GRPC_HOST`，#651）：和端口一起放进 `http`、`grpc` 选项。 */
	httpHost: string;
	grpcHost: string;
};

/**
 * 读设置时发现的问题：每个不合法的一条，写明变量名（或选项名）、填的值和允许的范围。`subject` 是它说的东西：
 * 环境变量（`main.ts` 读的），或者程序里直接给 `startControlPlane` 的选项。
 */
export class EnvSettingsError extends Error {
	constructor(
		readonly problems: readonly string[],
		subject: "环境变量" | "选项" | "启动检查" = "环境变量",
	) {
		super(
			problems.length === 1
				? (problems[0] as string)
				: `${problems.length} 个${subject === "启动检查" ? "启动检查没通过" : `${subject}不合法`}：\n${problems.map((p) => `  - ${p}`).join("\n")}`,
		);
		this.name = "EnvSettingsError";
	}
}

/** 共享令牌（`SFLY_AGENT_TOKEN`）最短几个字符（#494）。 */
export const AGENT_TOKEN_MIN_LENGTH = 32;

/**
 * 共享令牌（`SFLY_AGENT_TOKEN`）：库里存的是不加盐的 SHA-256，对随机串够用，对人设的弱口令不够（拿到备份就能离线猜）。
 * 短于 {@link AGENT_TOKEN_MIN_LENGTH} 个字符的不启动，写明怎么生成（#494）；不回显填的值。空的是没配。
 */
export function agentTokenFromEnv(value: string | undefined): string | undefined {
	if (value === undefined || value === "") return undefined;
	if ([...value].length < AGENT_TOKEN_MIN_LENGTH) {
		throw new Error(
			`SFLY_AGENT_TOKEN（Agent 共享令牌）太短：至少 ${AGENT_TOKEN_MIN_LENGTH} 个字符（库里存的是不加盐的 SHA-256，短的令牌拿到备份就能猜出来）；` +
				"用 `openssl rand -hex 32` 生成一个，换掉之后用旧令牌连接的 Agent 要一起换（更好的做法是给每台 Agent 签发自己的 Agent 凭据）",
		);
	}
	return value;
}

/**
 * 控制面读的数值类和字符串类环境变量，换成设置。每一项都检查：数值有限、在有意义的范围里，字符串写得合规矩；
 * 不合法的全部收集起来，一次报完（{@link EnvSettingsError}），部署者不用改一个、重启、再看下一个。
 * 只检查写法，不访问网络，也不碰文件系统，**除了一处**：数据库地址交给连接库解析（`databaseUrlFromEnv`），它解析时会读 `sslcert`、
 * `sslkey`、`sslrootcert` 指的文件（连接时读的是同一回事，读不到就是解析不了）。连得上数据库、数据目录能不能写、助手服务的地址和密钥、
 * 工作台 Agent 的名字都不在这里：见 docs/ARCHITECTURE.md「启动时检查哪些环境变量」。
 */
export function readEnvSettings(env: Readonly<Record<string, string | undefined>>): EnvSettings {
	const problems: string[] = [];
	const read = <T>(read: () => T, fallback: T): T => {
		try {
			return read();
		} catch (error) {
			problems.push(error instanceof Error ? error.message : String(error));
			return fallback;
		}
	};
	/** 读字符串类变量只经过它：变量名要在 {@link STRING_ENV_NAMES} 里（新加的变量要进这张清单，也要进回显测试里的表）。 */
	const text = (name: StringEnvName): string | undefined => env[name];
	// 先读端口和对外地址：网关的对外地址要用它们算。
	const grpcPort = read(() => portFromEnv("SFLY_GRPC_PORT", env.SFLY_GRPC_PORT, 50051), 50051);
	const publicHttpUrl = read(
		() => httpUrlFromEnv("SFLY_PUBLIC_URL", text("SFLY_PUBLIC_URL"), PUBLIC_URL_RULE),
		undefined,
	);
	const publicGrpcUrl =
		read(
			() =>
				httpUrlFromEnv("SFLY_PUBLIC_GRPC_URL", text("SFLY_PUBLIC_GRPC_URL"), PUBLIC_GRPC_URL_RULE),
			undefined,
		) ??
		(publicHttpUrl !== undefined && grpcPort !== 0
			? gatewayUrlFrom(publicHttpUrl, grpcPort)
			: undefined);
	const settings: EnvSettings = {
		dataDir: read(() => dataDirFromEnv(text("SFLY_DATA_DIR")), DEFAULT_DATA_DIR),
		retentionDays: read(
			() => retentionDaysFromEnv("SFLY_RETENTION_DAYS", env.SFLY_RETENTION_DAYS),
			undefined,
		),
		metricRetentionDays: read(
			() => retentionDaysFromEnv("SFLY_METRIC_RETENTION_DAYS", env.SFLY_METRIC_RETENTION_DAYS),
			undefined,
		),
		logLimitBytes: read(
			() => byteLimitBytesFromMb("SFLY_LOG_LIMIT_MB", "单个任务日志的上限", env.SFLY_LOG_LIMIT_MB),
			undefined,
		),
		artifactLimitBytes: read(
			() =>
				byteLimitBytesFromMb(
					"SFLY_ARTIFACT_LIMIT_MB",
					"产物合计的上限",
					env.SFLY_ARTIFACT_LIMIT_MB,
				),
			undefined,
		),
		metricLimitBytes: read(
			() =>
				byteLimitBytesFromMb(
					"SFLY_METRIC_LIMIT_MB",
					"单个任务指标数据的上限",
					env.SFLY_METRIC_LIMIT_MB,
				),
			undefined,
		),
		loginIdleMs: read(
			() => loginIdleMsFromEnv("SFLY_LOGIN_IDLE_HOURS", env.SFLY_LOGIN_IDLE_HOURS),
			undefined,
		),
		httpPort: read(() => portFromEnv("SFLY_HTTP_PORT", env.SFLY_HTTP_PORT, 8080), 8080),
		httpHost: read(
			() => hostFromEnv("SFLY_HTTP_HOST", text("SFLY_HTTP_HOST"), "SFLY_HTTP_PORT"),
			DEFAULT_LISTEN_HOST,
		),
		grpcHost: read(
			() => hostFromEnv("SFLY_GRPC_HOST", text("SFLY_GRPC_HOST"), "SFLY_GRPC_PORT"),
			DEFAULT_LISTEN_HOST,
		),
		grpcPort,
		databaseUrl: read(
			() => databaseUrlFromEnv(text("DATABASE_URL")),
			databaseUrlFromEnv(undefined),
		),
		trustProxy: read(() => parseTrustProxy(text("SFLY_TRUST_PROXY")), false),
		corsOrigins: read(() => parseCorsOrigins(text("SFLY_CORS_ORIGINS")), undefined),
		sameOrigins: read(
			() => parseCorsOrigins(text("SFLY_DEV_ORIGINS"), "SFLY_DEV_ORIGINS"),
			undefined,
		),
		initialAdmin: read(() => parseInitialAdmin(env), undefined),
		publicHttpUrl,
		publicGrpcUrl,
		pypiMirror: read(
			() => httpUrlFromEnv("SFLY_PYPI_MIRROR", text("SFLY_PYPI_MIRROR"), PYPI_MIRROR_RULE),
			undefined,
		),
		githubReleaseMirror: read(
			() =>
				httpUrlFromEnv(
					"SFLY_GITHUB_RELEASE_MIRROR",
					text("SFLY_GITHUB_RELEASE_MIRROR"),
					GITHUB_MIRROR_RULE,
				),
			undefined,
		),
		agentToken: read(() => agentTokenFromEnv(text("SFLY_AGENT_TOKEN")), undefined),
	};
	if (problems.length > 0) throw new EnvSettingsError(problems);
	return settings;
}

/**
 * 程序里直接给 `startControlPlane` 的数值选项（测试、嵌入控制面时）按和环境变量同一个范围检查：不合法的写明选项名、
 * 实际的值和范围。没给的项不检查（用默认值）。
 */
export function numericOptionProblems(options: {
	retentionDays?: number | undefined;
	metricRetentionDays?: number | undefined;
	logLimitBytes?: number | undefined;
	artifactLimitBytes?: number | undefined;
	metricLimitBytes?: number | undefined;
	loginIdleMs?: number | undefined;
}): string[] {
	const problems: string[] = [];
	const check = (
		value: number | undefined,
		ok: (v: unknown) => boolean,
		message: (source: string, actual: unknown) => string,
		source: string,
	) => {
		if (value !== undefined && !ok(value)) problems.push(message(source, value));
	};
	check(options.retentionDays, isRetentionDays, retentionDaysMessage, "retentionDays");
	check(options.metricRetentionDays, isRetentionDays, retentionDaysMessage, "metricRetentionDays");
	check(options.loginIdleMs, isLoginIdleMs, loginIdleMsMessage, "loginIdleMs");
	for (const [name, what, value] of [
		["logLimitBytes", "单个任务日志的上限", options.logLimitBytes],
		["artifactLimitBytes", "产物合计的上限", options.artifactLimitBytes],
		["metricLimitBytes", "单个任务指标数据的上限", options.metricLimitBytes],
	] as const) {
		check(value, isByteLimit, (source, actual) => byteLimitMessage(source, what, actual), name);
	}
	return problems;
}
