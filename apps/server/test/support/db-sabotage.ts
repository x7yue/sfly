import pg from "pg";

/** 在数据库 `url` 上执行一段 SQL，返回行。 */
export async function sql<T extends object = Record<string, unknown>>(
	url: string,
	text: string,
): Promise<T[]> {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		return (await client.query<T>(text)).rows;
	} finally {
		await client.end();
	}
}

/**
 * 让 `table` 上每一行的 `event`（`insert`、`update`）慢 `seconds` 秒：触发器里睡一觉。
 * 控制面在事务里写这张表时，这条语句会在数据库里「进行中」好几秒，测试就能在这段时间里结束它的连接
 * （不改控制面的代码，从数据库一侧造出「事务进行到一半」）。
 */
export async function slowDown(
	url: string,
	table: string,
	event: "insert" | "update",
	seconds = 8,
): Promise<void> {
	await sql(
		url,
		`create or replace function probe_sleep() returns trigger language plpgsql as $$
			begin perform pg_sleep(${seconds}); return new; end $$;
		 create trigger probe_${table}_${event} before ${event} on ${table}
			for each row execute function probe_sleep();`,
	);
}

/** 去掉 {@link slowDown} 加的触发器。 */
export async function speedUp(
	url: string,
	table: string,
	event: "insert" | "update",
): Promise<void> {
	await sql(url, `drop trigger if exists probe_${table}_${event} on ${table}`);
}

/**
 * 等到有一个活动中的查询包含 `fragment`，结束那个连接（`pg_terminate_backend`，和数据库重启、网络中断时
 * 连接被断开一样）；返回结束了几个，超时没等到返回 0。
 */
export async function terminateActive(
	url: string,
	fragment: string,
	timeoutMs = 20_000,
): Promise<number> {
	const database = new URL(url).pathname.slice(1);
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		const [row] = await sql<{ n: number }>(
			url,
			`select count(*)::int as n, count(pg_terminate_backend(pid)) as killed from pg_stat_activity
			 where datname = '${database}' and state = 'active' and pid <> pg_backend_pid()
			   and query ilike '%${fragment.replaceAll("'", "''")}%'`,
		);
		if (row && row.n > 0) return row.n;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return 0;
}

/** 结束这个数据库上所有空闲的连接；返回结束了几个。 */
export async function terminateIdle(url: string): Promise<number> {
	const database = new URL(url).pathname.slice(1);
	const [row] = await sql<{ n: number }>(
		url,
		`select count(*)::int as n, count(pg_terminate_backend(pid)) as killed from pg_stat_activity
		 where datname = '${database}' and state = 'idle' and pid <> pg_backend_pid()`,
	);
	return row?.n ?? 0;
}
