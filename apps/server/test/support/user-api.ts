// 会话的测试里，每个昵称是一个登录的用户（#547）：控制面的 `fetch` 本来就按昵称请求头带上这个用户的个人令牌（#493，
// `TestUsers`），这里只多给出用户 ID 和令牌，并让用户也成为别的项目的编辑者。
import { nicknameIn } from "./credentials.js";
import type { TestControlPlane } from "./test-control-plane.js";

/** 控制面的 `fetch`，加上昵称对应的用户。 */
export interface UserFetch extends Pick<TestControlPlane, "fetch"> {
	/** 昵称对应的用户 ID（没有就建）。 */
	userId(nickname: string): Promise<string>;
	/** 昵称对应的个人令牌（原值，没有就签）。 */
	token(nickname: string): Promise<string>;
}

export function asUsers(
	cp: Pick<TestControlPlane, "fetch" | "users">,
	/** 默认项目之外，用户还是编辑者的项目（不存在时先建出来）。 */
	options: { projects?: readonly string[] } = {},
): UserFetch {
	const joined = new Map<string, Promise<void>>();
	const join = (nickname: string) => {
		let found = joined.get(nickname);
		if (found === undefined) {
			found = (async () => {
				for (const project of options.projects ?? []) {
					if (project !== "default") await cp.users.joinProject(nickname, project, "editor");
				}
			})();
			joined.set(nickname, found);
		}
		return found;
	};
	return {
		async userId(nickname) {
			await join(nickname);
			return (await cp.users.user(nickname)).id;
		},
		async token(nickname) {
			await join(nickname);
			return cp.users.token(nickname);
		},
		async fetch(path, init = {}) {
			const nickname = nicknameIn(new Headers(init.headers));
			if (nickname !== undefined) await join(nickname);
			return cp.fetch(path, init);
		},
	};
}
