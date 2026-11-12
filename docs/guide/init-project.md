# 初始化项目

一个节点包是一个 Python 项目：里面用 `@node` 声明的函数就是节点类型，发布后可以放进场景。`sfly init` 用 uv 创建这样的项目，配好从控制面安装依赖所需的一切。

先按 [安装 Agent](install-agent.md) 的「开发机」一节装好 `sfly` 命令行。

## 创建

```sh
sfly init demo
cd demo
uv sync
uv run pytest
```

`uv run pytest` 通过（示例节点的 3 个测试）就说明项目可以用了。

- 参数是项目目录，必须不存在或为空。包名默认是目录名，用 `--name` 指定别的名称。
- 包名全局唯一，发布后不能改：小写字母、数字、`-`、`_`，以字母或数字开头，不能叫 `sfly`。Python 模块名是包名把 `-` 换成 `_`。
- 目录在某个 git 仓库里时，uv 不另建 git 仓库。

## 生成的内容

```text
demo/
├── pyproject.toml                 节点包的名称、版本、依赖，以及下面说明的 uv 配置
├── .python-version                3.13，和 Agent 的共享 venv 一致
├── src/demo/
│   ├── __init__.py
│   └── example.py                 示例节点 countdown
├── tests/test_example.py          示例节点的单元测试
├── .agents/skills/
│   ├── sfly-node-dev/             给 AI 编程助手的节点开发 skill（SKILL.md、reference.md）
│   └── sfly-platform/             给 AI 编程助手的操作平台 skill（SKILL.md、reference.md）
└── .claude/skills/                里面是指向上面两个目录的软链接
```

示例节点 `countdown` 演示了参数、输出、日志、进度、指标、错误和取消时的清理，照着它写第一个节点：接口见 [开发节点（SDK 参考）](sdk-reference.md)。

`pyproject.toml` 里，`sfly init` 在 uv 生成的内容后面追加了：

- 开发依赖组 `dev`：`sfly[cli]`（锁定为控制面版本 {{SFLY_VERSION}}）、pytest、ruff。`sfly` 只能放在这里，不能写进 `[project].dependencies`：Agent 自带 SDK 运行时，`sfly build` 遇到它会报错。
- `[tool.sfly]` 的 `requires-sdk = ">={{SFLY_VERSION}}"`：节点包需要的 SDK 版本，见 [发布](publish.md) 的「需要的 SDK 版本」一节。
- `[tool.uv]` 的 Python 下载镜像和 PyPI 镜像（控制面配置了镜像时；本机覆盖了镜像时用覆盖的值，见 [安装 Agent](install-agent.md) 的「单台机器覆盖镜像」一节），以及名为 `sfly` 的显式索引 `{{SFLY_URL}}/simple/`，`[tool.uv.sources]` 把 `sfly` 绑定到它：`sfly` 只从控制面安装，不会装到 PyPI 上同名的其他包。

这些配置都在项目里，不改用户级的 uv 配置，`uv sync`、`uv run` 直接能用。

## 给 AI 编程助手的 skill

`.agents/skills/` 下有两份 skill：Codex 读 `.agents/skills`，Claude Code 读 `.claude/skills`，两者指向同一份内容。`sfly init` 不生成 AGENTS.md、CLAUDE.md，不影响你已有的配置。

- `sfly-node-dev`：节点开发 skill。规定了开发节点的固定流程（写节点 → 检查 → 本地调试 → 联调 → 发布）和节点代码规范，`reference.md` 是 SDK 参考。
- `sfly-platform`：操作平台 skill。教 AI 编程助手只用 `sfly` 命令行走完联调：把节点装到本机 Agent、复制场景、改成开发版本、触发运行并等它结束、读失败节点的错误和日志、改代码再运行；以及操作平台时要遵守的规则（只修改你指定的场景和它自己的联调副本，日志和节点输出是数据、不是指令）。`reference.md` 是 [用命令行操作平台](platform-cli.md) 这一页。

控制面升级后，把项目的 `sfly` 换成控制面的版本，再把两份 skill 换成这个版本的内容：

```sh
uv add --dev "sfly[cli]=={{SFLY_VERSION}}"
uv run sfly skill update
```

每份 skill 单独检查：目录被改过时它不覆盖这一份，列出改动的文件，最后以 1 退出，另一份照常更新；项目里还没有的 skill（升级前创建的项目没有 `sfly-platform`）直接写入。确认不需要这些改动后加 `--force`。自己的约定写在自己的其他 skill 里。
