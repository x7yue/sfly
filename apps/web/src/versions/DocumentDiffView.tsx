import type { DocumentDiff, FieldChange } from "@sfly/orchestration";
import { isEmptyDiff } from "@sfly/orchestration";
import { KIND_META } from "#/components/canvas/node-display";

/**
 * 两份场景文档的差异列表：场景设置、节点（新增 / 删除 / 修改的字段）、连线、布局。
 * 旧值划线（红），新值绿色；版本对比与保存冲突弹窗共用。
 */
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
		return <p className="m-0 text-sm text-fg-3">两边内容相同。</p>;
	}
	const nodes = diff.nodes;
	return (
		<div className="flex flex-col gap-3 text-sm">
			<p className="m-0 text-xs text-fg-3">
				<span className="text-danger-fg">− {beforeLabel}</span> →{" "}
				<span className="text-ok">+ {afterLabel}</span>
			</p>
			{diff.settings.length > 0 && (
				<DiffSection title="场景设置">
					{diff.settings.map((c) => (
						<ChangeRow key={c.path} change={c} />
					))}
				</DiffSection>
			)}
			{nodes.added.length + nodes.removed.length + nodes.changed.length > 0 && (
				<DiffSection title="节点">
					{nodes.added.map((n) => (
						<Row key={`+${n.id}`}>
							<Ins>
								+ {n.id}（{kindLabel(n.kind)}）
							</Ins>
						</Row>
					))}
					{nodes.removed.map((n) => (
						<Row key={`-${n.id}`}>
							<Del>
								− {n.id}（{kindLabel(n.kind)}）
							</Del>
						</Row>
					))}
					{nodes.changed.map((n) => (
						<div key={`~${n.id}`}>
							<Row>
								<span className="font-mono text-fg-1">{n.id}</span>
								<span className="text-fg-3">（{kindLabel(n.kind)}）</span>
							</Row>
							{n.changes.map((c) => (
								<ChangeRow key={c.path} change={c} indent />
							))}
						</div>
					))}
				</DiffSection>
			)}
			{diff.edges.added.length + diff.edges.removed.length > 0 && (
				<DiffSection title="连线">
					{diff.edges.added.map((e) => (
						<Row key={`+${e.kind}${e.from}${e.to}`}>
							<Ins>
								+ {e.from} → {e.to}
								{e.kind === "dispatch" ? "（调度）" : ""}
							</Ins>
						</Row>
					))}
					{diff.edges.removed.map((e) => (
						<Row key={`-${e.kind}${e.from}${e.to}`}>
							<Del>
								− {e.from} → {e.to}
								{e.kind === "dispatch" ? "（调度）" : ""}
							</Del>
						</Row>
					))}
				</DiffSection>
			)}
			{diff.moved.length > 0 && (
				<DiffSection title="布局">
					<Row>
						<span className="text-fg-2">移动了：</span>
						<span className="font-mono">{diff.moved.join(", ")}</span>
					</Row>
				</DiffSection>
			)}
		</div>
	);
}

function DiffSection({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section aria-label={title}>
			<h4 className="m-0 mb-1 text-xs font-semibold text-fg-3">{title}</h4>
			{children}
		</section>
	);
}

function Row({ indent = false, children }: { indent?: boolean; children: React.ReactNode }) {
	// 在空格处折行，只有一个串长到放不下一行时才在串内断开：路径、参数名不被拦腰截成两个词。
	return (
		<div className={indent ? "py-0.5 pl-4 wrap-anywhere" : "py-0.5 wrap-anywhere"}>{children}</div>
	);
}

// 保留值里的换行（备注是多行文字）。
const Ins = ({ children }: { children: React.ReactNode }) => (
	<ins className="font-mono whitespace-pre-wrap text-ok no-underline">{children}</ins>
);
const Del = ({ children }: { children: React.ReactNode }) => (
	<del className="font-mono whitespace-pre-wrap text-danger-fg">{children}</del>
);

function ChangeRow({ change, indent = false }: { change: FieldChange; indent?: boolean }) {
	return (
		<Row indent={indent}>
			<span className="text-fg-2">{fieldLabel(change.path)}</span>{" "}
			{change.before !== undefined && <Del>{formatValue(change.before)}</Del>}
			{change.before !== undefined && change.after !== undefined && " → "}
			{change.after !== undefined && <Ins>{formatValue(change.after)}</Ins>}
			{change.after === undefined && <span className="text-fg-3">（删除）</span>}
			{change.before === undefined && <span className="text-fg-3">（新增）</span>}
		</Row>
	);
}

const kindLabel = (kind: string) => KIND_META[kind as keyof typeof KIND_META]?.label ?? kind;

const FIELD_LABEL: Record<string, string> = {
	default_agent: "默认 Agent",
	name: "名称",
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
	subflow: "要停止的子流程",
	note: "备注",
};

function fieldLabel(path: string): string {
	const [head, ...rest] = path.split(".");
	const tail = rest.join(".");
	if (head === "packages") return `包 ${tail} 的锁定版本`;
	if (head === "inputs" || head === "params") return `参数 ${tail}`;
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
			description?: string;
		};
		const flags = [p.type, p.required ? "必填" : "可选", ...(p.secret ? ["敏感"] : [])];
		if (p.description !== undefined) flags.push(`说明「${p.description}」`);
		if (p.default !== undefined) flags.push(`默认 ${JSON.stringify(p.default)}`);
		return flags.join(" · ");
	}
	return JSON.stringify(value);
}
