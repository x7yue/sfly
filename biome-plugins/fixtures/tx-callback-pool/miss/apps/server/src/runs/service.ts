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
}
