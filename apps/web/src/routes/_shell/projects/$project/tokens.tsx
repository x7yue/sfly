import { tokensApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { apiQuery } from "#/lib/api";
import { PAGE } from "#/lib/copy";
import { TokensPage } from "#/tokens/TokensPanel";

export const Route = createFileRoute("/_shell/projects/$project/tokens")({
	staticData: { crumb: PAGE.projectTokens },
	component: ProjectTokensRoute,
});

/**
 * 项目设置里的「项目令牌」页（ADR 0029「凭据」）：项目令牌属于项目（服务账号），给自动化和自建页面用；
 * 签发、列出、吊销都要这个项目的「管理」范围，项目令牌自己不带「管理」。页面按路径里的项目显示（项目切换在 #499）。
 */
function ProjectTokensRoute() {
	const { project } = Route.useParams();
	const tokens = useQuery(apiQuery(tokensApi.listProject, { params: { project } }));
	return (
		<TokensPage
			owner={{ kind: "project", project }}
			tokens={tokens}
			title={PAGE.projectTokens}
			description={<span className="font-mono">{project}</span>}
			intro="项目令牌属于项目，不属于某个人，给自动化和自建页面用，范围由签发时选定，不能带「管理」。签发、查看和吊销都需要这个项目的「管理」范围。"
		/>
	);
}
