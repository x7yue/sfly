// 会话构建的回收（#795）：会话结束之后会话构建就不能再被引用（`BuildScope`），已经触发的运行照常派发；
// 没有没结束的运行用它之后，周期清理删掉库里的行和归档文件。
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { nodePackages } from "../db/schema.js";

/** 一次最多回收几个，多的下一轮再收。 */
const RECLAIM_BATCH = 100;

export class SessionBuildReclaim {
	constructor(
		private readonly deps: {
			db: Db;
			/** 控制面数据目录：归档文件在它下面（`node_packages.file_path`）。 */
			dataDir: string;
			/** 删不掉的归档文件（下一轮不会再找到它：行已经删了）。 */
			onError: (what: string, error: unknown) => void;
		},
	) {}

	/**
	 * 删掉可以回收的会话构建：会话已结束，并且没有一次没结束的运行，绑定的场景版本锁定了它。先删行（提交），再删归档文件：
	 * 删行之后没有人能再找到它，文件删不掉只进日志。返回回收的个数。
	 */
	async sweep(): Promise<number> {
		const { db } = this.deps;
		const reclaimed = await db.transaction(async (tx) => {
			const due = await tx.execute<{ name: string; version: string }>(sql`
				select np.name, np.version
				from node_packages np
				join sessions s on s.id = np.session_id
				where np.session_id is not null and s.status = 'ended'
					and not exists (
						select 1
						from runs r
						join orchestration_versions v on v.id = r.orchestration_version_id
						where r.ended_at is null
							and r.project_id = np.project_id
							and v.document -> 'packages' ->> np.name = np.version
					)
				order by np.published_at
				limit ${RECLAIM_BATCH}
				for update of np skip locked
			`);
			const rows = [];
			for (const { name, version } of due.rows) {
				const [row] = await tx
					.delete(nodePackages)
					.where(and(eq(nodePackages.name, name), eq(nodePackages.version, version)))
					.returning({ filePath: nodePackages.filePath });
				if (row) rows.push(row);
			}
			return rows;
		});
		for (const { filePath } of reclaimed) {
			await rm(join(this.deps.dataDir, filePath), { force: true }).catch((error) =>
				this.deps.onError(`删除会话构建的归档 ${filePath} 失败：`, error),
			);
		}
		return reclaimed.length;
	}
}
