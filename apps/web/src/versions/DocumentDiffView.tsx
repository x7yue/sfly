import type { DocumentDiff, FieldChange } from "@sfly/orchestration";
import { isEmptyDiff } from "@sfly/orchestration";
import { KIND_LABEL } from "#/canvas/NodeCard";

/** 两份编排文档的差异列表：节点、参数、连线、编排设置、布局。删除的值划线，新值高亮。 */
export function DocumentDiffView({
	diff,
	beforeLabel,
	afterLabel,
}: {
	diff: DocumentDiff;
	beforeLabel: string;
	afterLabel: string;
}) {
	if (isEmptyDiff(diff)) {
		return <p className="sf-diff__empty">两边内容相同。</p>;
	}
	return (
		<div className="sf-diff">
			<p className="sf-diff__legend">
				<del>{beforeLabel}</del> → <ins>{afterLabel}</ins>
			</p>
			{diff.settings.length > 0 && (
				<DiffSection title="场景设置">
					{diff.settings.map((c) => (
						<ChangeRow key={c.path} change={c} />
					))}
				</DiffSection>
			)}
			{(diff.nodes.added.length > 0 ||
				diff.nodes.removed.length > 0 ||
				diff.nodes.changed.length > 0) && (
				<DiffSection title="节点">
					{diff.nodes.added.map((n) => (
						<div key={`+${n.id}`} className="sf-diff__row">
							<ins>
								+ {n.id}（{kindLabel(n.kind)}）
							</ins>
						</div>
					))}
					{diff.nodes.removed.map((n) => (
						<div key={`-${n.id}`} className="sf-diff__row">
							<del>
								− {n.id}（{kindLabel(n.kind)}）
							</del>
						</div>
					))}
					{diff.nodes.changed.map((n) => (
						<div key={`~${n.id}`} className="sf-diff__node">
							<div className="sf-diff__k">
								{n.id}（{kindLabel(n.kind)}）
							</div>
							{n.changes.map((c) => (
								<ChangeRow key={c.path} change={c} indent />
							))}
						</div>
					))}
				</DiffSection>
			)}
			{(diff.edges.added.length > 0 || diff.edges.removed.length > 0) && (
				<DiffSection title="连线">
					{diff.edges.added.map((e) => (
						<div key={`+${e.kind}${e.from}${e.to}`} className="sf-diff__row">
							<ins>
								+ {e.from} → {e.to}
								{e.kind === "dispatch" ? "（调度）" : ""}
							</ins>
						</div>
					))}
					{diff.edges.removed.map((e) => (
						<div key={`-${e.kind}${e.from}${e.to}`} className="sf-diff__row">
							<del>
								− {e.from} → {e.to}
								{e.kind === "dispatch" ? "（调度）" : ""}
							</del>
						</div>
					))}
				</DiffSection>
			)}
			{diff.moved.length > 0 && (
				<DiffSection title="布局">
					<div className="sf-diff__row">移动了：{diff.moved.join(", ")}</div>
				</DiffSection>
			)}
		</div>
	);
}

function DiffSection({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="sf-diff__section">
			<h4>{title}</h4>
			{children}
		</section>
	);
}

function ChangeRow({ change, indent = false }: { change: FieldChange; indent?: boolean }) {
	return (
		<div className={`sf-diff__row${indent ? " sf-diff__row--indent" : ""}`}>
			<span className="sf-diff__k">{fieldLabel(change.path)}</span>{" "}
			{change.before !== undefined && <del>{formatValue(change.before)}</del>}
			{change.before !== undefined && change.after !== undefined && " → "}
			{change.after !== undefined && <ins>{formatValue(change.after)}</ins>}
			{change.after === undefined && <span className="sf-diff__note">（删除）</span>}
			{change.before === undefined && <span className="sf-diff__note">（新增）</span>}
		</div>
	);
}

const kindLabel = (kind: string) => KIND_LABEL[kind as keyof typeof KIND_LABEL] ?? kind;

const FIELD_LABEL: Record<string, string> = {
	default_agent: "默认 Agent",
	agent: "Agent",
	always: "always",
	kind: "种类",
	package: "包",
	node: "节点类型",
	timeout: "超时（秒）",
	retries: "重试次数",
	queue_timeout: "排队超时（秒）",
	at: "定时",
	tz: "时区",
	duration: "时长",
};

function fieldLabel(path: string): string {
	const [head, ...rest] = path.split(".");
	const tail = rest.join(".");
	if (head === "packages") return `包 ${tail} 的锁定版本`;
	if (head === "inputs") return `参数 ${tail}`;
	if (head === "params") return `参数 ${tail}`;
	return FIELD_LABEL[path] ?? path;
}

function formatValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		"type" in value &&
		!Array.isArray(value)
	) {
		// 入口参数声明
		const p = value as {
			type: string;
			required?: boolean;
			secret?: boolean;
			default?: unknown;
		};
		const flags = [p.type, p.required ? "必填" : "可选", ...(p.secret ? ["敏感"] : [])];
		if (p.default !== undefined) flags.push(`默认 ${JSON.stringify(p.default)}`);
		return flags.join(" · ");
	}
	return JSON.stringify(value);
}
