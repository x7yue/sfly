import type { ExposedAgent, WorkbenchExposure as Exposure } from "@sfly/schema";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { agentEndpoint } from "../agents/agent-endpoint.js";
import type { AgentConnection, AgentHub } from "../agents/agent-hub.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { agents, projects } from "../db/schema.js";
import type { ProjectId } from "../projects/project-id.js";

/** 同一台工作台多久重探一次（换了连接、换了登记的工作台时下一轮就探）。 */
export const EXPOSURE_RECHECK_MS = 10 * 60 * 1000;
/** 一次请求至多多少个目标（firewall.py 的 PROBE_MAX_TARGETS，scripts/tests 核对两边一致）。 */
export const PROBE_BATCH = 1_000;
/** 每个目标的连接期限（firewall.py 的 PROBE_TIMEOUT_SECONDS），用来算一次请求等多久。 */
const PROBE_TIMEOUT_MS = 3_000;

/** 一个目标的结果：连上了、连不通（被拒、超时、不可达）、没测成。 */
export type ProbeResult = "open" | "closed" | "error";
/** 请 `address`（部署者配置的探测服务，`主机:端口`）试连接这些目标，结果同序；整次没测成时抛错。 */
export type WorkbenchProbe = (address: string, targets: string[]) => Promise<ProbeResult[]>;

/** 能力端口的地址 `主机:端口`（IPv6 写成 `[地址]:端口`）；没有上报端口或地址时为 undefined。 */
export function capabilityAddress(conn: AgentConnection): string | undefined {
	const endpoint = agentEndpoint(conn.info);
	if (endpoint.port === null || endpoint.address === "") return undefined;
	const host = endpoint.address.includes(":") ? `[${endpoint.address}]` : endpoint.address;
	return `${host}:${endpoint.port}`;
}

/**
 * 请出网名单容器上的探测服务（`POST http://<配置的地址>/probe`）探测。地址是部署者写在控制面这一侧的（`SFLY_FIREWALL_PROBES`），
 * 不是 Agent 自报的：目标列表只发给部署者指定的地方。测量方是那个容器里的进程，工作台上的模型改不了、停不了它（firewall.py 开头）。
 * 连不上（没有出网名单的部署）、回应不是约定的形状时抛错。
 */
export const httpProbe: WorkbenchProbe = async (address, targets) => {
	const res = await fetch(`http://${address}/probe`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ targets }),
		// 不跟随重定向（抛错，算这一轮没测成）：目标列表只发到配置的地址，不能被转到别处。
		redirect: "error",
		// 32 个一批同时连，每批最多一个连接期限；再留 10 秒。
		signal: AbortSignal.timeout(Math.ceil(targets.length / 32) * PROBE_TIMEOUT_MS + 10_000),
	});
	if (!res.ok) throw new Error(`探测服务回了 ${res.status}`);
	const body: unknown = await res.json();
	const results = (body as { results?: unknown } | null)?.results;
	if (
		!Array.isArray(results) ||
		results.length !== targets.length ||
		!results.every((r) => r === "open" || r === "closed" || r === "error")
	) {
		throw new Error("探测服务的回应不是约定的形状");
	}
	return results as ProbeResult[];
};

/**
 * 按 {@link PROBE_BATCH} 分批探完全部目标；有一批没成就整轮没成（抛错），不把一部分当成整轮的结果。没有目标时也请求一次（空批）：
 * 探测服务连得上才算测成，「没有目标」不等于「探测服务能用」。
 */
export async function probeAll(
	probe: WorkbenchProbe,
	address: string,
	targets: string[],
): Promise<ProbeResult[]> {
	const results: ProbeResult[] = [];
	let start = 0;
	do {
		results.push(...(await probe(address, targets.slice(start, start + PROBE_BATCH))));
		start += PROBE_BATCH;
	} while (start < targets.length);
	return results;
}

/**
 * 工作台够得着的项目外 Agent（#498，ADR 0029「隔离做到哪一层」）：定期请每个项目登记的、在线的工作台对应的探测服务（部署者配置的）
 * 只试连接别的项目里在线 Agent 的能力端口，就绪状态里带上结果（助手页、会话页告警）。结果只在内存里，重启后下一轮重探。
 *
 * 结果属于它测的那条连接：探测回来时登记的工作台或它的连接变了，这次结果丢掉；读的时候不是当前连接的结果当作没有（null）。
 * 一轮整个没测成（没有配置探测地址、探测服务连不上、回应不对）时不发布新的结果：留着同一条连接上次测成的，记下这次没测成的时间和原因。
 * 没测成的目标只给个数（不列名字和地址：那是别的项目的 Agent）；连得通的才写明是哪台。
 */
