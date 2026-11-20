import { cp as copy, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultMigrationsDir } from "../../src/db/database.js";

/** drizzle 迁移文件里语句之间的分隔。 */
export const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

/**
 * 迁移目录的一份临时副本（调用方用完删除）：日志里只留编号不大于 `upTo` 的迁移，模拟旧版控制面的库；
 * `edit` 可以改某个迁移文件的内容（例如在末尾加一条会失败的语句，模拟迁移中途出错）。
 */
export async function migrationsCopy(
	options: { upTo?: number; edit?: Record<string, (sql: string) => string> } = {},
): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "sfly-migrations-"));
	await copy(defaultMigrationsDir, dir, { recursive: true });
	if (options.upTo !== undefined) {
		const journalPath = join(dir, "meta", "_journal.json");
		const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
			entries: { idx: number }[];
		};
		const upTo = options.upTo;
		journal.entries = journal.entries.filter((e) => e.idx <= upTo);
		await writeFile(journalPath, JSON.stringify(journal));
	}
	for (const [file, change] of Object.entries(options.edit ?? {})) {
		const path = join(dir, file);
		await writeFile(path, change(await readFile(path, "utf8")));
	}
	return dir;
}
