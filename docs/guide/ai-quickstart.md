# AI 编程助手快速开始

把下面的提示词复制给 AI 编程助手（Claude Code、Codex 等），在「需求：」后面写上节点要做什么：

```text
先运行 `curl -s {{SFLY_URL}}/docs/ai-quickstart.md` 读取 sfly 节点开发指引，按指引开发一个 sfly 节点包。

需求：
```

---

以下是给 AI 编程助手的指引。

你在用户的开发机上开发一个 sfly 节点包：用 `@node` 声明的 Python 函数，发布到控制面 `{{SFLY_URL}}`（版本 {{SFLY_VERSION}}）后，由测试机上的 sfly Agent 在场景里执行。按顺序完成下面的步骤，每一步达到「完成」再做下一步。其他文档的原文地址列在 `{{SFLY_URL}}/llms.txt`。

## 1. 检查环境

```sh
uname -sm
sfly --version
```

完成：`uname` 输出 `Linux x86_64` 或 `Linux aarch64`（其他系统：告诉用户 sfly 只支持 Linux 和 WSL，然后停下）。`sfly --version` 输出 `sfly {{SFLY_VERSION}}` 时跳到第 3 步，否则做第 2 步。

## 2. 安装 Agent 和 sfly 命令行

```sh
curl -fsSL {{SFLY_URL}}/install.sh | sh -s -- --dev
export PATH="$HOME/.local/bin:$PATH"
```

这台机器上会装好联调用的 sfly Agent（名称默认 `dev-<用户名>-<主机名>`，主机名不带域名）、uv 和 `sfly` 命令行。之后每个新开的终端都先执行上面的 `export`。

安装输出里有「前台启动」（这台机器没有 systemd）时，在后台启动 Agent：

```sh
nohup ~/.sfly/bin/sfly-agent >~/.sfly/agent.log 2>&1 &
```

Agent 首次启动要准备 uv、Python 和共享 venv，需要一两分钟。用下面的命令确认：

```sh
sfly --version
curl -s {{SFLY_URL}}/agents
```

完成：`sfly --version` 输出 `sfly {{SFLY_VERSION}}`，Agent 列表里 `dev-<用户名>-<主机名>` 的 `status` 是 `online`。

Agent 一直不在线时看它的日志（`~/.sfly/agent.log`，或 `journalctl --user -u sfly-agent`）：

- 有 `invalid agent token`：控制面要求注册令牌。向用户索取令牌，用环境变量传给安装脚本重新运行：`curl -fsSL {{SFLY_URL}}/install.sh | SFLY_TOKEN='<令牌>' sh -s -- --dev`（令牌不出现在进程列表里）。令牌只出现在这条命令里，不要写进项目文件。
- Agent 以退出码 78 退出：运行环境准备失败，把日志里的报告交给用户，让用户转给平台管理员，然后停下。

## 3. 创建项目

已经在 `sfly init` 创建的项目里（有 `.agents/skills/sfly-node-dev/`）时跳过这一步。否则按需求取一个包名（小写字母、数字、`-`、`_`，全局唯一，发布后不能改），替换下面的 `demo`：

```sh
sfly init demo
cd demo
uv sync
uv run pytest
```

完成：`uv run pytest` 全部通过。

## 4. 读取节点开发 skill

完整读一遍项目里的 `.agents/skills/sfly-node-dev/SKILL.md`：它规定了写节点、检查、本地调试、联调、发布每一步的完成标准和节点代码规范。同目录的 `reference.md` 是 SDK 参考，需要接口细节时查它。命令参数以 `uv run sfly <命令> --help` 为准。

完成：读完 SKILL.md，下面的步骤都按它执行。

## 5. 写节点

按需求在 `src/<模块>/` 里写节点和单元测试，遵守 SKILL.md 的规则。示例节点 `countdown`（`example.py` 和 `tests/test_example.py`）可以照着写，需求用不上时删掉。

```sh
uv run ruff format
uv run ruff check
uv run pytest
```

完成：三条命令全部通过，每个节点都有成功路径和失败路径的单元测试。

## 6. 本地调试

对每个节点用接近真实的参数运行（把 `countdown` 和参数换成你的节点）：

```sh
uv run sfly run countdown --params '{"name": "世界"}'
```

完成：输出、日志、指标、产物都符合预期；失败路径（错误参数、节点抛出异常、Ctrl-C 取消）各至少跑过一次。

## 7. 联调

节点要连真实的被测系统，或者要验证和上下游节点的配合时做这一步：

```sh
uv run sfly dev
```

然后请用户在控制面的场景里把这个节点包的版本选为 `dev（开发版本）`、Agent 选 `dev-<用户名>-<主机名>`，运行后把结果告诉你。

完成：用户确认运行结果符合预期。

## 8. 发布

已发布的 `包名@版本` 不能覆盖。发布前把包名、`[project].version` 和改动摘要交给用户，等用户明确同意后再运行：

```sh
uv run sfly publish
```

完成：输出 `已发布 <包名>@<版本>`。版本已存在时用 `uv version --bump patch` 递增版本号，再请用户确认一次。
