// 建会话只认用户的凭据（#547）：会话的测试里，每个昵称是一个登录的用户。`ApiClient` 的每个请求按昵称请求头（`post(path, body, "bob")`
// 里的 `"bob"`，没写是 `tester`）找这个用户的个人令牌带上：第一次用到一个昵称时在库里建这个用户（显示名就是昵称，默认项目里的
// 编辑者；不是平台管理员，不会在 `platform_admin_actions` 里留下记录）和他的个人令牌。测试写法不变，只是 `new ApiClient(cp)`
// 换成 `new ApiClient(asUsers(cp))`。
import { NICKNAME_HEADER } from "@sfly/schema";
import { bearer, TestAccounts } from "./credentials.js";
import type { TestControlPlane } from "./test-control-plane.js";

/** 控制面的 `fetch` 加上「昵称是登录的用户」：请求里没有凭据时按昵称带上个人令牌。 */
export interface UserFetch extends Pick<TestControlPlane, "fetch"> {
	/** 昵称对应的用户 ID（没有就建）。 */
	userId(nickname: string): Promise<string>;
	/** 昵称对应的个人令牌（原值，没有就签）。 */
	token(nickname: string): Promise<string>;
}

export function asUsers(
	cp: Pick<TestControlPlane, "fetch" | "database">,
	/** 用户是编辑者的项目（默认只有默认项目；这里写的项目不存在时先建出来）。 */
	options: { projects?: readonly string[] } = {},
): UserFetch {
	const users = new Map<string, Promise<{ id: string; token: string }>>();
	const user = (nickname: string) => {
		let found = users.get(nickname);
		if (found === undefined) {
			found = (async () => {
				// 每个用户用一个自己的连接池，用完就关：库在测试结束时要删，不能留着空闲的连接。
				const accounts = new TestAccounts(cp.database.url);
				try {
					const id = await accounts.userNamed(nickname);
					for (const project of options.projects ?? ["default"]) {
						await accounts.project(project);
						await accounts.member(project, id, "editor");
					}
					return { id, token: await accounts.personalToken(id) };
				} finally {
					await accounts.close();
				}
			})();
			users.set(nickname, found);
		}
		return found;
	};
	return {
		userId: async (nickname) => (await user(nickname)).id,
		token: async (nickname) => (await user(nickname)).token,
		async fetch(path, init = {}) {
			const headers = new Headers(init.headers);
			// 已经自己带了凭据的请求（测试要用别的凭据）不动。
			if (!headers.has("authorization") && !headers.has("cookie")) {
				const raw = headers.get(NICKNAME_HEADER);
				const nickname = raw === null ? "tester" : decodeURIComponent(raw);
				for (const [name, value] of Object.entries(bearer((await user(nickname)).token))) {
					headers.set(name, value);
				}
			}
			return cp.fetch(path, { ...init, headers });
		},
	};
}
