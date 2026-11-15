import pg from "pg";
import type { TestControlPlane } from "./test-control-plane.js";

/**
 * 把场景版本的文档改成升级前的样子：直接在库里去掉后来新增的顶层字段（例如 `annotations`）。
 * 场景版本不可修改、接口保存时会补齐默认值，只能这样造出升级前保存的版本。`number` 不给时改这个场景的所有版本。
 */
export async function dropDocumentFields(
	cp: TestControlPlane,
	scenario: string,
	fields: readonly string[],
	number?: number,
): Promise<void> {
	const client = new pg.Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		const updated = await client.query(
			`update orchestration_versions set document = document - $2::text[]
			where orchestration_id = $1 and ($3::int is null or number = $3)
			returning document ?| $2::text[] as still`,
			[scenario, fields, number ?? null],
		);
		if (updated.rowCount === 0 || updated.rows.some((r) => r.still)) {
			throw new Error(`没能去掉场景 ${scenario} 版本里的 ${fields.join("、")}`);
		}
	} finally {
		await client.end();
	}
}
