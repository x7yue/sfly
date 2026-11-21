// 路由要运行的内容就用投影好的视图；运行的版本号等不是文档的字段不拦。
export async function runView(db: Db, runId: string) {
	const read = (await readRuns(db, [runId], "full")).get(runId);
	return { number: read?.version.number, view: await getRunView(db, runId) };
}
