import { describe, expect, it } from "vitest";
import { uniqueNodeId } from "../src/index.js";

describe("新节点 ID", () => {
	it("在前缀后编号，跳过已有的；前缀里的非法字符换成下划线", () => {
		expect(uniqueNodeId("fetch", [])).toBe("fetch_1");
		expect(uniqueNodeId("fetch", ["fetch_1", "fetch_2"])).toBe("fetch_3");
		expect(uniqueNodeId("http-check", [])).toBe("http_check_1");
		expect(uniqueNodeId("", [])).toBe("node_1");
	});
});
