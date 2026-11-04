import type { OrchestrationDocument } from "@sfly/schema";
import type { PackageSummary } from "#/lib/api";
import { latestVersion } from "./catalog";

/**
 * 一个节点包在编排里的版本锁定：显示锁定的版本；有更新的版本时可以升级到最新版本。
 * 升级只改编排的锁定表（同一个包的所有节点一起升级），警告随之重新计算。
 */
export function PackageVersionRow({
	name,
	locked,
	packages,
	onLock,
}: {
	name: string;
	locked: string | undefined;
	packages: PackageSummary[] | undefined;
	onLock(name: string, version: string): void;
}) {
	const latest = latestVersion(packages, name);
	return (
		<div className="flex items-center gap-2 text-[12.5px]">
			<code className="min-w-0 flex-1 truncate" title={`${name}@${locked ?? "未锁定"}`}>
				{name}
				<span className="text-[var(--sf-text-3)]">@</span>
				{locked ?? <span className="text-[var(--sf-warn)]">未锁定</span>}
			</code>
			{latest && latest !== locked ? (
				<button
					type="button"
					className="sf-btn sf-btn--ghost sf-btn--sm"
					title={`把 ${name} 锁定到最新版本 ${latest}`}
					onClick={() => onLock(name, latest)}
				>
					{locked ? `升级到 ${latest}` : `锁定到 ${latest}`}
				</button>
			) : (
				latest && <span className="text-xs text-[var(--sf-text-3)]">已是最新</span>
			)}
		</div>
	);
}

/** 编排用到的全部节点包及锁定的版本。 */
export function PackageVersions({
	doc,
	packages,
	onLock,
}: {
	doc: OrchestrationDocument;
	packages: PackageSummary[] | undefined;
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
					onLock={onLock}
				/>
			))}
			<p className="sf-hint">保存时每个包都锁定到这里的版本；别人发布新版本不会改变这份编排。</p>
		</div>
	);
}
