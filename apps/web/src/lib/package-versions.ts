import { compareVersions } from "@sfly/orchestration";
import type { PackageSummary } from "@sfly/schema";

export { compareVersions };

/** 节点包版本号的比较（编辑器的升级提示、节点包页的版本排序）。 */

/** 节点包的最新版本（按版本号比较，不是发布时间；故事 39）：控制面在响应里标出的（`latest_version`，#434），这里不再自己算。 */
export const latestVersion = (packages: PackageSummary[] | undefined, name: string) =>
	packages?.find((p) => p.name === name)?.latest_version || undefined;
