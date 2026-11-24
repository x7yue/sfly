import { SESSION_LIST_LIMIT, type SessionListItem } from "@sfly/schema";
import { Link } from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";
import { EmptyState } from "#/components/feedback/states";
import { Panel } from "#/components/page";
import { StatusPill } from "#/components/status";
import { SESSION } from "#/lib/copy";
import { formatDateTime } from "#/lib/format";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Truncate } from "@/components/ui/truncate";
import { SESSION_STATUS, statusWithQueue } from "./session-text";

/**
 * 助手页的会话列表：本项目的会话，在做和排队中的在前、其余最近活动在前（接口给的顺序）：标题（第一句话截断）、发起人、状态
 * （排队中的写「排队中 · 排在第 N 位」；停止途中说了话、排在这一轮后面的在做的会话也写排第几）、最近活动时间；点标题进会话页。没有会话时一句说明；会话多到接口只给了最近的一批（`truncated`）时，
 * 列表上面写一句，免得读的人以为这就是全部。
 */
export function SessionList({
	sessions,
	truncated,
}: {
	sessions: readonly SessionListItem[];
	truncated: boolean;
}) {
	if (sessions.length === 0) {
		return (
			<Panel>
				<EmptyState
					icon={<MessageSquareIcon />}
					title={SESSION.list.emptyTitle}
					description={SESSION.list.empty}
				/>
			</Panel>
		);
	}
	return (
		<>
			{/* 提示放在列表上面：一进页面就看得到，不用滚到底；和标题左对齐。 */}
			{truncated && (
				<p data-testid="list-truncated" className="m-0 mb-2 text-sm text-fg-2">
					{SESSION.list.truncated(SESSION_LIST_LIMIT)}
				</p>
			)}
			<Panel>
				<Table aria-label={SESSION.list.label}>
					<TableHeader>
						<TableRow>
							<TableHead width="grow">{SESSION.list.title}</TableHead>
							<TableHead width="fit">{SESSION.list.author}</TableHead>
							<TableHead width="fit">{SESSION.list.status}</TableHead>
							<TableHead width="fit">{SESSION.list.activity}</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{sessions.map((session) => {
							const status = SESSION_STATUS[session.status];
							return (
								<TableRow key={session.id} data-list-item="" data-session={session.id}>
									<TableCell width="grow">
										<Truncate
											render={
												<Link
													to="/sessions/$id"
													params={{ id: session.id }}
													data-list-primary
													className="font-semibold text-fg-1 no-underline hover:underline"
												/>
											}
										>
											{session.title}
										</Truncate>
									</TableCell>
									<TableCell width="fit" className="text-fg-2">
										{session.created_by}
									</TableCell>
									<TableCell width="fit">
										<StatusPill kind={status.kind}>
											<span data-testid="list-status" data-status={session.status}>
												{statusWithQueue(session.status, session.queue_position)}
											</span>
										</StatusPill>
									</TableCell>
									<TableCell width="fit" className="font-mono text-xs text-fg-3">
										{formatDateTime(session.last_activity_at)}
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</Panel>
		</>
	);
}
