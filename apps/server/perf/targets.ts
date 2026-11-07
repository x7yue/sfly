// 性能目标只写在 docs/ARCHITECTURE.md §7.6 的目标表里；报告里的目标从那里读取，避免两处不一致。

/** 读出 §7.6 目标表：范围 → 目标原文。 */
export function parseTargets(architecture: string): Map<string, string> {
	const targets = new Map<string, string>();
	let inSection = false;
	for (const line of architecture.split("\n")) {
		if (/^#{1,6} /.test(line)) {
			inSection = /^### 7\.6 /.test(line);
			continue;
		}
		if (!inSection || !line.startsWith("|")) continue;
		const cells = line
			.replace(/^\||\|$/g, "")
			.split("|")
			.map((c) => c.trim());
		const [scope, target] = cells;
		if (cells.length !== 2 || !scope || !target) continue;
		if (scope === "范围" || /^-+$/.test(scope)) continue;
		targets.set(scope, target);
	}
	return targets;
}
