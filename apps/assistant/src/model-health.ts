import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { AssistantErrorCode, AssistantModelHealth, ErrorClass } from "@sfly/schema";
import { type Clock, realClock, type Timer } from "./clock.js";
import { checkModels, type ModelCheck, type ModelEndpoint } from "./models.js";

/**
 * 模型的就绪状态（#548）：配没配好（{@link checkModels}）和连不连得上（试连）。
 *
 * **试连只建连接（https 含 TLS 握手），不发请求、不调模型、不花钱**：评测集的 `aeval/session.py` 的 `check_endpoint` 是同一个做法，
 * 只看能不能连上，端点回什么状态码都算连得上（401 也是连得上：密钥对不对是调用时的事，那时按上游的错误分类）。
 * 启动时试一次，之后每 {@link MODEL_PROBE_INTERVAL_MS} 一次；**上一次连不上时改成每 {@link MODEL_PROBE_RETRY_MS} 复试一次，连上了再回到
 * 每 5 分钟**：上次试连连不上会挡住新的一轮（503），一次连接被重置不该挡五分钟。`/health` 报上一次试连的结果，不在请求里现连：
 * 控制面每几秒问一次 `/health`。
 */
export const MODEL_PROBE_INTERVAL_MS = 5 * 60 * 1000;

/** 上一次试连连不上时，多久之后复试。 */
export const MODEL_PROBE_RETRY_MS = 30 * 1000;

/** 一次试连最多等多久：和评测集一样 10 秒。 */
export const MODEL_PROBE_TIMEOUT_MS = 10_000;

export type ProbeResult = { ok: true } | { ok: false; errorClass: ErrorClass; cause: string };

/** 试连一个端点；测试里换成假的。 */
export type Probe = (endpoint: ModelEndpoint, signal: AbortSignal) => Promise<ProbeResult>;

/**
 * 连接层的失败怎么说、算哪一类：连不上（拒绝、域名解析不了、不可达、证书验不过）是 `unreachable`，超时是 `timeout`。
 * 只认 Node 的错误码；说法里没有主机、端口、错误原文。
 */
const CAUSES: Record<string, { errorClass: ErrorClass; cause: string }> = {
	ECONNREFUSED: { errorClass: "unreachable", cause: "连接被拒绝" },
	ECONNRESET: { errorClass: "unreachable", cause: "连接被重置" },
	ENOTFOUND: { errorClass: "unreachable", cause: "域名解析不了" },
	EAI_AGAIN: { errorClass: "unreachable", cause: "域名解析不了" },
	EHOSTUNREACH: { errorClass: "unreachable", cause: "主机不可达" },
	ENETUNREACH: { errorClass: "unreachable", cause: "网络不可达" },
	EPIPE: { errorClass: "unreachable", cause: "连接被断开" },
	ETIMEDOUT: { errorClass: "timeout", cause: "连接超时" },
	UNABLE_TO_VERIFY_LEAF_SIGNATURE: { errorClass: "unreachable", cause: "证书验不过" },
	UNABLE_TO_GET_ISSUER_CERT_LOCALLY: { errorClass: "unreachable", cause: "证书验不过" },
	SELF_SIGNED_CERT_IN_CHAIN: { errorClass: "unreachable", cause: "证书验不过" },
	DEPTH_ZERO_SELF_SIGNED_CERT: { errorClass: "unreachable", cause: "证书验不过" },
	CERT_HAS_EXPIRED: { errorClass: "unreachable", cause: "证书已过期" },
	ERR_TLS_CERT_ALTNAME_INVALID: { errorClass: "unreachable", cause: "证书和主机名对不上" },
};

/** 真的试连：`net.connect`，https 用 `tls.connect`（握手完成才算连上，证书照默认规则验）。 */
export function connectProbe(timeoutMs = MODEL_PROBE_TIMEOUT_MS): Probe {
	return (endpoint, signal) =>
		new Promise<ProbeResult>((resolve) => {
			const options = { host: endpoint.host, port: endpoint.port, signal };
			const socket = endpoint.tls
				? tlsConnect({ ...options, servername: isIp(endpoint.host) ? undefined : endpoint.host })
				: netConnect(options);
			let settled = false;
			const settle = (result: ProbeResult) => {
				if (settled) return;
				settled = true;
				socket.destroy();
				resolve(result);
			};
			socket.setTimeout(timeoutMs, () =>
				settle({ ok: false, errorClass: "timeout", cause: "连接超时" }),
			);
			socket.once(endpoint.tls ? "secureConnect" : "connect", () => settle({ ok: true }));
			socket.once("error", (error: NodeJS.ErrnoException) => {
				const known = CAUSES[error.code ?? ""];
				settle({
					ok: false,
					errorClass: known?.errorClass ?? "unreachable",
					cause: known?.cause ?? "连接出错",
				});
			});
			// 握手前对端就关了连接（不是 TLS 服务、被防火墙掐掉）：没有错误码，也是连不上。
			socket.once("close", () => {
				settle({ ok: false, errorClass: "unreachable", cause: "连接被断开" });
			});
		});
}

const isIp = (host: string) => /^[\d.]+$/.test(host) || host.includes(":");

/** 起不了新的一轮的原因（回给控制面的 503）。 */
export interface ModelGate {
	status: 503;
	code: Extract<AssistantErrorCode, "model_not_configured" | "model_unreachable">;
	message: string;
}

