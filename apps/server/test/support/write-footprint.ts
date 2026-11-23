import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import pg from "pg";

/**
 * 「一个请求有没有写东西」的检测器：请求前后各取一份控制面留下的全部痕迹，比较。
 *
 * - 数据库：public 里每张表的每一行，连同它的 `xmin`（写入这一行的事务号）。改了一行、哪怕写回同样的值，
 *   也会换一个 `xmin`；加行、删行都在行集合里看得到。只比较行的内容和最大更新时间会漏掉「写回原值」，所以用 xmin。
 * - 序列：`last_value`。取号不会回滚，一个读接口顺手占了编号也算写。
 * - 数据目录：文件名、大小和修改时间。产物、日志文件不在库里。
 *
 * 只会看到「已经提交」的写：事务里写了又回滚的不留痕迹，也不算写。
 * 控制面里只在内存里的状态这里看不到，靠接口的 `effect` 声明和代码审查。
 */
export interface Footprint {
	/** 表名 → 每一行的 `xmin|整行的 JSON`，排好序。 */
	tables: Map<string, string[]>;
	/** 序列名 → `last_value`（还没取过号时为空串）。 */
	sequences: Map<string, string>;
	/** 数据目录里的文件：相对路径 → `大小@修改时间`。 */
	files: Map<string, string>;
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * 访问检查给每个带凭据的请求记下的「用过」的痕迹：不算接口的写。令牌的最后使用时间在访问检查里写（一个令牌每分钟最多一次，
 * `TOKEN_TOUCH_INTERVAL_MS`），不论接口是读还是写、是哪一个接口，所以「只读接口不写库」「别的项目的凭据没有改动任何东西」
 * 这类比较要把它排除：这几列不进比较，这几张表也不用 `xmin`（更新这几列会换 `xmin`）。别的列照常比较：
 * 令牌被吊销、改了范围，仍然看得见。表 → 不比较的列。
 */
const ACCESS_TRACES: Readonly<Record<string, readonly string[]>> = {
	api_tokens: ["last_used_at"],
};

async function listFiles(root: string, dir = root, found = new Map<string, string>()) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) await listFiles(root, path, found);
		else {
			const info = await stat(path);
			found.set(relative(root, path), `${info.size}@${info.mtimeMs}`);
		}
	}
	return found;
}

/** 取一份痕迹：`databaseUrl` 要有读全部表的权限（测试库的管理连接就行）。 */
export async function takeFootprint(databaseUrl: string, dataDir: string): Promise<Footprint> {
	const client = new pg.Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		// 一个事务里读完，各张表是同一个时刻的样子。
		await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
		const names = await client.query<{ tablename: string }>(
			"SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
		);
		const tables = new Map<string, string[]>();
		for (const { tablename } of names.rows) {
			const traces = ACCESS_TRACES[tablename];
			const rows = await client.query<{ row: string }>(
				traces === undefined
					? `SELECT t.xmin::text || '|' || to_jsonb(t)::text AS row FROM ${quote(tablename)} t`
					: `SELECT '-|' || (to_jsonb(t)${traces.map((column) => ` - '${column}'`).join("")})::text AS row FROM ${quote(tablename)} t`,
			);
			tables.set(tablename, rows.rows.map((r) => r.row).sort());
		}
		const sequences = new Map<string, string>();
		const seqs = await client.query<{ sequencename: string; last_value: string | null }>(
			"SELECT sequencename, last_value::text FROM pg_sequences WHERE schemaname = 'public'",
		);
		for (const s of seqs.rows) sequences.set(s.sequencename, s.last_value ?? "");
		await client.query("COMMIT");
		return { tables, sequences, files: await listFiles(dataDir) };
	} finally {
		await client.end();
	}
}

const clip = (text: string) => (text.length > 160 ? `${text.slice(0, 160)}…` : text);

/** 两份痕迹的差别，每条一行；没有差别时返回空数组。 */
export function diffFootprints(before: Footprint, after: Footprint): string[] {
	const changes: string[] = [];
	for (const [table, rows] of after.tables) {
		const old = before.tables.get(table) ?? [];
		const gone = old.filter((row) => !rows.includes(row));
		const added = rows.filter((row) => !old.includes(row));
		if (gone.length === 0 && added.length === 0) continue;
		changes.push(
			`表 ${table}：${added.length} 行新写入或改过，${gone.length} 行被删或被改` +
				[
					...added.slice(0, 2).map((r) => `\n    + ${clip(r)}`),
					...gone.slice(0, 2).map((r) => `\n    - ${clip(r)}`),
				].join(""),
		);
	}
	for (const [name, value] of after.sequences) {
		if (before.sequences.get(name) !== value) {
			changes.push(`序列 ${name}：${before.sequences.get(name) ?? "(无)"} → ${value}`);
		}
	}
	for (const [file, value] of after.files) {
		if (!before.files.has(file)) changes.push(`数据目录新增文件 ${file}`);
		else if (before.files.get(file) !== value) changes.push(`数据目录的文件 ${file} 被改过`);
	}
	for (const file of before.files.keys()) {
		if (!after.files.has(file)) changes.push(`数据目录的文件 ${file} 被删了`);
	}
	return changes;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 等控制面安静下来再取：连着取两份，一样才算数。控制面在后台有周期扫描（租约、保留期、指标写入），
 * 刚做完的操作还在落库时，前后两份会不同。`quiet` 是两次之间的间隔，请求后的那一份用它兜住「响应之后才写」的情形。
 */
export async function settledFootprint(
	databaseUrl: string,
	dataDir: string,
	{ quietMs = 60, timeoutMs = 5000 } = {},
): Promise<Footprint> {
	const deadline = Date.now() + timeoutMs;
	let last = await takeFootprint(databaseUrl, dataDir);
	for (;;) {
		await wait(quietMs);
		const next = await takeFootprint(databaseUrl, dataDir);
		const changes = diffFootprints(last, next);
		if (changes.length === 0) return next;
		if (Date.now() > deadline) {
			throw new Error(`控制面一直不安静，没法判断请求写没写：\n${changes.join("\n")}`);
		}
		last = next;
	}
}
