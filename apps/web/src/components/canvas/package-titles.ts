import { packagesApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { apiQuery } from "#/lib/api";

/** 包节点类型的标题（CanvasInfo.titleOf）：同一个节点类型有多个版本时取第一个版本里的标题。 */
export function usePackageTitles(): (pkg: string, node: string) => string | undefined {
	const packages = useQuery(apiQuery(packagesApi.list));
	return useMemo(() => {
		const titles = new Map<string, string>();
		for (const pkg of packages.data?.packages ?? []) {
			for (const v of pkg.versions) {
				for (const n of v.nodes) {
					const key = `${pkg.name}/${n.name}`;
					if (!titles.has(key)) titles.set(key, n.title);
				}
			}
		}
		return (pkg, node) => titles.get(`${pkg}/${node}`);
	}, [packages.data]);
}
