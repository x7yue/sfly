// Drizzle 表定义（唯一来源）。修改后运行 `pnpm --filter @sfly/server db:generate --name <描述>` 生成迁移。
// 表随各票据加入，见 docs/ARCHITECTURE.md §6.2。
import type { OrchestrationDocument, PackageMetadata } from "@sfly/schema";
import {
	bigint,
	bigserial,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** Agent 上报的信息（Hello）。 */
export interface AgentInfo {
	agent_version: string;
	os: string;
	arch: string;
	slots: number;
	/** 共享 venv 中已安装的节点包（#5）。 */
	installed_packages: InstalledPackage[];
}

export interface InstalledPackage {
	name: string;
	version: string;
}

export type AgentStatus = "online" | "offline";

/** Agent：按名称唯一；第一次 Hello 时注册，之后每次连接更新信息。 */
export const agents = pgTable("agents", {
	name: text("name").primaryKey(),
	info: jsonb("info").$type<AgentInfo>().notNull(),
	status: text("status").$type<AgentStatus>().notNull(),
	registeredAt: timestamptz("registered_at").notNull(),
	lastSeenAt: timestamptz("last_seen_at").notNull(),
});

/** 编排：记录当前最新版本号（0 表示还没有保存过版本）。 */
export const orchestrations = pgTable("orchestrations", {
	id: uuid("id").primaryKey(),
	name: text("name").notNull(),
	headVersion: integer("head_version").notNull().default(0),
	createdAt: timestamptz("created_at").notNull(),
});

/** 编排版本：不可变，同一编排内编号唯一、递增。 */
export const orchestrationVersions = pgTable(
	"orchestration_versions",
	{
		id: uuid("id").primaryKey(),
		orchestrationId: uuid("orchestration_id")
			.notNull()
			.references(() => orchestrations.id),
		number: integer("number").notNull(),
		document: jsonb("document").$type<OrchestrationDocument>().notNull(),
		author: text("author").notNull(),
		createdAt: timestamptz("created_at").notNull(),
	},
	(t) => [unique("orchestration_versions_number").on(t.orchestrationId, t.number)],
);

export type RunStatus = "running" | "success" | "failed";
export type ChainStatus = RunStatus;
/** 任务状态（docs/SEMANTICS.md §3.1）；本阶段用到 queued/running/success/failed。 */
export type TaskStatus = "queued" | "running" | "success" | "failed";
export type ErrorKind = "node_error" | "timeout" | "agent_lost" | "env_error" | "config_error";

/** 运行：绑定一个编排版本。params 是填充默认值并覆盖后的入口参数。 */
export const runs = pgTable(
	"runs",
	{
		id: uuid("id").primaryKey(),
		orchestrationId: uuid("orchestration_id")
			.notNull()
			.references(() => orchestrations.id),
		orchestrationVersionId: uuid("orchestration_version_id")
			.notNull()
			.references(() => orchestrationVersions.id),
		triggeredBy: text("triggered_by").notNull(),
		params: jsonb("params").$type<Record<string, unknown>>().notNull(),
		status: text("status").$type<RunStatus>().notNull(),
		startedAt: timestamptz("started_at").notNull(),
		endedAt: timestamptz("ended_at"),
	},
	(t) => [index("runs_orchestration").on(t.orchestrationId)],
);

/** 链实例：主链（depth 0）或子流程实例；ID 由运行、父链实例、异步任务节点确定性生成。 */
export const chainInstances = pgTable(
	"chain_instances",
	{
		id: uuid("id").primaryKey(),
		runId: uuid("run_id")
			.notNull()
			.references(() => runs.id),
		/** 链起点（入口节点 / 子流程入口节点）的节点 ID。 */
		chainId: text("chain_id").notNull(),
		parentChainInstanceId: uuid("parent_chain_instance_id"),
		asyncNodeId: text("async_node_id"),
		depth: integer("depth").notNull(),
		params: jsonb("params").$type<Record<string, unknown>>().notNull(),
		status: text("status").$type<ChainStatus>().notNull(),
		startedAt: timestamptz("started_at").notNull(),
		endedAt: timestamptz("ended_at"),
	},
	(t) => [index("chain_instances_run").on(t.runId)],
);

/** 任务：节点在运行中的一次尝试（内置节点也记一条，agent_name 为空）。ID 由链实例、节点、attempt 确定性生成。 */
export const tasks = pgTable(
	"tasks",
	{
		id: uuid("id").primaryKey(),
		runId: uuid("run_id")
			.notNull()
			.references(() => runs.id),
		chainInstanceId: uuid("chain_instance_id")
			.notNull()
			.references(() => chainInstances.id),
		nodeId: text("node_id").notNull(),
		attempt: integer("attempt").notNull(),
		agentName: text("agent_name"),
		status: text("status").$type<TaskStatus>().notNull(),
		/** 派发时解析过引用的输入；排队时为空。 */
		inputs: jsonb("inputs").$type<Record<string, unknown>>(),
		outputs: jsonb("outputs").$type<Record<string, unknown>>(),
		errorKind: text("error_kind").$type<ErrorKind>(),
		errorMessage: text("error_message"),
		/** 进入 queued 的时间，派发按它排序。 */
		queuedAt: timestamptz("queued_at").notNull(),
		/** 用于同一时刻排队的任务保持创建顺序。 */
		seq: bigserial("seq", { mode: "number" }).notNull(),
		startedAt: timestamptz("started_at"),
		endedAt: timestamptz("ended_at"),
	},
	(t) => [
		unique("tasks_attempt").on(t.chainInstanceId, t.nodeId, t.attempt),
		index("tasks_agent_status").on(t.agentName, t.status),
		index("tasks_chain_instance").on(t.chainInstanceId),
	],
);

/** 已发布的节点包版本；`包名@版本` 唯一，发布后不可变。 */
export const nodePackages = pgTable(
	"node_packages",
	{
		name: text("name").notNull(),
		version: text("version").notNull(),
		metadata: jsonb("metadata").$type<PackageMetadata>().notNull(),
		/** 相对控制面数据目录的路径。 */
		filePath: text("file_path").notNull(),
		sha256: text("sha256").notNull(),
		size: bigint("size", { mode: "number" }).notNull(),
		publishedAt: timestamptz("published_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.name, t.version] })],
);
