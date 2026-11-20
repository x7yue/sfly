// @hit
import { orchestrationVersions } from "../db/schema.js";

export async function rawDocument(db: Db) {
	// @hit
	const rows = await db.select().from(orchestrationVersions);
	return rows.map((row) => row.document);
}
