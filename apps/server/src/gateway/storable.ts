import type {
	ActionBatch,
	ActionEvent,
	ActionField,
	AgentMessage,
	Capability,
	DevPackage,
	Hello,
	InstalledPackage,
	MetricBatch,
	MetricPoint,
	PeerEndpoint,
} from "@sfly/proto";
import { escapeUnsafeCharacters, nameProblem } from "@sfly/schema";

// Agent 自报的文字怎么过表（逐个字段的归类、旧值怎么显示）：docs/SEMANTICS.md §2.5.1。

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
 * | TaskResult | outputs_json（键和值）、错误信息、出错位置 | tasks.outputs、tasks.error_message、tasks.error_location |
 * | Progress | 进度说明 | tasks.progress |
 * | InstallStatus | 节点包名、版本、已安装节点包、开发版节点包 | agents.info |
 * | MetricBatch | 指标名、标签键、标签值 | metric_series、metric_segments |
 * | Notification | event_json（键和值） | feishu_messages |
 * | ActionSummary | event_json（键和值） | task_action_summaries |
 * | ActionBatch | 名称、字段的键和值、失败原因 | task_actions |
 *
 * 不处理的：
 * - LogBatch：日志写在日志文件里（每行一个 JSON，NUL 转义为 `\u0000`），不进数据库，原样保存。
 * - 任务 ID：只用来查找（含 NUL 时不是合法的 UUID，按不存在的任务处理）。
 * - Hello.token：只用来比对，不保存。InstallStatus.output：不保存。
 *
 * `*_json` 字段（TaskResult.outputs_json、DevPackage.metadata_json、Notification.event_json、ActionSummary.event_json）是 JSON 文本，NUL 在里面写作转义 `\u0000`：
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
			// 更新失败的原因：长的自由文字（给人读的原因），和监听失败的原因同一类（docs/SEMANTICS.md §2.5.1）。
			const reason = freeText(text(update.reason));
			if (reason === update.reason) return body;
			return { ...body, value: { ...body.value, update: { ...update, reason } } };
		}
		case "result": {
			const result = body.value;
			const outputsJson = json(result.outputsJson);
			const message = result.error && text(result.error.message);
			const location = result.error && text(result.error.location);
			if (
				outputsJson === result.outputsJson &&
				message === result.error?.message &&
				location === result.error?.location
			) {
				return body;
			}
			const error =
				result.error && message !== undefined && location !== undefined
					? { ...result.error, message, location }
					: undefined;
			return { ...body, value: { ...result, outputsJson, error } };
		}
		case "progress": {
			const message = text(body.value.message);
			if (message === body.value.message) return body;
			return { ...body, value: { ...body.value, message } };
		}
		case "install": {
			const status = body.value;
			// 包名、版本、任务 ID：短的标识类（docs/SEMANTICS.md §2.5.1）。
			const pkg = shortId(text(status.package), SHORT_MAX.name);
			const version = shortId(text(status.version), SHORT_MAX.short);
			const taskId = shortId(text(status.taskId), SHORT_MAX.short);
			const installedPackages = list(status.installedPackages, installed);
			const devPackages = list(status.devPackages, devPackage);
			if (
				pkg === status.package &&
				version === status.version &&
				taskId === status.taskId &&
				installedPackages === status.installedPackages &&
				devPackages === status.devPackages
			) {
				return body;
			}
			return {
				...body,
				value: { ...status, package: pkg, version, taskId, installedPackages, devPackages },
			};
		}
		case "metrics":
			return replaced(body, metrics(body.value));
		case "notification":
			return replaced(body, eventJsonOf(body.value));
		case "actionSummary":
			return replaced(body, eventJsonOf(body.value));
		case "actions":
			return replaced(body, actionBatch(body.value));
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

/** 带 `event_json`（事件管道里那一行原文）的消息：Notification、ActionSummary。 */
function eventJsonOf<M extends { eventJson: string }>(message: M): M {
	const eventJson = json(message.eventJson);
	return eventJson === message.eventJson ? message : { ...message, eventJson };
}

/**
 * Agent 自己报的文字（#670）：只是显示用的附带信息，存下来之后会显示在别人的命令行和控制台里，所以写入时过一遍名字的那张表
 * （`@sfly/schema` 的 `nameProblem`），连接不因为这些字段失败（名称除外，由网关拒绝）。分两类：
 * - **短的标识类**（版本、系统、架构、包名、能力名、对外地址，应当是一个词的）：含表里的字符或超过上限的整段换成空串；
 * - **长的自由文字**（给人读的说明、原因：开发包的来源、对外监听失败的原因、开发包元信息里的字符串）：不整段丢，
 *   表里的字符写成看得见的 `\uXXXX`，超过上限的截断、末尾加「…」。
 * 逐个字段的归类见 docs/SEMANTICS.md §2.5.1。
 */
const SHORT_MAX = { short: 64, name: 128, address: 255 } as const;
/** 长的自由文字的长度上限（字符数）。 */
const FREE_TEXT_MAX = 2048;

function shortId(value: string, max: number): string {
	return [...value].length <= max && nameProblem(value) === undefined ? value : "";
}

