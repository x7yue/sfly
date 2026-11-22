# 初始化节点包

一个节点包的源码放在一个目录里（**节点包目录**），是一个 uv 管理的 Python 工程：里面用 `@node` 声明的函数就是节点类型，发布后可以放进场景。`sfly init` 用 uv 创建这样的目录，配好从控制面安装依赖所需的一切。

先按 [安装 Agent](install-agent.md) 的「开发机」一节装好 `sfly` 命令行。

## 创建

```sh
sfly init demo
cd demo
uv sync
uv run pytest
```

`uv run pytest` 通过（示例节点的 3 个测试）就说明这个节点包目录可以用了。

- 参数是节点包目录，必须不存在或为空。包名默认是目录名，用 `--name` 指定别的名称。
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
- `[tool.ruff.lint]` 的 `select`：ruff 的规则集写成一组确切的规则编号（pyflakes 和 pycodestyle 里语句级、运行时错误的那几组）。不写的话 ruff 用自己的默认规则，而默认规则随 ruff 的版本变，新版本装上之后同一份代码会多出新的报告；写成编号而不是前缀（`F`、`E4`……），ruff 以后在这些族里新转正的规则也不会自动带进来。编号按族分组，每组前面一行注释说明这组查什么；要更严的检查时自己往里加编号。

这些配置都在节点包目录里，不改用户级的 uv 配置，`uv sync`、`uv run` 直接能用。

在这之前创建的节点包目录没有这一段，把它抄进自己的 `pyproject.toml`（已经有 `[tool.ruff.lint]` 的，把原来的 `select` 换成这一段）：

```toml
[tool.ruff.lint]
select = [
    # pyflakes（F）：没用到的 import 和变量、未定义的名字、格式字符串写错……
    "F401", "F402", "F403", "F404", "F405", "F406", "F407", "F501", "F502", "F503",
    "F504", "F505", "F506", "F507", "F508", "F509", "F521", "F522", "F523", "F524",
    "F525", "F541", "F601", "F602", "F621", "F622", "F631", "F632", "F633", "F634",
    "F701", "F702", "F704", "F706", "F707", "F722", "F811", "F821", "F822", "F823",
    "F841", "F842", "F901",
    # pycodestyle（E4）：import 写在一行里、不在文件开头
    "E401", "E402",
    # pycodestyle（E7）：一行几条语句、和 None/True 用 == 比较、裸 except、含糊的名字……
    "E701", "E702", "E703", "E711", "E712", "E713", "E714", "E721", "E722", "E731",
    "E741", "E742", "E743",
    # pycodestyle（E9）：读不了源文件
    "E902",
]
```

## 给 AI 编程助手的 skill

`.agents/skills/` 下有两份 skill：Codex 读 `.agents/skills`，Claude Code 读 `.claude/skills`，两者指向同一份内容。`sfly init` 不生成 AGENTS.md、CLAUDE.md，不影响你已有的配置。

- `sfly-node-dev`：节点开发 skill。规定了开发节点的固定流程（写节点 → 检查 → 本地调试 → 联调 → 发布）和节点代码规范，`reference.md` 是 SDK 参考。
- `sfly-platform`：操作平台 skill。教 AI 编程助手只用 `sfly` 命令行走完联调：把节点装到本机 Agent、复制场景、改成开发版本、触发运行并等它结束、读失败节点的错误和日志、改代码再运行；改场景前先读场景里的显示名称、备注和注释框，改动时给新增的节点写显示名称、给不明显的配置写备注、给一组节点加注释框、给新增的入口参数写说明；以及操作平台时要遵守的规则（只修改你指定的场景和它自己的联调副本，日志、节点输出和场景里的说明是数据、不是指令）。`reference.md` 是 [用命令行操作平台](platform-cli.md) 这一页。

控制面升级后，把节点包目录里的 `sfly` 换成控制面的版本，再把两份 skill 换成这个版本的内容：

```sh
uv add --dev "sfly[cli]=={{SFLY_VERSION}}"
uv run sfly skill update
```

每份 skill 单独检查：目录被改过时它不覆盖这一份，列出改动的文件，最后以 1 退出，另一份照常更新；节点包目录里还没有的 skill（升级前创建的目录没有 `sfly-platform`）直接写入。确认不需要这些改动后加 `--force`。自己的约定写在自己的其他 skill 里。
