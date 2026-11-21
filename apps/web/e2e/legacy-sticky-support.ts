import { createRequire } from "node:module";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";

// 便签（sticky_notes，ADR 0026）已移除（#445、ADR 0028）：升级前保存的每个版本都带着这一项，也可能有内容。
// 保存接口已经不收带它的文档，只能直接写库造出这样的历史版本，或者把它写进浏览器的本地草稿。

/** pg 只装在 apps/server 里：从它的目录解析（e2e 不另加依赖）。 */
const { Client } = createRequire(new URL("../../server/package.json", import.meta.url))("pg") as {
	Client: new (config: {
		connectionString: string;
	}) => {
		connect(): Promise<void>;
		query(sql: string, values: unknown[]): Promise<{ rowCount: number | null }>;
		end(): Promise<void>;
	};
};

/** 升级前保存的、有内容的便签：标题、列表正文、颜色、位置和大小都写着。 */
export const LEGACY_STICKY_NOTES = [
	{
		id: "sticky_1",
		title: "跑之前确认",
		text: "- Agent 都在线\n- 升级包已放到共享目录",
		color: "pink",
		position: { x: 0, y: -260 },
		size: { width: 280, height: 168 },
	},
	{ id: "sticky_2", text: "已知问题：重启偶尔超过 5 分钟", position: { x: 320, y: -260 } },
];

/** 便签里写的文字：页面上任何地方都不该再出现。 */
export const LEGACY_STICKY_TEXTS = [
	"跑之前确认",
	"升级包已放到共享目录",
	"已知问题：重启偶尔超过 5 分钟",
];

/** 把场景所有版本的文档改成升级前保存的样子：顶层带着有内容的 `sticky_notes`。 */
export async function addLegacyStickyNotes(cp: TestControlPlane, scenario: string): Promise<void> {
	const client = new Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		const updated = await client.query(
			"update orchestration_versions set document = document || $2::jsonb where orchestration_id = $1",
			[scenario, JSON.stringify({ sticky_notes: LEGACY_STICKY_NOTES })],
		);
		if (!updated.rowCount) throw new Error(`没能给场景 ${scenario} 的版本加上 sticky_notes`);
	} finally {
		await client.end();
	}
}
