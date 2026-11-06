# 快速开始

sfly 是测试编排平台：节点包里用 `@node` 声明的 Python 函数，由测试机上的 **sfly Agent** 执行，在控制面上编排成场景运行。当前控制面的地址是 `{{SFLY_URL}}`，版本 `{{SFLY_VERSION}}`。

只需要一台 Linux（x86_64 或 aarch64，WSL 也可以）和 `curl`。uv、Python、`sfly` 命令行都由安装脚本和 Agent 从控制面和镜像准备好。

## 流程

| 步骤 | 做什么 | 页面 |
|---|---|---|
| 1. 安装 | 在测试机上用一条命令安装 sfly Agent；开发机加 `--dev`，同时装好 `sfly` 命令行 | [安装 Agent](install-agent.md) |
| 2. 初始化 | `sfly init` 创建节点包项目，带示例节点、单元测试和给 AI 编程助手的 skill | [初始化项目](init-project.md) |
| 3. 开发 | 用 `@node` 写节点，`ctx` 上报日志、进度、指标、产物 | [开发节点（SDK 参考）](sdk-reference.md) |
| 4. 本地调试 | 单元测试和 `sfly run`：在开发机上直接执行节点，不经过控制面和 Agent | [本地调试](local-debug.md) |
| 5. 联调 | `sfly dev` 把项目以开发版本装到本机 Agent，在真实场景里运行 | [联调](integration.md) |
| 6. 发布 | `sfly publish` 发布到控制面，场景锁定版本使用 | [发布](publish.md) |

用 Claude Code、Codex 这类 AI 编程助手开发时，从 [AI 编程助手快速开始](ai-quickstart.md) 复制提示词交给它。

## 读取原文

每一页都有 Markdown 原文，地址已经填好当前控制面，可以直接用 `curl` 读取；全部页面的地址列在索引里：

```sh
curl -s {{SFLY_URL}}/llms.txt
```

| 地址 | 内容 |
|---|---|
| `/llms.txt` | 全部页面的原文地址 |
| `/docs/<页>.md` | 一页的 Markdown 原文，例如 `/docs/install-agent.md` |

已发布的节点包见 [节点包管理](/packages) 页面，在线的 Agent 见 [Agent 管理](/agents) 页面。
