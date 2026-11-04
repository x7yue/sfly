import { expect } from "vitest";
import type { TestControlPlane } from "./test-control-plane.js";

/** 昵称请求头：值按 encodeURIComponent 编码（浏览器请求头只能放 Latin-1）。 */
export const NICKNAME_HEADER = "x-sfly-nickname";

/** 测试里调用控制面 HTTP API 的小封装。 */
export class ApiClient {
	constructor(private readonly cp: TestControlPlane) {}

	get(path: string): Promise<Response> {
		return this.cp.fetch(path);
	}

	post(path: string, body: unknown, nickname = "tester"): Promise<Response> {
		return this.cp.fetch(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[NICKNAME_HEADER]: encodeURIComponent(nickname),
			},
			body: JSON.stringify(body),
		});
	}

	async getJson<T>(path: string): Promise<T> {
		const res = await this.get(path);
		expect(res.status, `GET ${path}`).toBe(200);
		return (await res.json()) as T;
	}

	async createOrchestration(name: string): Promise<string> {
		const res = await this.post("/orchestrations", { name });
		expect(res.status).toBe(201);
		return ((await res.json()) as { id: string }).id;
	}

	async saveVersion(
		orchestrationId: string,
		document: unknown,
		nickname = "tester",
	): Promise<number> {
		const res = await this.post(
			`/orchestrations/${orchestrationId}/versions`,
			{ document },
			nickname,
		);
		expect(res.status, await res.clone().text()).toBe(201);
		return ((await res.json()) as { number: number }).number;
	}
}
