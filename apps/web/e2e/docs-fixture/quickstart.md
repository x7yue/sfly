# 快速开始

sfly 节点包里的 `@node` 函数由测试机上的 **sfly Agent** 执行。当前控制面是 `{{SFLY_URL}}`，版本 {{SFLY_VERSION}}。

## 步骤

1. 安装 Agent，见 [安装 Agent](install-agent.md)。
2. 初始化项目：
   - 写节点
   - 写单元测试
3. 发布节点包。

```sh
curl -fsSL {{SFLY_URL}}/install.sh | sh -s -- --name agent-1
sfly init demo-checks --server {{SFLY_URL}} --version {{SFLY_VERSION}} --with-a-rather-long-flag-to-scroll-horizontally
```

| 命令 | 作用 |
|---|---|
| `sfly run` | 本地调试一个节点 |
| `sfly dev` | 在本机 Agent 上联调 |

### 更多

在 [节点包管理](/packages) 页面查看已发布的节点包，或读 [Python 文档](https://docs.python.org/3/)。
