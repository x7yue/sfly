import type {
	AgentMessage,
	Capability,
	DevPackage,
	Hello,
	InstalledPackage,
	MetricBatch,
	MetricPoint,
	PeerEndpoint,
} from "@sfly/proto";

const NUL = "\u0000";
const REPLACEMENT = "\uFFFD";
/** JSON 文本里 NUL 的写法（JSON 不允许原样的控制字符）。 */
const ESCAPED_NUL = "\\u0000";

/**
 * Agent 上报的字符串里的 NUL（U+0000）换成 U+FFFD（#207，docs/SEMANTICS.md §2.5）。
 *
 * PostgreSQL 的 text 和 jsonb 都存不下 NUL，写库会报错。网关在把 Agent 的消息（握手的 Hello 和之后的每一条）
 * 交给控制面的其他部分之前统一在这里处理，之后写库的地方不用再管 NUL。逐类说明：
 *
 * | 消息 | 处理的字段 | 写到哪里 |
 * |---|---|---|
 * | Hello | name、agent_version、os、arch、已安装节点包、开发版节点包、能力名、对外地址与监听失败的原因 | agents.name、agents.info |
 * | Heartbeat | 更新状态的 reason | agents.info |
 * | TaskResult | outputs_json（键和值）、错误信息 | tasks.outputs、tasks.error_message |
 * | Progress | 进度说明 | tasks.progress |
 * | InstallStatus | 节点包名、版本、已安装节点包、开发版节点包 | agents.info |
 * | MetricBatch | 指标名、标签键、标签值 | metric_series、metric_segments |
 * | Notification | event_json（键和值） | feishu_messages |
 *
 * 不处理的：
 * - LogBatch：日志写在日志文件里（每行一个 JSON，NUL 转义为 `\u0000`），不进数据库，原样保存。
 * - 任务 ID：只用来查找（含 NUL 时不是合法的 UUID，按不存在的任务处理）。
 * - Hello.token：只用来比对，不保存。InstallStatus.output：不保存。
 *
 * `*_json` 字段（TaskResult.outputs_json、DevPackage.metadata_json、Notification.event_json）是 JSON 文本，NUL 在里面写作转义 `\u0000`：
 * 含这个转义时解析出来，把键和值里的 NUL 换掉后重新序列化；不是合法 JSON 的原样留给使用方按原来的规则处理。
 *
 * 只检查（`includes`），不含 NUL 的部分原样返回、不复制：日志批次直接返回，指标每个点只多检查名称和标签。
 */
export function storable(message: AgentMessage): AgentMessage {
	const body = storableBody(message.body);
	return body === message.body ? message : { ...message, body };
}

function storableBody(body: AgentMessage["body"]): AgentMessage["body"] {
	switch (body.case) {
		case "hello":
			return replaced(body, hello(body.value));
		case "heartbeat": {
			const { update } = body.value;
			if (!update) return body;
			const reason = text(update.reason);
			if (reason === update.reason) return body;
			return { ...body, value: { ...body.value, update: { ...update, reason } } };
		}
		case "result": {
			const result = body.value;
			const outputsJson = json(result.outputsJson);
			const message = result.error && text(result.error.message);
			if (outputsJson === result.outputsJson && message === result.error?.message) return body;
			const error =
				result.error && message !== undefined ? { ...result.error, message } : undefined;
			return { ...body, value: { ...result, outputsJson, error } };
		}
		case "progress": {
			const message = text(body.value.message);
			if (message === body.value.message) return body;
			return { ...body, value: { ...body.value, message } };
		}
		case "install": {
			const status = body.value;
			const pkg = text(status.package);
			const version = text(status.version);
			const installedPackages = list(status.installedPackages, installed);
			const devPackages = list(status.devPackages, devPackage);
			if (
				pkg === status.package &&
				version === status.version &&
				installedPackages === status.installedPackages &&
				devPackages === status.devPackages
			) {
				return body;
			}
			return {
				...body,
				value: { ...status, package: pkg, version, installedPackages, devPackages },
			};
		}
		case "metrics":
			return replaced(body, metrics(body.value));
		case "notification": {
			const eventJson = json(body.value.eventJson);
			if (eventJson === body.value.eventJson) return body;
			return { ...body, value: { ...body.value, eventJson } };
		}
		case "started":
		case "logs":
		case undefined:
			return body;
		default:
			return body satisfies never;
	}
}

