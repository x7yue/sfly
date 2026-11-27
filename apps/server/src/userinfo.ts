/**
 * 地址里的用户名和密码（`https://用户名:密码@主机/路径`）：控制面对外公开的地方（不用登录就能读的 `/install.sh`、`/sdk/project-settings`）
 * 不能带它们（#755）。镜像地址（`SFLY_PYPI_MIRROR`、`SFLY_GITHUB_RELEASE_MIRROR`）允许带用户名和密码，私有的索引常这样配；
 * 公开的地方给去掉了用户名和密码的地址，要认证的由各台机器的 `~/.netrc` 给（docs/guide/install-agent.md「带用户名和密码的私有索引」）。
 * 带凭据的原值只在 Agent 握手的 Welcome 里下发（那里是不是经过认证见 docs/guide/install-agent.md：过渡期没配共享令牌时，
 * 连得上 Agent 网关、又知道旧方式登记的名字的连接也拿得到；#494 之后只给带 Agent 凭据的连接）。
 *
 * **按「单个地址」去用户名和密码，不在文字里找地址**：镜像是一个完整的地址（启动检查放行的写法，见 config/url-setting.ts），
 * 不是一段夹着别的字的文字。**同一个地址有两种读法，公开出去的地址在两种读法下都不能有用户名和密码：**
 * - **WHATWG（URL 解析器、uv 用的 Rust `url`）**：http、https 地址的主机段（authority）到第一个 `/`、`\`、`?`、`#` 为止
 *   （`\` 在特殊协议里当 `/` 用），其中最后一个 `@` 之前的都是用户名和密码，**不管它们长什么样**（`"`、反引号、`<`、`>`、空白、换行、
 *   不换行空格、全角空格都在里面：解析器放行、uv 也认，在文字里找地址的规则遇到它们会提前停下、把地址原样公开）；解析器先删掉的制表符、
 *   回车、换行这里也先删掉。{@link publicAddress} 先按这个读法去。这和 Agent 的 `without_userinfo`（agent/src/secret.rs）的区别：
 *   Agent 那边只在 `/`、`?`、`#` 结束，不把 `\` 当分隔符。
 * - **curl、wget**（`install.sh` 里从镜像下载 uv、Agent 用 GitHub Release 镜像下载）：主机段**只到第一个 `/`、`?`、`#` 为止，`\` 不是分隔符**，
 *   所以 `https://CORP\jdoe:Sec7@nexus.corp/x` 在 WHATWG 里主机是 `corp`（没有用户名密码），curl 读成用户名 `CORP\jdoe`、密码 `Sec7`
 *   并发出去（AD 风格的 `域\用户名` 就是这样）。所以去完之后还要再按这个读法查一遍：`://` 之后到第一个 `/`、`?`、`#` 之间还有 `@`，
 *   这个地址就不公开。
 *
 * **兜底**：去完之后再用 `new URL()` 解析一遍，用户名和密码必须都是空的；解析不了、或者 curl 的读法下还有 `@`，这个地址就**不公开**
 * （{@link publicAddress} 返回 undefined，调用方当没配）。这样公开不公开只取决于「两种读法下有没有用户名和密码」，不取决于它们长什么样。
 * 没有用户名和密码位置的本地目录的绝对路径（`/mnt/mirror/pypi/simple`，启动检查也认）原样；`file://` 地址也先解析一遍。
 * 启动检查只放行 http、https、file 和绝对路径，别的写法一律不公开。已知会多扣的：`//nfs/…` 这样以两个 `/` 开头的写法
 * （不是绝对路径，当作认不出的写法不公开）。
 */
export function publicAddress(address: string): string | undefined {
	// URL 解析器在解析之前先删掉输入里所有的制表符、回车和换行（它们不是地址的一部分）。
	const text = address.replace(/[\t\n\r]/g, "");
	if (text === "") return text;
	// 绝对路径：没有主机，没有用户名和密码的位置（`//…` 不是路径，往下走，认不出就不公开）。
	if (text.startsWith("/") && !text.startsWith("//")) return text;
	const http = /^https?:\/\//i.exec(text);
	// 启动检查只放行 http、https、file 和绝对路径；别的写法（走不到这里，除非直接给控制面传选项）一律不公开，不去猜它长什么样。
	if (!http && !/^file:\/\//i.test(text)) return undefined;
	let shown = text;
	if (http) {
		const rest = text.slice(http[0].length);
		// WHATWG 的读法：主机段到第一个 / \ ? # 为止。
		const end = rest.search(/[/\\?#]/);
		const authority = end === -1 ? rest : rest.slice(0, end);
		const at = authority.lastIndexOf("@");
		if (at !== -1) shown = http[0] + rest.slice(at + 1);
		// curl、wget 的读法：主机段到第一个 / ? # 为止，`\` 不是分隔符；这样读还有 @，说明有用户名和密码躲在 `\` 后面。
		const shownRest = shown.slice(http[0].length);
		const curlEnd = shownRest.search(/[/?#]/);
		if ((curlEnd === -1 ? shownRest : shownRest.slice(0, curlEnd)).includes("@")) return undefined;
	}
	try {
		const url = new URL(shown);
		if (url.username !== "" || url.password !== "") return undefined;
	} catch {
		return undefined;
	}
	return shown;
}