export class WorkbenchExposure {
	readonly #results = new Map<
		ProjectId,
		{ name: string; conn: AgentConnection; at: number; exposure: Exposure }
	>();

	constructor(
		private readonly deps: {
			db: Db;
			hub: AgentHub;
			clock: Clock;
			/** 没有开助手时不探（工作台只给助手用）。 */
			enabled: boolean;
			/** 工作台的 Agent 名 → 探测服务的地址（`SFLY_FIREWALL_PROBES`）。 */
			probes: ReadonlyMap<string, string>;
			probe: WorkbenchProbe;
			log: (message: string, error: unknown) => void;
		},
	) {}

	/** 登记的工作台 `name` 当前的连接 `conn` 上的结果；不是这条连接测的、还没有结果时为 null。 */
	get(
		project: ProjectId,
		name: string | undefined,
		conn: AgentConnection | undefined,
	): Exposure | null {
		const result = this.#results.get(project);
		return result && result.name === name && result.conn === conn ? result.exposure : null;
	}

	/** 探一轮：到期的（没探过、工作台换了连接、上次探过超过 {@link EXPOSURE_RECHECK_MS}）才探。 */
	async sweep(): Promise<void> {
		const { db, hub, clock } = this.deps;
		if (!this.deps.enabled) return;
		const rows = await db
			.select({ id: projects.id, workbench: projects.workbenchAgent })
			.from(projects)
			.where(isNotNull(projects.workbenchAgent));
		for (const row of rows) {
			const project = row.id as ProjectId;
			const name = row.workbench as string;
			const conn = hub.connection(name);
			if (!conn) {
				this.#results.delete(project);
				continue;
			}
			const last = this.#results.get(project);
			const same = last?.name === name && last.conn === conn ? last : undefined;
			const now = clock.now();
			if (same && now.getTime() - same.at < EXPOSURE_RECHECK_MS) continue;
			const exposure = await this.#measure(name, project, now, same?.exposure);
			// 探测期间换了登记、换了连接、下线了：这次的结果不是现在这台的，丢掉。
			const [current] = await db
				.select({ workbench: projects.workbenchAgent })
				.from(projects)
				.where(eq(projects.id, project));
			if (current?.workbench !== name || hub.connection(name) !== conn) continue;
			this.#results.set(project, { name, conn, at: now.getTime(), exposure });
		}
	}

	async #measure(
		name: string,
		project: ProjectId,
		now: Date,
		last: Exposure | undefined,
	): Promise<Exposure> {
		const failed = (failure: "no_probe" | "probe_failed"): Exposure => ({
			...(last ?? { checked_at: null, agents: [], unmeasured: 0 }),
			failed_at: now.toISOString(),
			failure,
		});
		const address = this.deps.probes.get(name);
		if (address === undefined) return failed("no_probe");
		const targets = await this.#targets(project);
		try {
			const results = await probeAll(
				this.deps.probe,
				address,
				targets.map((t) => t.address),
			);
			return {
				checked_at: now.toISOString(),
				agents: targets.filter((_, i) => results[i] === "open"),
				unmeasured: results.filter((r) => r === "error").length,
				failed_at: null,
				failure: null,
			};
		} catch (error) {
			this.deps.log(`工作台 ${name} 这一轮没有测成项目外 Agent 的能力端口`, error);
			return failed("probe_failed");
		}
	}

	/** 别的项目里在线、上报了能力端口的 Agent。 */
	async #targets(project: ProjectId): Promise<ExposedAgent[]> {
		const rows = await this.deps.db
			.select({ name: agents.name })
			.from(agents)
			.where(and(ne(agents.projectId, project), eq(agents.status, "online")));
		const targets: ExposedAgent[] = [];
		for (const { name } of rows) {
			const conn = this.deps.hub.connection(name);
			const address = conn && capabilityAddress(conn);
			if (address) targets.push({ agent: name, address });
		}
		return targets;
	}
}
