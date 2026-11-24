import { tokensApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { apiQuery } from "#/lib/api";
import { PAGE } from "#/lib/copy";
import { INLINE_LINK } from "#/lib/inline-link";
import { TokensPage } from "#/tokens/TokensPanel";

export const Route = createFileRoute("/_shell/account/tokens")({
	staticData: { crumb: PAGE.tokens },
	component: PersonalTokensPage,
});

/**
 * 账号菜单里的「令牌」页（ADR 0029「凭据」）：自己的个人令牌，不属于任何项目。
 * 命令行 `sfly login` 签发的也在这里；项目令牌在项目的「项目令牌」页（项目切换在 #499 之后，这一步先指向默认项目）。
 */
function PersonalTokensPage() {
	const tokens = useQuery(apiQuery(tokensApi.listPersonal));
	return (
		<TokensPage
			owner={{ kind: "personal" }}
			tokens={tokens}
			title={PAGE.tokens}
			intro={
				<>
					{
						"个人令牌让命令行、API 客户端和自建页面代表你：权限是令牌的范围和你此刻的角色取交集，你被降级、移出项目或被停用，它跟着失去权限。给自动化用请改用"
					}
					<Link
						to="/projects/$project/tokens"
						params={{ project: "default" }}
						className={INLINE_LINK}
					>
						{PAGE.projectTokens}
					</Link>
					。
				</>
			}
		/>
	);
}