export interface ModelHealthOptions {
	modelsFile: string;
	model: string | undefined;
	env: NodeJS.ProcessEnv;
	/** 计时（测试里换成手动推进的时钟）。 */
	clock?: Clock;
	probe?: Probe;
	intervalMs?: number;
	/** 连不上时复试的间隔，默认 {@link MODEL_PROBE_RETRY_MS}。 */
	retryMs?: number;
	log: (message: string) => void;
}

interface Probed {
	/** 试的是哪个端点（模型文件改了端点，之前的结果就不算）。 */
	key: string;
	at: number;
	result: ProbeResult;
}

const keyOf = (endpoint: ModelEndpoint) =>
	`${endpoint.tls ? "https" : "http"}://${endpoint.host}:${endpoint.port}`;
const addressOf = (endpoint: ModelEndpoint) =>
	`${endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host}:${endpoint.port}`;

export class ModelHealth {
	readonly #clock: Clock;
	readonly #probe: Probe;
	readonly #interval: number;
	readonly #retry: number;
	#timer: Timer | undefined;
	#probed: Probed | undefined;
	#probing: string | undefined;
	#abort = new AbortController();
	#closed = false;

	constructor(private readonly options: ModelHealthOptions) {
		this.#clock = options.clock ?? realClock;
		this.#probe = options.probe ?? connectProbe();
		this.#interval = options.intervalMs ?? MODEL_PROBE_INTERVAL_MS;
		this.#retry = options.retryMs ?? MODEL_PROBE_RETRY_MS;
	}

	/** 现在的配置检查（每次重新读模型文件）。 */
	#check(): ModelCheck {
		return checkModels({
			modelsFile: this.options.modelsFile,
			model: this.options.model,
			env: this.options.env,
		});
	}

	/**
	 * 启动：试一次，之后每 5 分钟一次（连不上时每 30 秒一次，直到连上）。每次试完才排下一次：没配好或不知道端点时也排上，
	 * 文件修好之后下一次就试。
	 */
	start(): void {
		const check = this.#check();
		if (!check.configured) {
			this.options.log(`模型没有配置：${check.reason}`);
		}
		void this.#probeNow();
	}

	/** 排下一次试连（换掉已经排着的）。 */
	#schedule(delayMs: number): void {
		if (this.#closed) return;
		this.#clock.clearTimeout(this.#timer);
		this.#timer = this.#clock.setTimeout(() => void this.#probeNow(), delayMs);
	}

	/** 关闭：清掉定时器，正在试的连接断开，之后的结果不再记。 */
	close(): void {
		this.#closed = true;
		this.#clock.clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#abort.abort();
	}

	async #probeNow(): Promise<void> {
		const check = this.#check();
		if (!check.configured || check.endpoint === null) {
			this.#schedule(this.#interval);
			return;
		}
		const { endpoint } = check;
		const key = keyOf(endpoint);
		if (this.#probing === key) return;
		this.#probing = key;
		let result: ProbeResult;
		try {
			result = await this.#probe(endpoint, this.#abort.signal);
		} catch {
			result = { ok: false, errorClass: "unreachable", cause: "连接出错" };
		}
		if (this.#probing === key) this.#probing = undefined;
		if (this.#closed) return;
		this.#probed = { key, at: this.#clock.now(), result };
		this.#schedule(result.ok ? this.#interval : this.#retry);
		if (!result.ok) {
			this.options.log(`连不上模型端点 ${addressOf(endpoint)}：${result.cause}`);
		}
	}

	/** `GET /health` 的 `model`。 */
	snapshot(): AssistantModelHealth {
		const check = this.#check();
		if (!check.configured) {
			return {
				configured: false,
				endpoint: null,
				reachable: null,
				checked_at: null,
				reason: check.reason,
				error_class: null,
			};
		}
		const { endpoint } = check;
		if (endpoint === null) {
			return {
				configured: true,
				endpoint: null,
				reachable: null,
				checked_at: null,
				reason: null,
				error_class: null,
			};
		}
		const shown = { host: endpoint.host, port: endpoint.port };
		const probed = this.#probed?.key === keyOf(endpoint) ? this.#probed : undefined;
		if (!probed) {
			// 模型文件改了端点（或还没试过）：先不下结论，马上试一次。
			if (!this.#closed) void this.#probeNow();
			return {
				configured: true,
				endpoint: shown,
				reachable: null,
				checked_at: null,
				reason: null,
				error_class: null,
			};
		}
		const checkedAt = new Date(probed.at).toISOString();
		if (probed.result.ok) {
			return {
				configured: true,
				endpoint: shown,
				reachable: true,
				checked_at: checkedAt,
				reason: null,
				error_class: null,
			};
		}
		return {
			configured: true,
			endpoint: shown,
			reachable: false,
			checked_at: checkedAt,
			reason: `连不上模型端点 ${addressOf(endpoint)}：${probed.result.cause}`,
			error_class: probed.result.errorClass,
		};
	}

	/**
	 * 新的一轮能不能开始：没有配置、或者上次试连连不上时返回 503 的原因，否则 undefined。还没试过、不知道端点（用 pi 内置提供方）
	 * 时放行：没有证据说不行，真有问题时这一轮以 `model_unavailable` 结束，页面上有原因。
	 */
	gate(): ModelGate | undefined {
		const health = this.snapshot();
		if (!health.configured) {
			return {
				status: 503,
				code: "model_not_configured",
				message: health.reason ?? "没有配置模型",
			};
		}
		if (health.reachable === false) {
			return {
				status: 503,
				code: "model_unreachable",
				message: health.reason ?? "连不上模型端点",
			};
		}
		return undefined;
	}
}
