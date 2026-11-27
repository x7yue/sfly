import { describe, expect, it } from "vitest";
import { diffLineKind } from "./DiffBlock";

describe("差异里的一行是什么", () => {
	it("增、删、没动的行按行首的字符分；`+++`、`---` 是文件名那两行（头），不是增删", () => {
		expect(diffLineKind("+timeout = 30")).toBe("add");
		expect(diffLineKind("-timeout = None")).toBe("del");
		expect(diffLineKind(" import requests")).toBe("context");
		expect(diffLineKind("")).toBe("context");
		expect(diffLineKind("--- a/nodes/http_check.py")).toBe("meta");
		expect(diffLineKind("+++ b/nodes/http_check.py")).toBe("meta");
	});

	it("git 的头和行号范围是 meta：diff --git、index、@@、new file、Binary files、rename", () => {
		for (const line of [
			"diff --git a/a.py b/a.py",
			"index 8c2e41a..f31b7d0 100644",
			"@@ -1,5 +1,5 @@",
			"new file mode 100644",
			"deleted file mode 100644",
			"similarity index 90%",
			"rename from a.py",
			"Binary files a/x.png and b/x.png differ",
		]) {
			expect(diffLineKind(line), line).toBe("meta");
		}
	});

	it("pi 的编辑结果里的差异（`+12 新的一行`、`-12 旧的一行`、` 12 没动的一行`）也按这个读", () => {
		expect(diffLineKind("+1 def run(url: str, timeout: float = 30.0) -> int:")).toBe("add");
		expect(diffLineKind("-1 def run(url: str) -> int:")).toBe("del");
		expect(diffLineKind(" 2     return requests.get(url).status_code")).toBe("context");
	});
});
