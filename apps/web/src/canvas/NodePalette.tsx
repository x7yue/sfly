import type { PackageSummary } from "#/lib/api";
import { KindChip } from "./NodeCard";

/** 从节点类型面板拖到画布上时携带的数据。 */
export interface PaletteItem {
	package: string;
	version: string;
	node: string;
	title: string;
}

export const PALETTE_MIME = "application/x-sfly-node-type";

/**
 * 节点类型面板：列出已发布节点包里的节点类型。
 * 编排已锁定某个包的版本时，显示该版本的节点类型；否则显示最新版本。
 */
export function NodePalette({
	packages,
	locked,
	onAdd,
}: {
	packages: PackageSummary[] | undefined;
	locked: Record<string, string>;
	onAdd(item: PaletteItem): void;
}) {
	if (!packages) return <p className="sf-hint px-3.5">加载节点类型…</p>;
	if (packages.length === 0) {
		return (
			<p className="sf-hint px-3.5">
				还没有发布任何节点包。用 <code>sfly publish</code> 发布后，节点类型会出现在这里。
			</p>
		);
	}
	return (
		<ul className="space-y-4 p-3.5">
			{packages.map((pkg) => {
				const version = pkg.versions.find((v) => v.version === locked[pkg.name]) ?? pkg.versions[0];
				if (!version) return null;
				return (
					<li key={pkg.name}>
						<div className="flex items-baseline justify-between text-xs text-[var(--sf-text-3)]">
							<span className="font-mono font-semibold text-[var(--sf-text-2)]">{pkg.name}</span>
							<span className="font-mono">
								@{version.version}
								{locked[pkg.name] ? "（已锁定）" : ""}
							</span>
						</div>
						<ul className="mt-1.5 space-y-1.5">
							{version.nodes.map((n) => {
								const item: PaletteItem = {
									package: pkg.name,
									version: version.version,
									node: n.name,
									title: n.title,
								};
								return (
									<li key={n.name}>
										<button
											type="button"
											draggable
											onDragStart={(e) => {
												e.dataTransfer.setData(PALETTE_MIME, JSON.stringify(item));
												e.dataTransfer.effectAllowed = "copy";
											}}
											onClick={() => onAdd(item)}
											title="拖到画布上，或点击添加到画布中央"
											className="sf-palette-item"
										>
											<KindChip kind="package" />
											<span className="min-w-0">
												<span className="block truncate text-[13px] font-medium">{n.title}</span>
												<span className="block truncate font-mono text-[11.5px] text-[var(--sf-text-3)]">
													{pkg.name}/{n.name}
												</span>
											</span>
										</button>
									</li>
								);
							})}
						</ul>
					</li>
				);
			})}
		</ul>
	);
}
