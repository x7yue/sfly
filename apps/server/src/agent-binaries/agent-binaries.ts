import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { AgentArch } from "@sfly/schema";

/**
 * 控制面提供下载的 Agent 二进制（ADR 0011）：与控制面同版本的 x86_64 / aarch64 musl 静态二进制。
 * 打包后的控制面读 main.mjs 旁边的 `agent/<架构>/sfly-agent`，开发时读仓库的 cargo 构建产物（src/main.ts）。
 *
 * 文件在每次请求时检查（开发时会被重新构建）：不存在的架构不提供；sha256 按文件的修改时间和大小缓存。
 */
export type AgentBinaryFiles = Partial<Record<AgentArch, string>>;

export interface AgentBinary {
	arch: AgentArch;
	version: string;
	sha256: string;
	/** 绝对路径。 */
	file: string;
}

/** 列出的顺序。 */
const ARCHES: readonly AgentArch[] = ["x86_64", "aarch64"];

export class AgentBinaries {
	readonly #files: AgentBinaryFiles;
	readonly #version: string;
	readonly #hashes = new Map<string, { key: string; sha256: string }>();

	constructor(files: AgentBinaryFiles, version: string) {
		this.#files = files;
		this.#version = version;
	}

	/** 现有的 Agent 二进制。 */
	async list(): Promise<AgentBinary[]> {
		const binaries: AgentBinary[] = [];
		for (const arch of ARCHES) {
			const file = this.#files[arch];
			if (!file) continue;
			const sha256 = await this.#sha256(file);
			if (sha256) binaries.push({ arch, version: this.#version, sha256, file });
		}
		return binaries;
	}

	async find(version: string, arch: string): Promise<AgentBinary | undefined> {
		return (await this.list()).find((b) => b.version === version && b.arch === arch);
	}

	async #sha256(file: string): Promise<string | undefined> {
		const info = await stat(file).catch(() => undefined);
		if (!info?.isFile()) return undefined;
		const key = `${info.mtimeMs}:${info.size}`;
		const cached = this.#hashes.get(file);
		if (cached?.key === key) return cached.sha256;
		const sha256 = createHash("sha256")
			.update(await readFile(file))
			.digest("hex");
		this.#hashes.set(file, { key, sha256 });
		return sha256;
	}
}

/** Agent 二进制的下载地址（对 Agent 可见）。 */
export const agentBinaryUrl = (
	publicHttpUrl: string,
	binary: Pick<AgentBinary, "version" | "arch">,
) => `${publicHttpUrl}/agent/binaries/${encodeURIComponent(binary.version)}/${binary.arch}`;
