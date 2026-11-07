# 发布

发布把节点包上传到控制面，所有 sfly Agent 都能从控制面安装它。场景锁定节点包的版本：发布新版本不会改变已有的场景，要在场景里手动升级。

## 构建与发布

在项目目录里运行：

```sh
uv run sfly build
uv run sfly publish
```

- `sfly build` 导入项目的模块，收集 `@node`，生成 `dist/<包名>-<版本>.sflypkg`。节点声明有问题（不支持的类型注解、未声明的主指标、依赖里有 `sfly`……）时在这里报错。
- `sfly publish` 先构建再上传，成功时打印 `已发布 <包名>@<版本>`。控制面地址取自 `~/.sfly/agent.env`，`install.sh --dev` 安装的开发机不用传 `--server`。
- 发布后节点包出现在 [节点包管理](/packages) 页面，可以放进场景。Agent 第一次执行它的节点时从控制面安装，依赖从 PyPI 镜像安装。

## 版本号

版本号取 `pyproject.toml` 的 `[project].version`。已发布的 `包名@版本` 不能覆盖，控制面会拒绝；每次发布前递增版本号：

```sh
uv version --bump patch
uv run sfly publish
```

依赖写在 `[project].dependencies` 里，只写宽松的下限（例如 `requests>=2.28`）：Agent 上所有节点包共用一个 venv，钉死版本容易和别的节点包冲突。

## 需要的 SDK 版本

节点在 Agent 自带的 SDK 运行时上执行，SDK 的版本就是 Agent 的版本。节点包元信息里的 `requires_sdk` 声明它需要的 SDK 版本，取自 `pyproject.toml` 的 `[tool.sfly] requires-sdk`：

```toml
[tool.sfly]
requires-sdk = ">=0.0.4"
```

没写时 `sfly build` 用构建时 SDK 的版本作为下限。`sfly init` 生成的项目写的是当时控制面的版本 {{SFLY_VERSION}}；用到新版 SDK 才有的接口时调高它。

Agent 的版本不满足时，控制面不在 Agent 上运行这个节点：任务以 `env_error` 失败，错误信息写明需要的 SDK 版本和 Agent 的版本。Agent 跟随控制面的版本：控制面只给与自己同版本的 Agent 派任务，版本不同的 Agent 会先自更新，所以触发前检查比较的是控制面的版本，不满足时提示升级控制面（升级后 Agent 会自更新）。没有这个字段的旧节点包不检查。

## 在场景里使用新版本

在场景的节点上把版本换成新版本（版本选择旁有「升级到 <版本>」），保存后运行。联调时用的 `dev（开发版本）` 只在本机 Agent 上有，共享的场景要用发布的版本。

## 标准节点包 sfly-std

平台维护的标准节点包 `sfly-std`（Shell 命令、后台进程、监控、等待、日志、产物、HTTP、断言）也是这样发布的：它不随控制面发布，部署者从 GitHub Release 下载 `std-vX.Y.Z` 的附件，像自己的节点包一样上传，场景同样锁定它的版本。下载、校验和上传的步骤见 [标准节点](standard-nodes.md#上传-sfly-std)。
