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
/** 出网名单容器上探测服务的端口（`deploy/workbench/firewall.py` 的 PROBE_PORT）。 */
export const PROBE_PORT = 47124;
/** 一次请求至多多少个目标（firewall.py 的 PROBE_MAX_TARGETS，scripts/tests 核对两边一致）。 */
export const PROBE_BATCH = 1_000;
/** 每个目标的连接期限（firewall.py 的 PROBE_TIMEOUT_SECONDS），用来算一次请求等多久。 */
const PROBE_TIMEOUT_MS = 3_000;

/** 一个目标的结果：连上了、连不通（被拒、超时、不可达）、没测成。 */
export type ProbeResult = "open" | "closed" | "error";
/** 在工作台的网络命名空间里试连接这些目标（`主机:端口`），结果同序；整次没测成时抛错。 */
export type WorkbenchProbe = (host: string, targets: string[]) => Promise<ProbeResult[]>;

/** 能力端口的地址 `主机:端口`（IPv6 写成 `[地址]:端口`）；没有上报端口或地址时为 undefined。 */
export function capabilityAddress(conn: AgentConnection): string | undefined {
	const endpoint = agentEndpoint(conn.info);
	if (endpoint.port === null || endpoint.address === "") return undefined;
	const host = endpoint.address.includes(":") ? `[${endpoint.address}]` : endpoint.address;
	return `${host}:${endpoint.port}`;
}

/**
 * 请工作台前面的出网名单容器探测（`POST http://<工作台的主机>:47124/probe`）。测量方是那个容器里的进程，不是工作台上的 Agent：
 * 工作台上的模型改不了、停不了它（firewall.py 开头）。连不上（没有出网名单的部署）、回应不是约定的形状时抛错。
 */
export const httpProbe: WorkbenchProbe = async (host, targets) => {
	const base = host.includes(":") ? `[${host}]` : host;
	const res = await fetch(`http://${base}:${PROBE_PORT}/probe`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ targets }),
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

/** 按 {@link PROBE_BATCH} 分批探完全部目标；有一批没成就整轮没成（抛错），不把一部分当成整轮的结果。 */
export async function probeAll(
	probe: WorkbenchProbe,
	host: string,
	targets: string[],
): Promise<ProbeResult[]> {
	const results: ProbeResult[] = [];
	for (let start = 0; start < targets.length; start += PROBE_BATCH) {
		results.push(...(await probe(host, targets.slice(start, start + PROBE_BATCH))));
	}
	return results;
}

/**
 * 工作台够得着的项目外 Agent（#498，ADR 0029「隔离做到哪一层」）：定期请每个项目登记的、在线的工作台前面的出网名单容器
 * 只试连接别的项目里在线 Agent 的能力端口，就绪状态里带上结果（助手页、会话页告警）。结果只在内存里，重启后下一轮重探。
 * 一轮整个没测成（探测服务连不上、回应不对）时不发布新的结果：留着同一个连接上一次测成的结果，记下这次没测成的时间；
 * 工作台换了连接时旧的结果作废。没测成的目标单独列出，不算连不通。
 */
export class WorkbenchExposure {
	readonly #results = new Map<
		ProjectId,
		{ conn: AgentConnection; at: number; exposure: Exposure }
	>();

	constructor(
		private readonly deps: {
			db: Db;
			hub: AgentHub;
			clock: Clock;
			/** 没有开助手时不探（工作台只给助手用）。 */
			enabled: boolean;
			probe: WorkbenchProbe;
			log: (message: string, error: unknown) => void;
		},
	) {}

	get(project: ProjectId): Exposure | null {
		return this.#results.get(project)?.exposure ?? null;
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
			const conn = row.workbench ? hub.connection(row.workbench) : undefined;
			const host = conn && capabilityAddress(conn) && agentEndpoint(conn.info).address;
			let last = this.#results.get(project);
			if (!conn || !host) {
				this.#results.delete(project);
				continue;
			}
			if (last && last.conn !== conn) last = undefined;
			const now = clock.now();
			if (last && now.getTime() - last.at < EXPOSURE_RECHECK_MS) continue;
			const targets = await this.#targets(project);
			let exposure: Exposure;
			try {
				const results = await probeAll(
					this.deps.probe,
					host,
					targets.map((t) => t.address),
				);
				exposure = {
					checked_at: now.toISOString(),
					agents: targets.filter((_, i) => results[i] === "open"),
					unmeasured: targets.filter((_, i) => results[i] === "error"),
					failed_at: null,
				};
			} catch (error) {
				this.deps.log(`工作台 ${row.workbench} 这一轮没有测成项目外 Agent 的能力端口`, error);
				exposure = {
					...(last?.exposure ?? { checked_at: null, agents: [], unmeasured: [] }),
					failed_at: now.toISOString(),
				};
			}
			this.#results.set(project, { conn, at: now.getTime(), exposure });
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
