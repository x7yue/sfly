# 开发文档

控制面自带用户文档（`docs/guide`），由「开发文档」页渲染，文中的控制面地址和版本号会替换成当前实例的值。同一套文档还以原始 Markdown 的形式提供给 AI 工具：`/docs/<页>.md`、`/llms.txt`，以及两份 skill：节点开发 `/docs/skills/sfly-node-dev/`、操作平台 `/docs/skills/sfly-platform/`。

## Sub-features

- `doc-page`：文档页渲染标题、列表、表格和链接，左侧是 `navigation "文档目录"`。
- `doc-substitute`：文中的 `{{SFLY_VERSION}}` 和控制面地址替换成当前实例的值。
- `doc-raw`：`/docs/<slug>.md` 原文，`/llms.txt` 列出全部页面和 skill 文件。

## How to get to it (user POV)

- 侧边栏「开发文档」，进入 `/docs`，再从「文档目录」进入各页，例如「快速开始」。
- 浏览器或 AI 工具里直接请求 `$HTTP_URL/llms.txt`、`$HTTP_URL/docs/quickstart.md`。

## Driving it with agent-browser

Preconditions:

- 基线环境。

- **进入文档。** 在任意页面运行 `find role link click --name "开发文档"`（它在 `navigation "主导航"` 里），能看到 `navigation "文档目录"`；点「快速开始」，`article "快速开始"` 里有 h1「快速开始」。截图 `doc-01-quickstart.png`。
- **替换。** 页面里的控制面地址就是 `$HTTP_URL`，版本号是工作区版本，不会出现 `{{` 占位符。
- **原文。** `curl -s $HTTP_URL/docs/quickstart.md | grep -c "$HTTP_URL"` 的结果大于 0；`curl -s $HTTP_URL/llms.txt` 里每页都有一行 `($HTTP_URL/docs/<slug>.md)`，还有 `sfly-node-dev/SKILL.md` 和 `sfly-platform/SKILL.md`。结果存到 `$RUN/evidence/doc-llms.txt`。

## Gotchas

- 控制面读的是仓库里的 `docs/guide`（`SFLY_DOCS_DIR` 的默认值），改了文档刷新页面就能看到，不用重新构建；页面顺序和标题在 `docs/guide/pages.json` 里。
- 地址替换用的是 `SFLY_PUBLIC_URL`，`up.sh` 把它设成了 `$HTTP_URL`。所以文档里出现的是 127.0.0.1 加随机端口，不是 8080。