function freeText(value: string): string {
	const chars = [...value];
	const clipped =
		chars.length > FREE_TEXT_MAX ? `${chars.slice(0, FREE_TEXT_MAX).join("")}…` : value;
	return escapeUnsafeCharacters(clipped);
}

/** 开发包元信息（JSON 文本）嵌套的层数上限：超过的整个按不合法处理（记成空），不递归到栈溢出、也不让连接因此连不上。 */
const METADATA_MAX_DEPTH = 64;

/** JSON 文本嵌套的层数（数括号，不递归；字符串里的括号不算）。 */
function jsonDepth(s: string): number {
	let depth = 0;
	let deepest = 0;
	let inString = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (inString) {
			if (c === "\\") i++;
			else if (c === '"') inString = false;
		} else if (c === '"') {
			inString = true;
		} else if (c === "{" || c === "[") {
			depth++;
			if (depth > deepest) deepest = depth;
		} else if (c === "}" || c === "]") {
			depth--;
		}
	}
	return deepest;
}

/**
 * 开发包元信息（JSON 文本）里的字符串（键和值）按长的自由文字处理：键或值任何一个变了都重新序列化（只有键有问题、
 * 值都正常时也算）；没有变化、不是合法 JSON 时原样返回；嵌套超过 {@link METADATA_MAX_DEPTH} 层的记成空。
 * `__proto__` 这样的键也原样留着（用 `Object.fromEntries` 建对象，写 `out[key]` 会把它当成原型丢掉）。
 */
function freeJson(s: string): string {
	if (s === "") return s;
	if (jsonDepth(s) > METADATA_MAX_DEPTH) return "";
	let value: unknown;
	try {
		value = JSON.parse(s);
	} catch {
		return s;
	}
	let changed = false;
	const walk = (v: unknown): unknown => {
		if (typeof v === "string") {
			const cleaned = freeText(v);
			if (cleaned !== v) changed = true;
			return cleaned;
		}
		if (Array.isArray(v)) return v.map(walk);
		if (v !== null && typeof v === "object") {
			return Object.fromEntries(
				Object.entries(v).map(([key, item]) => {
					const cleanedKey = freeText(key);
					if (cleanedKey !== key) changed = true;
					return [cleanedKey, walk(item)];
				}),
			);
		}
		return v;
	};
	const walked = walk(value);
	return changed ? JSON.stringify(walked) : s;
}

function hello(h: Hello): Hello {
	const name = text(h.name);
	const agentVersion = shortId(text(h.agentVersion), SHORT_MAX.short);
	const os = shortId(text(h.os), SHORT_MAX.short);
	const arch = shortId(text(h.arch), SHORT_MAX.short);
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
	const name = shortId(text(c.name), SHORT_MAX.short);
	return name === c.name ? c : { ...c, name };
}

function peerEndpoint(p: PeerEndpoint): PeerEndpoint {
	const publicAddress = shortId(text(p.publicAddress), SHORT_MAX.address);
	const listenError = freeText(text(p.listenError));
	return publicAddress === p.publicAddress && listenError === p.listenError
		? p
		: { ...p, publicAddress, listenError };
}

function installed(p: InstalledPackage): InstalledPackage {
	const name = shortId(text(p.name), SHORT_MAX.name);
	const version = shortId(text(p.version), SHORT_MAX.short);
	return name === p.name && version === p.version ? p : { ...p, name, version };
}

function devPackage(p: DevPackage): DevPackage {
	const name = shortId(text(p.name), SHORT_MAX.name);
	const source = freeText(text(p.source));
	// 嵌套太深的先记成空：后面的 json()（换掉转义的 NUL）和 freeJson 都要递归。
	const metadataJson =
		jsonDepth(p.metadataJson) > METADATA_MAX_DEPTH ? "" : freeJson(json(p.metadataJson));
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

function actionBatch(batch: ActionBatch): ActionBatch {
	const events = list(batch.events, actionEvent);
	return events === batch.events ? batch : { ...batch, events };
}

function actionEvent(e: ActionEvent): ActionEvent {
	const { kind } = e;
	switch (kind.case) {
		case "start": {
			const value = named(kind.value);
			return value === kind.value ? e : { ...e, kind: { case: "start", value } };
		}
		case "mark": {
			const value = named(kind.value);
			return value === kind.value ? e : { ...e, kind: { case: "mark", value } };
		}
		case "end": {
			const reason = kind.value.reason === undefined ? undefined : text(kind.value.reason);
			const fields = list(kind.value.fields, actionField);
			if (reason === kind.value.reason && fields === kind.value.fields) return e;
			return { ...e, kind: { case: "end", value: { ...kind.value, reason, fields } } };
		}
		case undefined:
			return e;
		default:
			return kind satisfies never;
	}
}

/** 动作开始、标记：名称和字段。 */
function named<V extends { name: string; fields: ActionField[] }>(v: V): V {
	const name = text(v.name);
	const fields = list(v.fields, actionField);
	return name === v.name && fields === v.fields ? v : { ...v, name, fields };
}

function actionField(f: ActionField): ActionField {
	const key = text(f.key);
	const value = text(f.value);
	return key === f.key && value === f.value ? f : { ...f, key, value };
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