function replaced<B extends { value: unknown }>(body: B, value: B["value"]): B {
	return value === body.value ? body : { ...body, value };
}

function hello(h: Hello): Hello {
	const name = text(h.name);
	const agentVersion = text(h.agentVersion);
	const os = text(h.os);
	const arch = text(h.arch);
	const installedPackages = list(h.installedPackages, installed);
	const devPackages = list(h.devPackages, devPackage);
	const capabilities = list(h.capabilities, capability);
	const peer = h.peer && peerEndpoint(h.peer);
	if (
		name === h.name &&
		agentVersion === h.agentVersion &&
		os === h.os &&
		arch === h.arch &&
		installedPackages === h.installedPackages &&
		devPackages === h.devPackages &&
		capabilities === h.capabilities &&
		peer === h.peer
	) {
		return h;
	}
	return {
		...h,
		name,
		agentVersion,
		os,
		arch,
		installedPackages,
		devPackages,
		capabilities,
		peer,
	};
}

function capability(c: Capability): Capability {
	const name = text(c.name);
	return name === c.name ? c : { ...c, name };
}

function peerEndpoint(p: PeerEndpoint): PeerEndpoint {
	const publicAddress = text(p.publicAddress);
	const listenError = text(p.listenError);
	return publicAddress === p.publicAddress && listenError === p.listenError
		? p
		: { ...p, publicAddress, listenError };
}

function installed(p: InstalledPackage): InstalledPackage {
	const name = text(p.name);
	const version = text(p.version);
	return name === p.name && version === p.version ? p : { ...p, name, version };
}

function devPackage(p: DevPackage): DevPackage {
	const name = text(p.name);
	const source = text(p.source);
	const metadataJson = json(p.metadataJson);
	return name === p.name && source === p.source && metadataJson === p.metadataJson
		? p
		: { ...p, name, source, metadataJson };
}

function metrics(batch: MetricBatch): MetricBatch {
	const points = list(batch.points, point);
	return points === batch.points ? batch : { ...batch, points };
}

function point(p: MetricPoint): MetricPoint {
	const name = text(p.name);
	const labels = labelMap(p.labels);
	return name === p.name && labels === p.labels ? p : { ...p, name, labels };
}

function labelMap(labels: Record<string, string>): Record<string, string> {
	for (const key in labels) {
		if (key.includes(NUL) || (labels[key] as string).includes(NUL)) {
			const copy: Record<string, string> = {};
			for (const k in labels) copy[text(k)] = text(labels[k] as string);
			return copy;
		}
	}
	return labels;
}

/** 每一项都没变时返回原数组。 */
function list<T>(items: T[], clean: (item: T) => T): T[] {
	for (let i = 0; i < items.length; i++) {
		const item = items[i] as T;
		const cleaned = clean(item);
		if (cleaned === item) continue;
		const copy = items.slice();
		copy[i] = cleaned;
		for (let j = i + 1; j < copy.length; j++) copy[j] = clean(copy[j] as T);
		return copy;
	}
	return items;
}

function text(s: string): string {
	return s.includes(NUL) ? s.replaceAll(NUL, REPLACEMENT) : s;
}

/** JSON 文本：含 NUL 的转义时解析、换掉键和值里的 NUL 后重新序列化；不是合法 JSON 时原样返回。 */
function json(s: string): string {
	if (!s.includes(ESCAPED_NUL)) return s;
	let value: unknown;
	try {
		value = JSON.parse(s);
	} catch {
		return s;
	}
	return JSON.stringify(jsonValue(value));
}

function jsonValue(value: unknown): unknown {
	if (typeof value === "string") return text(value);
	if (Array.isArray(value)) return value.map(jsonValue);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(value)) out[text(key)] = jsonValue(v);
		return out;
	}
	return value;
}
