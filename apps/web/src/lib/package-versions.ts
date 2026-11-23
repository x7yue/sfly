import { compareVersions } from "@sfly/orchestration";
import type { PackageSummary } from "@sfly/schema";

export { compareVersions };

/** 节点包版本号的比较（编辑器的升级提示、节点包页的版本排序）。 */

/** 节点包的最新版本（按版本号比较，不是发布时间；故事 39）。 */
export const latestVersion = (packages: PackageSummary[] | undefined, name: string) => {
	const versions = packages?.find((p) => p.name === name)?.versions;
	if (!versions || versions.length === 0) return undefined;
	return versions.reduce((a, b) => (compareVersions(a.version, b.version) >= 0 ? a : b)).version;
};
