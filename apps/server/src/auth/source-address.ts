// 限速用的「来源地址」归一（ADR 0029「认证的几处细节」，PR #555 的差异复审）。
//
// 来源地址来自 TCP 对端，或信任代理时 `X-Forwarded-For` 里可信代理之前的那一段（../http/trust-proxy.ts）。代理追加的段里
// 可能带端口（`10.9.9.9:5555`、`[2001:db8::1]:443`），IPv6 的一个用户通常拿到一整个 /64：按原样当键的话，
// 同一个人换个端口、换个 /64 里的地址就能每次重新开始计数，限速形同虚设。所以键用归一后的写法：
// - 去掉端口和方括号、区域标识（`%eth0`）；
// - IPv4 映射的 IPv6（`::ffff:10.9.9.9`，双栈监听时 Node 给的写法）就是那个 IPv4；
// - 其余的 IPv6 按 /64 归在一起（前 64 位，写成 `2001:db8:1:2::/64`）；
// - 认不出的值原样当键：不同的值是不同的来源，不会被归到一起（偏向多拦）。
import { isIP } from "node:net";

/** 把地址展开成 8 组 16 位数；认不出返回 undefined。 */
function groupsOf(address: string): number[] | undefined {
	let text = address.toLowerCase();
	// 末尾的内嵌 IPv4（`::ffff:10.9.9.9`）换成两组十六进制。
	const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
	if (dotted) {
		const octets = dotted.slice(1, 5).map(Number);
		if (octets.some((octet) => octet > 255)) return undefined;
		const [a = 0, b = 0, c = 0, d = 0] = octets;
		text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const [head = "", tail, ...rest] = text.split("::");
	if (rest.length > 0) return undefined;
	const parse = (part: string): number[] | undefined => {
		if (part === "") return [];
		const groups = part
			.split(":")
			.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : -1));
		return groups.includes(-1) ? undefined : groups;
	};
	const before = parse(head);
	const after = tail === undefined ? [] : parse(tail);
	if (before === undefined || after === undefined) return undefined;
	if (tail === undefined) return before.length === 8 ? before : undefined;
	const zeros = 8 - before.length - after.length;
	return zeros < 1 ? undefined : [...before, ...new Array<number>(zeros).fill(0), ...after];
}

/** 限速用的来源地址键（见文件头）。 */
export function throttleAddress(raw: string): string {
	let text = raw.trim();
	const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
	if (bracketed) text = bracketed[1] ?? text;
	else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(text)) text = text.slice(0, text.lastIndexOf(":"));
	const zone = text.indexOf("%");
	if (zone !== -1) text = text.slice(0, zone);
	const version = isIP(text);
	if (version === 4) return text;
	if (version === 6) {
		const groups = groupsOf(text);
		if (groups === undefined) return raw;
		const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
		if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
			return `${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`;
		}
		return `${[g0, g1, g2, g3].map((group) => group.toString(16)).join(":")}::/64`;
	}
	return raw;
}
