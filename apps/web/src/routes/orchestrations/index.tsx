import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
	copyOrchestration,
	createOrchestration,
	listOrchestrations,
	type Orchestration,
} from "#/lib/api";

export const Route = createFileRoute("/orchestrations/")({ component: OrchestrationsPage });

function OrchestrationsPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { data, error, isPending } = useQuery({
		queryKey: ["orchestrations"],
		queryFn: listOrchestrations,
	});
	const [name, setName] = useState("");

	const create = useMutation({
		mutationFn: (n: string) => createOrchestration(n),
		onSuccess: (created) => {
			queryClient.invalidateQueries({ queryKey: ["orchestrations"] });
			navigate({ to: "/orchestrations/$id", params: { id: created.id } });
		},
	});

	return (
		<div className="sf-page">
			<h1>编排</h1>
			<form
				className="mt-4 flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					if (name.trim()) create.mutate(name.trim());
				}}
			>
				<input
					aria-label="新编排名称"
					className="sf-inp w-72"
					placeholder="新编排名称"
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
				<button
					type="submit"
					disabled={!name.trim() || create.isPending}
					className="sf-btn sf-btn--primary"
				>
					新建编排
				</button>
				{create.error && <span className="sf-err self-center">{create.error.message}</span>}
			</form>
			<p className="sf-hint">新建的编排自带一个入口节点。</p>

			{isPending && <p className="sf-hint mt-6">加载中…</p>}
			{error && <p className="sf-err mt-6">加载失败：{error.message}</p>}
			{data && data.orchestrations.length === 0 && <p className="sf-hint mt-6">还没有编排。</p>}
			{data && data.orchestrations.length > 0 && (
				<table className="sf-table">
					<thead>
						<tr>
							<th scope="col">名称</th>
							<th scope="col">最新版本</th>
							<th scope="col">创建时间</th>
							<th scope="col" />
						</tr>
					</thead>
					<tbody>
						{data.orchestrations.map((o) => (
							<OrchestrationRow key={o.id} orchestration={o} />
						))}
					</tbody>
				</table>
			)}
		</div>
	);
}

function OrchestrationRow({ orchestration }: { orchestration: Orchestration }) {
	const queryClient = useQueryClient();
	const [copyName, setCopyName] = useState<string | null>(null);
	const copy = useMutation({
		mutationFn: (name: string) => copyOrchestration(orchestration.id, name),
		onSuccess: () => {
			setCopyName(null);
			queryClient.invalidateQueries({ queryKey: ["orchestrations"] });
		},
	});

	return (
		<tr>
			<td>
				<Link to="/orchestrations/$id" params={{ id: orchestration.id }} className="sf-link">
					{orchestration.name}
				</Link>
			</td>
			<td>{orchestration.head_version === 0 ? "未保存" : `v${orchestration.head_version}`}</td>
			<td className="text-[var(--sf-text-3)]">
				{new Date(orchestration.created_at).toLocaleString()}
			</td>
			<td className="text-right">
				{copyName === null ? (
					<button
						type="button"
						className="sf-link border-0 bg-transparent text-[13px]"
						onClick={() => setCopyName(`${orchestration.name} 副本`)}
					>
						复制
					</button>
				) : (
					<form
						className="flex justify-end gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							if (copyName.trim()) copy.mutate(copyName.trim());
						}}
					>
						<input
							aria-label="副本名称"
							className="sf-inp w-56"
							value={copyName}
							// biome-ignore lint/a11y/noAutofocus: 点击“复制”后直接输入新名字
							autoFocus
							onChange={(e) => setCopyName(e.target.value)}
						/>
						<button
							type="submit"
							disabled={!copyName.trim() || copy.isPending}
							className="sf-btn sf-btn--primary sf-btn--sm"
						>
							复制
						</button>
						<button
							type="button"
							className="sf-btn sf-btn--ghost sf-btn--sm"
							onClick={() => setCopyName(null)}
						>
							取消
						</button>
					</form>
				)}
				{copy.error && <p className="sf-err">{copy.error.message}</p>}
			</td>
		</tr>
	);
}
