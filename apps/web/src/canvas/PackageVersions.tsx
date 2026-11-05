import type { OrchestrationDocument } from "@sfly/schema";
import { type AgentView, agentsWithDev, type PackageSummary } from "#/lib/api";
import { latestVersion } from "./catalog";

/** 开发版本的版本号（`包名@dev`）。 */
export const DEV_VERSION = "dev";

/**
 * 一个节点包在编排里的版本锁定：可以选择任一已发布版本，或者开发版本 dev（有 Agent 用 sfly dev 加载了它时）；
 * 有更新的版本时可以一键升级到最新版本。改版本只改编排的锁定表（同一个包的所有节点一起改），警告随之重新计算。
 *
 * `nodeAgent` 是选中节点实际派发到的 Agent：锁定 dev 而这个 Agent 没有加载时提示运行会失败。
 */
export function PackageVersionRow({
	name,
	locked,
	packages,
	agents,
	nodeAgent,
	onLock,
}: {
	name: string;
	locked: string | undefined;
	packages: PackageSummary[] | undefined;
	agents: AgentView[];
	nodeAgent?: string;
	onLock(name: string, version: string): void;
}) {
	const latest = latestVersion(packages, name);
	const published = packages?.find((p) => p.name === name)?.versions.map((v) => v.version) ?? [];
	const devAgents = agentsWithDev(agents, name).map((a) => a.name);
	const isDev = locked === DEV_VERSION;
	return (
		<div className="space-y-1">
			<div className="flex items-center gap-2 text-[12.5px]">
				<code className="min-w-0 flex-1 truncate" title={`${name}@${locked ?? "未锁定"}`}>
					{name}
				</code>
				<select
					aria-label={`${name} 的版本`}
					className="sf-inp sf-inp--mono sf-ver-select"
					value={locked ?? ""}
					onChange={(e) => e.target.value && onLock(name, e.target.value)}
				>
					{locked === undefined && <option value="">未锁定</option>}
					{published.map((v) => (
						<option key={v} value={v}>
							{v}
							{v === latest ? "（最新）" : ""}
						</option>
					))}
					{locked !== undefined && !isDev && !published.includes(locked) && (
						<option value={locked}>{locked}（未发布）</option>
					)}
					{(devAgents.length > 0 || isDev) && <option value={DEV_VERSION}>dev（开发版本）</option>}
				</select>
				{latest && latest !== locked && (
					<button
						type="button"
						className="sf-btn sf-btn--ghost sf-btn--sm shrink-0"
						title={`把 ${name} 锁定到最新版本 ${latest}`}
						onClick={() => onLock(name, latest)}
					>
						{locked && !isDev ? `升级到 ${latest}` : `锁定到 ${latest}`}
					</button>
				)}
			</div>
			{isDev && <DevHint devAgents={devAgents} nodeAgent={nodeAgent} />}
		</div>
	);
}

function DevHint({ devAgents, nodeAgent }: { devAgents: string[]; nodeAgent?: string }) {
	if (devAgents.length === 0) {
		return (
			<p className="sf-warn-item">
				没有 Agent 加载这个包的开发版本：在 Agent 所在的机器上运行 <code>sfly dev</code>。
			</p>
		);
	}
	if (nodeAgent && !devAgents.includes(nodeAgent)) {
		return (
			<p className="sf-warn-item">
				节点的 Agent <code>{nodeAgent}</code> 没有加载开发版本，运行时会以 env_error 失败。
			</p>
		);
	}
	return (
		<p className="sf-hint !mt-0">
			开发版本只能在加载了它的 Agent 上执行：
			{devAgents.map((a, i) => (
				<span key={a}>
					{i > 0 && "、"}
					<code>{a}</code>
				</span>
			))}
		</p>
	);
}

/** 编排用到的全部节点包及锁定的版本。 */
export function PackageVersions({
	doc,
	packages,
	agents,
	onLock,
}: {
	doc: OrchestrationDocument;
	packages: PackageSummary[] | undefined;
	agents: AgentView[];
	onLock(name: string, version: string): void;
}) {
	const used = [
		...new Set(doc.nodes.flatMap((n) => (n.kind === "package" ? [n.package] : []))),
	].sort();
	if (used.length === 0) return <p className="sf-hint">还没有使用任何节点包。</p>;
	return (
		<div className="space-y-2">
			{used.map((name) => (
				<PackageVersionRow
					key={name}
					name={name}
					locked={doc.packages[name]}
					packages={packages}
					agents={agents}
					onLock={onLock}
				/>
			))}
			<p className="sf-hint">
				保存时每个包都锁定到这里的版本；别人发布新版本不会改变这份编排。选 dev 使用本机{" "}
				<code>sfly dev</code> 加载的源码，不需要发布。
			</p>
		</div>
	);
}
