import { ApiError } from "@sfly/client";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTION } from "#/lib/copy";
import { ErrorState } from "./states";

vi.mock("./notify", () => ({ notify: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
	vi.unstubAllGlobals();
});

interface Element {
	props: { onClick?: () => void; children?: ReactNode };
}

const isElement = (node: unknown): node is Element =>
	typeof node === "object" && node !== null && "props" in node;

const clickables = (node: ReactNode): Element[] => {
	if (Array.isArray(node)) return node.flatMap(clickables);
	if (!isElement(node)) return [];
	const own = typeof node.props.onClick === "function" ? [node] : [];
	return [...own, ...clickables(node.props.children)];
};

const textOf = (node: ReactNode): string => {
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (typeof node === "string") return node;
	return isElement(node) ? textOf(node.props.children) : "";
};

async function copiedErrorDetails(error: unknown): Promise<string> {
	const written: string[] = [];
	vi.stubGlobal("navigator", {
		clipboard: {
			writeText: async (text: string) => {
				written.push(text);
			},
		},
	});
	const button = clickables(ErrorState({ title: "无法加载 Agent", error })).find((element) =>
		textOf(element.props.children).includes(ACTION.copyErrorDetails),
	);
	button?.props.onClick?.();
	await vi.waitFor(() => expect(written).toHaveLength(1));
	return written[0] ?? "";
}

describe("错误状态的「复制错误详情」", () => {
	it("控制面的错误带着它的 details", async () => {
		const error = new ApiError({
			status: 400,
			code: "invalid_request",
			message: "请求不符合接口契约",
			details: [{ path: ["name"], message: "不能为空" }],
			method: "POST",
			path: "/orchestrations",
		});

		const text = await copiedErrorDetails(error);

		expect(text).toContain("POST /api/orchestrations → 400 invalid_request");
		expect(text).toContain("请求不符合接口契约");
		expect(text).toContain('"message": "不能为空"');
	});

	it("不是控制面格式的错误响应（例如代理的 502 页面）只给状态，不把响应体当作详情", async () => {
		const error = new ApiError({
			status: 502,
			code: "http_error",
			message: "HTTP 502",
			details: "<html><body><h1>502 Bad Gateway</h1>nginx</body></html>",
			method: "GET",
			path: "/agents",
		});

		const text = await copiedErrorDetails(error);

		expect(text).toBe("GET /api/agents → 502 http_error\nHTTP 502");
	});
});
