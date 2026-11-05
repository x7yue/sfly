import { createFileRoute } from "@tanstack/react-router";
import { VersionHistory } from "#/versions/VersionHistory";

/** 版本历史：只读查看任意两个版本并对比差异，把旧版本恢复为新版本。 */
export const Route = createFileRoute("/orchestrations/$id_/versions")({
	validateSearch: (search: Record<string, unknown>): { a?: number; b?: number } => {
		const num = (v: unknown) => {
			const n = Number(v);
			return Number.isInteger(n) && n > 0 ? n : undefined;
		};
		return { a: num(search.a), b: num(search.b) };
	},
	component: VersionsPage,
});

function VersionsPage() {
	const { id } = Route.useParams();
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<VersionHistory
			orchestrationId={id}
			a={search.a}
			b={search.b}
			onPick={(next) => navigate({ search: (prev) => ({ ...prev, ...next }), replace: true })}
		/>
	);
}
