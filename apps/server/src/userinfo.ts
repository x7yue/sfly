/**
 * 地址里的用户名和密码（`https://用户名:密码@主机/路径`）：控制面对外公开的地方（不用登录就能读的 `/install.sh`、`/sdk/project-settings`）
 * 不能带它们（#755）。镜像地址（`SFLY_PYPI_MIRROR`、`SFLY_GITHUB_RELEASE_MIRROR`）允许带用户名和密码，私有的索引常这样配，
 * 但这样配的地址只在经过认证的连接上给出（Agent 握手的 Welcome）；公开的地方给去掉了用户名和密码的地址，要认证的由各台机器的
 * `~/.netrc` 给（docs/guide/install-agent.md「带用户名和密码的私有索引」）。
 *
 * 规则和 Agent 里 `mask_userinfo`（agent/src/secret.rs）一样，只认地址形状的 `用户名:密码@`：`://` 之后到第一个 `/`、`?`、`#`、
 * 空白、引号、反引号、`<`、`>`、`\` 为止是主机那一段（authority），其中最后一个 `@` 之前的都是用户名和密码（密码里没有转义的 `@` 也认）；
 * 没有 `@` 的原样；路径、查询里的 `@`（`https://host/pkg@1.0`）不是用户名，不动。Agent 那一边是换成 `***`、留着 `@`，
 * 这里是连 `@` 一起去掉（公开的地址里不留任何痕迹）。两边的样例由 `test/userinfo.test.ts` 对齐（直接读那份 Rust 测试里的表）。
 */
export function withoutUserinfo(text: string): string {
	let out = "";
	// `text.slice(0, copied)` 已经写进 `out` 了。
	let copied = 0;
	let from = 0;
	for (;;) {
		const found = text.indexOf("://", from);
		if (found === -1) break;
		const start = found + "://".length;
		const rest = text.slice(start);
		const stop = rest.search(/[\s/?#"`<>\\]/);
		const end = stop === -1 ? text.length : start + stop;
		const at = text.slice(start, end).lastIndexOf("@");
		if (at !== -1) {
			out += text.slice(copied, start);
			copied = start + at + 1;
		}
		from = Math.max(end, start);
	}
	return copied === 0 ? text : out + text.slice(copied);
}
