import { describe, expect, it } from "vitest";
import { artifactUrl, parseArtifactUrl } from "../src/artifact-url.js";

// 产物地址的拼和认在同一个模块里（#434 CODE-5）：拼出来的总能认回去，名称里的空格、中文、`#`、`?` 都按段编码。
const TASK = "0b6f1c2a-3d4e-4f50-8a1b-2c3d4e5f6a7b";

describe("产物的地址", () => {
	it("拼出来的地址认回任务 ID 和名称", () => {
		for (const name of ["report.html", "out/日志 1.txt", "a#b?c/d%e", "深/层/目录/x.json"]) {
			const url = artifactUrl("https://sfly.example.test", TASK, name);
			expect(parseArtifactUrl(url)).toEqual({ taskId: TASK, name });
		}
		expect(artifactUrl("http://h:8080", TASK, "out/日志 1.txt")).toBe(
			`http://h:8080/tasks/${TASK}/artifacts/out/${encodeURIComponent("日志 1.txt")}`,
		);
	});

	it("不是产物引用的字符串认不出来", () => {
		for (const value of [
			"https://example.test/tasks/not-a-uuid/artifacts/x",
			`https://example.test/tasks/${TASK}/logs`,
			`https://example.test/tasks/${TASK}/artifacts/`,
			`https://example.test/tasks/${TASK}/artifacts/x?download=1`,
			`ftp://example.test/tasks/${TASK}/artifacts/x`,
			`https://example.test/tasks/${TASK}/artifacts/%E0%A4%A`,
			"just text",
		]) {
			expect(parseArtifactUrl(value), value).toBeNull();
		}
	});
});
