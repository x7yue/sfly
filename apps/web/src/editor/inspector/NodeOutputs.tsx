import { type NodeTypeIo, schemaDescription } from "@sfly/orchestration";
import { UntrustedText } from "#/components/untrusted-text";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

/**
 * 检查器「说明」标签页里节点类型的输出：「输出 | 说明」两列，说明是节点包用 `Doc` 写的；
 * 没写说明的输出（含旧版本的节点包）那一格留空，不提示缺失。
 */
export function NodeOutputs({ outputs }: { outputs: NodeTypeIo["outputs"] }) {
	return (
		<Table aria-label="输出" className="mt-3 text-xs">
			<TableHeader>
				<TableRow>
					<TableHead width="fit" className="px-0 pr-3">
						输出
					</TableHead>
					<TableHead className="px-0">说明</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{Object.entries(outputs.properties).map(([name, schema]) => {
					const description = schemaDescription(schema);
					return (
						<TableRow key={name}>
							<TableCell
								width="fit"
								className="px-0 py-1.5 pr-3 align-baseline font-mono text-fg-1"
							>
								<UntrustedText text={name} />
							</TableCell>
							<TableCell className="px-0 py-1.5 align-baseline whitespace-pre-line text-fg-2 wrap-anywhere">
								{description !== undefined && <UntrustedText text={description} mode="text" />}
							</TableCell>
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}
