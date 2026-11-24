// 会话的事件流（GET /sessions/:id/events）和别的事件流走同一个 `sse.open`，所以被「定期重新检查凭据」（src/sse/stream-recheck.ts，
// #555）覆盖：登录被吊销、令牌被吊销、用户被停用，他的会话事件流在间隔内被关，别人的不受影响。
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bearer, loginCookie, TestAccounts } from "./support/credentials.js";
import { seedSession } from "./support/sessions.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

let cp: TestControlPlane | undefined;
afterEach(async () => {
	await cp?.close();
	cp = undefined;
});

const waitEnded = (stream: SseClient, timeout = 5000) =>
	vi.waitFor(() => expect(stream.ended).toBe(true), { timeout });

describe("会话事件流定期重新检查凭据", () => {
	async function setup() {
		cp = await startTestControlPlane({ streamRecheckMs: 100 });
		const accounts = new TestAccounts(cp.database.url);
		const users: Record<string, string> = {};
		for (const name of ["xiaoming", "xiaohong", "xiaoliang"]) {
			users[name] = await accounts.user(name);
			await accounts.member("default", users[name] as string, "editor");
		}
		const sessionId = await seedSession(cp.database.url, { title: "会话事件流的凭据检查" });
		const open = async (headers: Record<string, string>) => {
			const stream = await SseClient.open(
				cp as TestControlPlane,
				`/sessions/${sessionId}/events`,
				headers,
			);
			await stream.next("time");
			return stream;
		};
		const sql = async (text: string, params: unknown[] = []) => {
			const client = new pg.Client({ connectionString: (cp as TestControlPlane).database.url });
			await client.connect();
			try {
				await client.query(text, params);
			} finally {
				await client.end();
			}
		};
		return { accounts, users, open, sql };
	}

	it("登录被吊销（直接改库，进程内收不到通知）：他的会话事件流在间隔内被关，别人的不受影响", async () => {
		const { accounts, users, open, sql } = await setup();
		const revoked = await open(loginCookie(await accounts.login(users.xiaoming as string)));
		const other = await open(loginCookie(await accounts.login(users.xiaohong as string)));
		await sql("update logins set revoked_at = now() where user_id = $1", [users.xiaoming]);
		await waitEnded(revoked);
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(other.ended).toBe(false);
		other.close();
		await accounts.close();
	});

	it("个人令牌被吊销：用它打开的会话事件流在间隔内被关；用户被停用：他的登录和令牌打开的流都被关", async () => {
		const { accounts, users, open, sql } = await setup();
		const token = await accounts.personalToken(users.xiaoliang as string);
		const byToken = await open(bearer(token));
		const keep = await open(loginCookie(await accounts.login(users.xiaohong as string)));
		await sql("update api_tokens set revoked_at = now() where user_id = $1", [users.xiaoliang]);
		await waitEnded(byToken);
		// 停用用户：他用登录和另一个令牌打开的流都关。
		const second = await accounts.personalToken(users.xiaoming as string);
		const viaToken = await open(bearer(second));
		const viaLogin = await open(loginCookie(await accounts.login(users.xiaoming as string)));
		await sql("update users set disabled_at = now() where id = $1", [users.xiaoming]);
		await waitEnded(viaToken);
		await waitEnded(viaLogin);
		expect(keep.ended).toBe(false);
		keep.close();
		await accounts.close();
	});

	it("会话令牌：会话结束了（直接改库，没有吊销令牌）：用它打开的事件流在间隔内被关，别的会话的令牌的流不受影响", async () => {
		const { accounts, users, sql } = await setup();
		const mine = await accounts.session(users.xiaoming as string, "default", {
			title: "会被结束的会话",
		});
		const keep = await accounts.session(users.xiaohong as string, "default", {
			title: "不动的会话",
		});
		const openFor = async (sid: string, user: string) => {
			const token = await accounts.sessionTokenIn(sid, user, "default");
			const stream = await SseClient.open(
				cp as TestControlPlane,
				`/sessions/${sid}/events`,
				bearer(token),
			);
			await stream.next("time");
			return stream;
		};
		const ended = await openFor(mine, users.xiaoming as string);
		const kept = await openFor(keep, users.xiaohong as string);
		await sql("update sessions set status = 'ended' where id = $1", [mine]);
		await waitEnded(ended);
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(kept.ended).toBe(false);
		kept.close();
		await accounts.close();
	});
});
