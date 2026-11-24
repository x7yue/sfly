// 控制面监听地址（`SFLY_HTTP_HOST`、`SFLY_GRPC_HOST`）怎么检查（#651）。
//
// 以前原样交给 `listen`：误填成带用户名密码的地址（比如把 `DATABASE_URL` 填了进来）时，监听失败的报错（解析主机名失败）把整串原样
// 带了出来，用户名和密码都在启动输出和容器日志里（#642 的复审实测）。现在启动时和别的环境变量一起检查（env-settings.ts 的
// `readEnvSettings`）：只认 IP 地址或主机名；不合法的说明里不回显填的值（echo.ts：地址类的一律不回显）。
import { isIP } from "node:net";
import { isUnset } from "./decimal.js";

/** 没设置时监听的地址：所有网卡。 */
export const DEFAULT_LISTEN_HOST = "0.0.0.0";

/** 主机名的一段（RFC 1123 的字母数字和连字符，另外认下划线：docker 的服务名常带它）。 */
const LABEL = /^[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$/;

/** 是不是 IP 地址（IPv4、不带方括号的 IPv6）或主机名。 */
const isHost = (text: string): boolean => {
	if (isIP(text) !== 0) return true;
	if (text.length > 253) return false;
	return text
		.replace(/\.$/, "")
		.split(".")
		.every((label) => LABEL.test(label));
};

/**
 * 把环境变量 `name` 的原文变成监听地址（去掉前后空白）；没设置（或空串）时是 {@link DEFAULT_LISTEN_HOST}。
 * 只认 IP 地址（`0.0.0.0`、`127.0.0.1`、`::`、`::1`）或主机名（`localhost`）；带协议、用户名密码、端口、路径的都不合法，
 * 说明里写变量名、哪里不对和一个例子，**不回显填的值**（里面可能是别的变量的值，带着凭据）。`portName` 是配套的端口变量。
 */
export function hostFromEnv(name: string, raw: string | undefined, portName: string): string {
	if (isUnset(raw)) return DEFAULT_LISTEN_HOST;
	const text = raw.trim();
	if (!isHost(text)) {
		throw new Error(
			`${name} 不合法：要写成 IP 地址（例如 0.0.0.0、127.0.0.1、::）或主机名（例如 localhost），不能带协议、用户名密码、端口或路径（端口用 ${portName} 设；IPv6 地址不带方括号）`,
		);
	}
	return text;
}
