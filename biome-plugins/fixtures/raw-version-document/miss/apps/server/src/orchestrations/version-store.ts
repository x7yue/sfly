// 规则只管 apps/server/src/http/：存储层（以及引擎、触发准入）读这张表是它们的职责，别处同样的写法不拦。
import { orchestrationVersions } from "../db/schema.js";

export async function rawDocument(db: Db) {
	const rows = await db.select().from(orchestrationVersions);
	return rows.map((row) => row.document);
}
