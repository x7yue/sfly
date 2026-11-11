import { createServer, type Socket } from "node:net";
import { agentBinary } from "./agent-binary.js";
import { FakeAgent } from "./fake-agent.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./real-agent.js";

/**
 * Agent 能力的全栈测试（ADR 0019）：同一台机器上的两台真实 Agent，各有自己的主目录、共享 venv（只装 SDK 运行时，
 * 节点包由 Agent 从控制面下载）和供其它 Agent 连接的端口（系统分配，随 Hello 上报）。`runner` 上的节点访问 `source`。
 * 两台在同一台机器上，所以「source 上的文件」就是测试自己建的临时文件，绝对路径相同。
 */
export interface AgentPair {
	runner: RealAgent;
	source: RealAgent;
	close(): Promise<void>;
}

export async function startAgentPair(options: {
	grpcUrl: string;
	runner: string;
	source: string;
	/** runner 额外的命令行参数（例如 sfly dev 用的 --index-url）。 */
	runnerArgs?: string[];
}): Promise<AgentPair> {
	const bin = agentBinary();
	const venvs = await Promise.all([
		createStubVenv({ sdkOnly: true }),
		createStubVenv({ sdkOnly: true }),
	]);
	const [runnerVenv, sourceVenv] = venvs;
	const agents = await Promise.all([
		startRealAgent({
			grpcUrl: options.grpcUrl,
			name: options.runner,
			venv: runnerVenv?.path,
			args: options.runnerArgs ?? [],
			bin,
		}),
		startRealAgent({ grpcUrl: options.grpcUrl, name: options.source, venv: sourceVenv?.path, bin }),
	]);
	const [runner, source] = agents as [RealAgent, RealAgent];
	return {
		runner,
		source,
		close: async () => {
			await Promise.all(agents.map((a) => a.close()));
			await Promise.all(venvs.map((v) => v.remove()));
		},
	};
}

/**
 * 注册在控制面上、但能力调用不通的「另一台 Agent」（假 Agent，只注册、上报端口）：
 * `gone` 的端口没人监听（连不通），`silent` 的端口接受连接但从不回应（超时、取消）。
 */
export interface BrokenPeers {
	gonePort: number;
	silentPort: number;
	close(): Promise<void>;
}

export async function registerBrokenPeers(
	grpcUrl: string,
	names: { gone: string; silent: string },
): Promise<BrokenPeers> {
	const sockets: Socket[] = [];
	const silent = createServer((socket) => sockets.push(socket));
	await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
	const silentPort = (silent.address() as { port: number }).port;
	const released = createServer();
	await new Promise<void>((resolve) => released.listen(0, "127.0.0.1", resolve));
	const gonePort = (released.address() as { port: number }).port;
	await new Promise((resolve) => released.close(resolve));
	const fakes = [
		await FakeAgent.connect(grpcUrl, { name: names.gone, peer: { port: gonePort } }),
		await FakeAgent.connect(grpcUrl, { name: names.silent, peer: { port: silentPort } }),
	];
	return {
		gonePort,
		silentPort,
		close: async () => {
			await Promise.all(fakes.map((f) => f.disconnect()));
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => silent.close(resolve));
		},
	};
}
