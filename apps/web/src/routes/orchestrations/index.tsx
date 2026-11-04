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

const inputClass =
	"rounded border border-gray-300 px-2 py-1 text-sm outline-none focus:border-blue-500";

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
		<div className="mx-auto max-w-5xl p-8">
			<h1 className="text-2xl font-bold">编排</h1>
			<form
				className="mt-4 flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					if (name.trim()) create.mutate(name.trim());
				}}
			>
				<input
					aria-label="新编排名称"
					className={`${inputClass} w-72`}
					placeholder="新编排名称"
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
				<button
					type="submit"
					disabled={!name.trim() || create.isPending}
					className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
				>
					新建编排
				</button>
				{create.error && (
					<span className="self-center text-sm text-red-600">{create.error.message}</span>
				)}
			</form>
			<p className="mt-1 text-xs text-gray-500">新建的编排自带一个入口节点。</p>

			{isPending && <p className="mt-6 text-gray-500">加载中…</p>}
			{error && <p className="mt-6 text-red-600">加载失败：{error.message}</p>}
			{data && data.orchestrations.length === 0 && (
				<p className="mt-6 text-gray-500">还没有编排。</p>
			)}
			{data && data.orchestrations.length > 0 && (
				<table className="mt-6 w-full text-left text-sm">
					<thead className="text-gray-500">
						<tr>
							<th className="py-2 font-normal">名称</th>
							<th className="py-2 font-normal">最新版本</th>
							<th className="py-2 font-normal">创建时间</th>
							<th className="py-2 font-normal" />
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
		<tr className="border-t border-gray-100 align-top">
			<td className="py-2">
				<Link
					to="/orchestrations/$id"
					params={{ id: orchestration.id }}
					className="font-medium text-blue-600 hover:underline"
				>
					{orchestration.name}
				</Link>
			</td>
			<td className="py-2">
				{orchestration.head_version === 0 ? "未保存" : `v${orchestration.head_version}`}
			</td>
			<td className="py-2 text-gray-500">{new Date(orchestration.created_at).toLocaleString()}</td>
			<td className="py-2 text-right">
				{copyName === null ? (
					<button
						type="button"
						className="text-sm text-blue-600 hover:underline"
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
							className={`${inputClass} w-56`}
							value={copyName}
							// biome-ignore lint/a11y/noAutofocus: 点击“复制”后直接输入新名字
							autoFocus
							onChange={(e) => setCopyName(e.target.value)}
						/>
						<button
							type="submit"
							disabled={!copyName.trim() || copy.isPending}
							className="rounded bg-blue-600 px-2 py-1 text-sm text-white disabled:opacity-50"
						>
							复制
						</button>
						<button
							type="button"
							className="text-sm text-gray-500"
							onClick={() => setCopyName(null)}
						>
							取消
						</button>
					</form>
				)}
				{copy.error && <p className="text-xs text-red-600">{copy.error.message}</p>}
			</td>
		</tr>
	);
}
