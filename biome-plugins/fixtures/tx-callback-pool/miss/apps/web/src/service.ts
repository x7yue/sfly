// 规则只管 apps/server/src/：别处同样的写法不拦。
export async function start() {
	await store.transaction(async (tx) => {
		await deps.db.select().from(runs);
	});
}
