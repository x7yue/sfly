import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { OrchestrationEditor } from "#/canvas/OrchestrationEditor";
import { getOrchestration, getOrchestrationHead } from "#/lib/api";

export const Route = createFileRoute("/orchestrations/$id")({
	// 画布只在浏览器中渲染。
	ssr: false,
	component: EditorPage,
});

function EditorPage() {
	const { id } = Route.useParams();
	const orchestration = useQuery({
		queryKey: ["orchestration", id],
		queryFn: () => getOrchestration(id),
	});
	// 编辑起点只在进入页面时读取一次，避免后台刷新覆盖正在编辑的内容。
	const head = useQuery({
		queryKey: ["orchestration", id, "head"],
		queryFn: () => getOrchestrationHead(id),
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});

	const error = orchestration.error ?? head.error;
	if (error) return <p className="sf-err p-8">加载失败：{error.message}</p>;
	if (!orchestration.data || !head.data) return <p className="sf-hint p-8">加载中…</p>;
	return <OrchestrationEditor key={id} orchestration={orchestration.data} head={head.data} />;
}
