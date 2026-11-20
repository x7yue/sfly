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

/**
 * 把场景版本的文档改成「带着已移除的顶层字段」的样子（例如便签 `sticky_notes`）：直接在库里加上这些字段。
 * 保存接口已经不收带它们的文档，只能这样造出移除之前保存的版本。`number` 不给时改这个场景的所有版本。
 */
export async function addDocumentFields(
	cp: TestControlPlane,
	scenario: string,
	fields: Record<string, unknown>,
	number?: number,
): Promise<void> {
	const client = new pg.Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		const updated = await client.query(
			`update orchestration_versions set document = document || $2::jsonb
			where orchestration_id = $1 and ($3::int is null or number = $3)`,
			[scenario, JSON.stringify(fields), number ?? null],
		);
		if (updated.rowCount === 0) throw new Error(`没能给场景 ${scenario} 的版本加上字段`);
	} finally {
		await client.end();
	}
}

/** 库里某个版本存着的原始文档（不经过控制面读取时的解析）；版本不存在时抛错。 */
export async function storedDocument(
	cp: TestControlPlane,
	scenario: string,
	number: number,
): Promise<Record<string, unknown>> {
	const client = new pg.Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		const { rows } = await client.query(
			"select document from orchestration_versions where orchestration_id = $1 and number = $2",
			[scenario, number],
		);
		if (rows.length === 0) throw new Error(`场景 ${scenario} 没有版本 ${number}`);
		return rows[0].document as Record<string, unknown>;
	} finally {
		await client.end();
	}
}
