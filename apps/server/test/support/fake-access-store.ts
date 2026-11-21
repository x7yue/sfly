import type {
	AccessStore,
	AdminWrite,
	StoredAgentCredential,
	StoredLogin,
	StoredToken,
	StoredUser,
} from "../../src/auth/access-store.js";
import type { ProjectRole } from "../../src/db/schema.js";
import type { ProjectId } from "../../src/projects/project-id.js";

/** 内存里的 {@link AccessStore}：访问检查不连数据库的测试用（鉴权模块不依赖 Fastify，也不依赖数据库）。 */
export class FakeAccessStore implements AccessStore {
	readonly tokens = new Map<string, StoredToken>();
	readonly logins = new Map<string, StoredLogin>();
	readonly agentCredentials = new Map<string, StoredAgentCredential>();
	readonly roles = new Map<string, ProjectRole>();
	readonly projects = new Set<string>(["default", "public"]);
	readonly scenarios = new Map<string, ProjectId>();
	readonly runs = new Map<string, ProjectId>();
	readonly tasks = new Map<string, { projectId: ProjectId; agentName: string | null }>();
	readonly adminWrites: AdminWrite[] = [];
	/** 登录用了之后写下的最后使用时间和空闲期限。 */
	readonly touches: { id: string; lastUsedAt: Date; idleExpiresAt: Date }[] = [];
	/** 回填的响应状态码（`completeAdminWrite`）。 */
	readonly adminResults: { id: string; status: number }[] = [];
	/** 每个方法被调用的次数：不需要凭据的请求不该读库。 */
	reads = 0;

	setRole(project: string, user: StoredUser, role: ProjectRole | undefined): void {
		const key = `${project}|${user.id}`;
		if (role === undefined) this.roles.delete(key);
		else this.roles.set(key, role);
	}

	async tokenByHash(hash: string) {
		this.reads++;
		return this.tokens.get(hash);
	}
	async loginByCookieHash(hash: string) {
		this.reads++;
		return this.logins.get(hash);
	}
	async touchLogin(id: string, lastUsedAt: Date, idleExpiresAt: Date) {
		this.touches.push({ id, lastUsedAt, idleExpiresAt });
		for (const login of this.logins.values()) {
			if (login.id === id) Object.assign(login, { lastUsedAt, idleExpiresAt });
		}
	}
	async agentCredentialByHash(hash: string) {
		this.reads++;
		return this.agentCredentials.get(hash);
	}
	async role(project: ProjectId, userId: string) {
		this.reads++;
		return this.roles.get(`${project}|${userId}`);
	}
	async projectExists(project: ProjectId) {
		this.reads++;
		return this.projects.has(project);
	}
	async projectOfScenario(id: string) {
		this.reads++;
		return this.scenarios.get(id);
	}
	async projectOfRun(id: string) {
		this.reads++;
		return this.runs.get(id);
	}
	async projectOfTask(id: string) {
		this.reads++;
		return this.tasks.get(id)?.projectId;
	}
	async taskAssignment(id: string) {
		this.reads++;
		return this.tasks.get(id);
	}
	async recordAdminWrite(write: AdminWrite) {
		this.adminWrites.push(write);
		return `admin-write-${this.adminWrites.length}`;
	}
	async completeAdminWrite(id: string, status: number) {
		this.adminResults.push({ id, status });
	}
}
