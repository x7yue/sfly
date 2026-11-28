export class RunService {
	async start(runId: string) {
		await this.deps.db.transaction(async (tx) => {
			await tx.update(runs).set({ state: "running" });
			// @hit
			await deps.db.select().from(runs);
		});
	}

	async finish(runId: string) {
		await this.#event((tx) => {
			// @hit
			return this.deps.db.select().from(runs);
		});
		await this.#step((tx) => {
			// @hit
			return deps.db.select().from(runs);
		});
		await this.engine.event((tx) => {
			// @hit
			return deps.db.select().from(runs);
		});
	}

	async load(runId: string) {
		await this.deps.db.transaction(async (tx) => {
			// @hit
			const [run, tasks] = await Promise.all([tx.select().from(runs), tx.select().from(tasks)]);
			// @hit
			await Promise.allSettled([tx.delete(runs), tx.delete(tasks)]);
		});
	}
}
