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

## 在场景里使用新版本

在场景的节点上把版本换成新版本（版本选择旁有「升级到 <版本>」），保存后运行。联调时用的 `dev（开发版本）` 只在本机 Agent 上有，共享的场景要用发布的版本。
