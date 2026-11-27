import { sessionsApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { QueryView, TableSkeleton } from "#/components/feedback/states";
import { useListNavigation } from "#/components/list-navigation";
import { Page, PageHeader, Panel, SectionHeading } from "#/components/page";
import { apiQuery } from "#/lib/api";
import { PAGE, SESSION } from "#/lib/copy";
import { STATUS_POLL_MS } from "#/lib/polling";
import { NewSession } from "#/sessions/NewSession";
import { SESSION_PROJECT } from "#/sessions/project";
import { SessionList } from "#/sessions/SessionList";

export const Route = createFileRoute("/_shell/")({
	staticData: { crumb: PAGE.assistant },
	component: AssistantPage,
});

/**
 * 助手页，项目首页（#542、#553）：一个输入框（说一句话就开始一个会话，助手此刻能不能用写在输入框旁边，`NewSession`），和本项目的会话。
 * 列表在窗口重新获得焦点时和建会话之后刷新，不开事件流；有会话在做或排队时每 5 秒重新查询，排队的位置前进了、做完的会话回到空闲
 * 才看得到（#544）。
 */
function AssistantPage() {
	const sessions = useQuery({
		...apiQuery(sessionsApi.list, { params: { project: SESSION_PROJECT } }),
		refetchOnWindowFocus: true,
		// 有会话在做或排队时每 5 秒重新查询；标签页在后台时不查（`refetchIntervalInBackground` 默认就是 false，写明白）；
		// 没有在做或排队的会话时不轮询，只在获得焦点和建会话之后刷新。
		refetchInterval: (query) =>
			query.state.data?.sessions.some((s) => s.status === "running" || s.status === "queued")
				? STATUS_POLL_MS
				: false,
		refetchIntervalInBackground: false,
	});
	useListNavigation();
	return (
		<Page>
			<PageHeader title={PAGE.assistant} />
			<QueryView
				query={sessions}
				loading={
					<Panel>
						<TableSkeleton columns={4} />
					</Panel>
				}
				errorTitle="无法加载助手"
			>
				{(data) => (
					<div className="flex flex-col gap-4">
						<NewSession readiness={data.readiness} />
						<section aria-labelledby="session-list-heading">
							<SectionHeading level={2} id="session-list-heading">
								{SESSION.list.heading}
							</SectionHeading>
							<SessionList sessions={data.sessions} truncated={data.truncated} />
						</section>
					</div>
				)}
			</QueryView>
		</Page>
	);
}
