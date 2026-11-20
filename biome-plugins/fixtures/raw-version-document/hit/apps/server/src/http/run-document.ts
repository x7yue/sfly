export async function runDocuments(db: Db, runId: string) {
	const read = (await readRuns(db, [runId], "full")).get(runId);
	// @hit
	const plain = read.version.document;
	// @hit
	const optional = read?.version.document;
	// @hit
	const { document } = read.version;
	return [plain, optional, document];
}
