import type { TokenView } from "@sfly/schema";
import type { UseQueryResult } from "@tanstack/react-query";
import { cn } from "cn";
import { KeyRoundIcon } from "lucide-react";
import { useState } from "react";
import { EmptyState, QueryView, TableSkeleton } from "#/components/feedback/states";
import { Page, PageHeader, Panel } from "#/components/page";
import { StatusPill } from "#/components/status";
import { scopesText, TOKEN_STATE_LABEL } from "#/lib/copy";
import { formatDateTimeWithYear } from "#/lib/format";
import { useNow } from "#/lib/use-now";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Truncate } from "@/components/ui/truncate";
import { IssueTokenDialog, RevokeTokenDialog, type TokenOwner } from "./dialogs";
import { type TokenState, tokenState } from "./state";

/**
 * 令牌页的内容（个人令牌页和项目令牌页共用）：列出令牌（含已吊销、已过期的，带状态）、签发、吊销。
 * 控制面只存哈希和前缀，所以列表里只有名称、前缀、范围、时间；原值只在签发那一刻的弹窗里出现一次。
 */
export function TokensPage({
	owner,
	tokens,
	title,
	description,
	intro,
}: {
	owner: TokenOwner;
	/** 列表的查询：个人令牌和项目令牌是两个接口，由各自的路由发出。 */
	tokens: UseQueryResult<{ tokens: TokenView[] }>;
	title: string;
	description?: React.ReactNode;
	/** 表格上方的说明。 */
	intro: React.ReactNode;
}) {
	const personal = owner.kind === "personal";
	const [issuing, setIssuing] = useState(false);
	const list = tokens.data?.tokens;
	const issueButton = (
		<Button variant="primary" onClick={() => setIssuing(true)}>
			签发令牌
		</Button>
	);
	return (
		<Page>
			<PageHeader
				title={title}
				count={list?.length}
				countClassName="text-fg-2"
				description={description}
				actions={list && list.length > 0 && issueButton}
			/>
			<p className="mt-0 mb-3 max-w-[72ch] text-sm text-fg-2">{intro}</p>
			<Panel>
				<QueryView
					query={tokens}
					loading={<TableSkeleton columns={8} />}
					errorTitle="无法加载令牌"
					isEmpty={(d) => d.tokens.length === 0}
					empty={
						<EmptyState
							icon={<KeyRoundIcon />}
							title={personal ? "还没有个人令牌" : "这个项目还没有项目令牌"}
							description={
								personal
									? "在命令行里运行 sfly login 会自动签发一个；也可以在这里签发，给 API 客户端或脚本用。"
									: "给自动化或自建页面签发一个：它属于项目，不属于某个人。"
							}
						>
							{issueButton}
						</EmptyState>
					}
				>
					{(data) => <TokenTable owner={owner} tokens={data.tokens} />}
				</QueryView>
			</Panel>
			<IssueTokenDialog owner={owner} open={issuing} onOpenChange={setIssuing} />
		</Page>
	);
}

const STATE_KIND = { active: "ok", expired: "warn", revoked: "stopped" } as const;

function TokenTable({ owner, tokens }: { owner: TokenOwner; tokens: TokenView[] }) {
	const personal = owner.kind === "personal";
	// 过期是按时间算的：用会走动的当前时间，页面放着不动，到期的令牌也会变成「已过期」。
	const now = useNow(true);
	return (
		<Table aria-label={personal ? "个人令牌列表" : "项目令牌列表"}>
			<TableHeader>
				<TableRow>
					<TableHead width="grow">名称</TableHead>
					<TableHead width="fit">前缀</TableHead>
					<TableHead width="fit">范围</TableHead>
					{personal && <TableHead width="fit">限定项目</TableHead>}
					{!personal && <TableHead width="fit">签发人</TableHead>}
					<TableHead width="fit">创建时间</TableHead>
					<TableHead width="fit">最后使用</TableHead>
					<TableHead width="fit">过期时间</TableHead>
					<TableHead width="fit">状态</TableHead>
					<TableHead width="fit" className="text-right">
						操作
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{tokens.map((token) => (
					<TokenRow key={token.id} owner={owner} token={token} state={tokenState(token, now)} />
				))}
			</TableBody>
		</Table>
	);
}

function TokenRow({
	owner,
	token,
	state,
}: {
	owner: TokenOwner;
	token: TokenView;
	state: TokenState;
}) {
	const [revoking, setRevoking] = useState(false);
	// 已吊销、已过期的行淡一档：它们只是记录，不再能用。
	const live = state === "active";
	return (
		<TableRow data-token={token.name} data-state={state}>
			<TableCell width="grow" className={cn("font-semibold", !live && "text-fg-3")}>
				<Truncate>{token.name}</Truncate>
			</TableCell>
			<TableCell width="fit" data-slot="token-prefix" className="font-mono text-xs text-fg-2">
				{token.prefix}…
			</TableCell>
			<TableCell width="fit" className={cn("text-xs", live ? "text-fg-1" : "text-fg-3")}>
				{scopesText(token.scopes)}
			</TableCell>
			{owner.kind === "personal" && (
				<TableCell width="fit" className="font-mono text-xs text-fg-2">
					{token.project ?? <span className="font-sans text-fg-3">不限定</span>}
				</TableCell>
			)}
			{owner.kind === "project" && (
				// 项目令牌属于项目，不随签发人失效（他被停用、移出项目之后照样有效）：这一列记着是谁签发的。
				<TableCell width="fit" data-slot="token-issuer" className="text-xs text-fg-2">
					{token.issued_by ?? <span className="text-fg-3">未记录</span>}
				</TableCell>
			)}
			<TableCell width="fit" className="font-mono text-xs text-fg-3">
				{formatDateTimeWithYear(token.created_at)}
			</TableCell>
			<TableCell width="fit" className="font-mono text-xs text-fg-3">
				{token.last_used_at ? (
					formatDateTimeWithYear(token.last_used_at)
				) : (
					<span className="font-sans">从未使用</span>
				)}
			</TableCell>
			<TableCell width="fit" className="font-mono text-xs text-fg-3">
				{token.expires_at ? (
					formatDateTimeWithYear(token.expires_at)
				) : (
					<span className="font-sans">不过期</span>
				)}
			</TableCell>
			<TableCell width="fit">
				<StatusPill kind={STATE_KIND[state]}>{TOKEN_STATE_LABEL[state]}</StatusPill>
			</TableCell>
			<TableCell width="fit" className="text-right">
				{/* 固定一个按钮的高度：没有吊销按钮的行（已吊销、已过期）和有按钮的行一样高。 */}
				<div className="flex h-7 items-center justify-end">
					{live && (
						<>
							<Button size="sm" onClick={() => setRevoking(true)}>
								吊销
							</Button>
							<RevokeTokenDialog
								owner={owner}
								token={token}
								open={revoking}
								onOpenChange={setRevoking}
							/>
						</>
					)}
				</div>
			</TableCell>
		</TableRow>
	);
}
