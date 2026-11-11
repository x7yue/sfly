# 发布节点包

用户在节点包项目里用 `sfly publish` 把节点包上传到控制面，然后在「节点包管理」页看到包、版本和节点类型。已经发布过的 `包名@版本` 不能覆盖。

## Sub-features

- `pkg-publish`：`sfly publish <项目目录>` 先构建再上传，打印 `已发布 <包名>@<版本>（sha256 …）`。
- `pkg-list`：节点包管理页列出各包的最新版本。
- `pkg-detail`：详情里有版本、sha256、被锁定的场景数，以及节点类型的输入和输出。
- `pkg-duplicate`：重复发布同一版本会被控制面拒绝。

## How to get to it (user POV)

- 终端：在项目目录里运行 `uv run sfly publish`，或者 `uv run sfly publish <目录> --server <控制面地址>`。
- 侧边栏「节点包管理」，也就是 `/packages`。
- 控制台首页的「最近发布的节点包」表格。

## Driving it with agent-browser

Preconditions:

- 基线环境，还没有发布过任何包。这一步本身就是基线里的发布。

- **发布。** 运行 `$V/publish-stub.sh`，应该看到退出码 0，输出 `已发布 sfly-stub@0.1.0（sha256 <64 位十六进制>）`，同时写进 `evidence/publish-stub-package.txt`。
- **列表。** 先 `agent-browser $S open "$HTTP_URL/packages"`，再 `agent-browser $S snapshot -i -c`：`navigation "节点包"` 下面有指向 `sfly-stub 0.1.0` 的链接。
- **详情。** 点这个链接，URL 变成 `/packages?name=sfly-stub`。`region "sfly-stub 详情"` 里应该有 `0.1.0 最新`，`table "节点类型"` 里有 `echo 回显` 这类行，`dd` 里是 64 位的 sha256，和发布时打印的一致。
- **重复发布。** 再运行一次 `$V/publish-stub.sh`，应该是非零退出码，并提示版本已存在。列表里还是只有 1 个版本。
- **证据。** 截图 `pkg-01-list.png`、`pkg-02-detail.png`，再存 `curl -s $HTTP_URL/api/packages > $RUN/evidence/pkg-packages.json`。

## Gotchas

- `sfly publish` 不传 `--server` 时，读的是 `$SFLY_SERVER` 或 `~/.sfly/agent.env`，可能发到开发者自己的控制面。一定要显式传 `--server "$HTTP_URL"`，脚本已经这样做了。
- 发布成功只说明控制面收下了。Agent 第一次执行这个包里的节点时才安装它，安装结果要到 Agent 管理页或 `/api/agents` 的 `installed_packages` 里看。
- 想发布一个新包又不改 `testdata`，就把项目复制到 `$RUN` 下，用 `uv version --bump patch` 改版本号，再用 `publish-stub.sh "" <副本目录>` 发布。
