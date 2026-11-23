import { sessionsApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { QueryView, TableSkeleton } from "#/components/feedback/states";
import { useListNavigation } from "#/components/list-navigation";
import { Page, PageHeader, Panel, SectionHeading } from "#/components/page";
import { apiQuery } from "#/lib/api";
import { PAGE, SESSION } from "#/lib/copy";
import { NewSession } from "#/sessions/NewSession";
import { SESSION_PROJECT } from "#/sessions/project";
import { ReadinessLine } from "#/sessions/ReadinessLine";
import { SessionList } from "#/sessions/SessionList";

export const Route = createFileRoute("/_shell/sessions/")({
	staticData: { crumb: PAGE.assistant },
	component: AssistantPage,
});

/**
 * 助手页（#542）：助手此刻能不能用，一个输入框（说一句话就开始一个会话），和本项目的会话。
 * 列表在窗口重新获得焦点时和建会话之后刷新，不开事件流。
 */
function AssistantPage() {
	const sessions = useQuery({
		...apiQuery(sessionsApi.list, { params: { project: SESSION_PROJECT } }),
		refetchOnWindowFocus: true,
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
						<ReadinessLine readiness={data.readiness} />
						<NewSession readiness={data.readiness} sessions={data.sessions} />
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
