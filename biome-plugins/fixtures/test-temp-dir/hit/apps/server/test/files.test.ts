import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function dirs() {
	// @hit
	const a = await mkdtemp(join(tmpdir(), "sfly-a-"));
	// @hit
	const b = mkdtempSync(join(tmpdir(), "sfly-b-"));
	// @hit
	const c = fs.mkdtempSync(join(tmpdir(), "sfly-c-"));
	// @hit
	const d = await fs.promises.mkdtemp(join(tmpdir(), "sfly-d-"));
	return [a, b, c, d];
}
