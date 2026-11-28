export class RunService {
	async start(runId: string) {
		// 回调里只用事务对象：不拦。
		await this.deps.db.transaction(async (tx) => {
			await tx.update(runs).set({ state: "running" });
			await tx.select().from(runs);
		});
		// 事务之外用连接池：不拦。
		await this.deps.db.select().from(runs);
	}

	async list() {
		// 别的回调里用连接池：不拦。
		return runIds.map((id) => deps.db.select().from(runs).where(eq(runs.id, id)));
	}

	async loadAll() {
		// 事务之外并发：不拦。
		const [a, b] = await Promise.all([deps.db.select().from(runs), deps.db.select().from(tasks)]);
		await this.deps.db.transaction(async (tx) => {
			// 事务里依次 await：不拦。
			const run = await tx.select().from(runs);
			const tasks = await tx.select().from(tasks);
		});
	}
}
