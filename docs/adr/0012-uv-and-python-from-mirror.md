# uv 和 Python 跟随镜像站的最新版本，镜像地址由控制面统一下发

Agent 机器上的 uv 和 Python 解释器不随 sfly 打包，也不固定版本：没有 uv 时用 GitHub Release 镜像（例如中科大 `github-release`）上的 `uv-installer.sh` 装到 `~/.sfly/bin`，只在 Agent 安装后和 Agent 自更新后执行一次 `uv self update`；共享 venv 不存在时用 `uv venv --python 3.13` 创建，Python 从同一镜像下载，之后不主动升级 Python，交给 uv 或用户。控制面统一配置 PyPI 镜像和 GitHub Release 镜像，在 Welcome 里下发，`sfly init` 生成的项目也写入同样的镜像配置，改一处对所有 Agent 和新项目生效。环境准备失败时 Agent 以固定退出码退出并打印完整输出，让用户报告问题，不带着坏环境继续连接。

## Considered Options

- **uv 和 python-build-standalone 打进控制面镜像**：镜像大约多 100 MB；python-build-standalone 每个版本都覆盖所有在维护的 Python 版本，venv 应该跟着它的最新补丁版走，打包反而把补丁版冻结在发版时。
- **固定 uv 版本**：每个 uv 版本都写死了自己要下载的 python-build-standalone 版本，而中科大只镜像最新的一个版本；python-build-standalone 更新后，固定版本的 uv 就下载不到 Python 了。
- **控制面生成 `python-downloads.json`**：能解开 uv 与 Python 构建的版本绑定，但在 uv 跟随最新版之后没有必要。

## Consequences

- Agent 必须先连上控制面拿到镜像配置，才能准备 uv 和 venv。
- 不同时间安装的 Agent 可能用着不同的 uv 和 Python 补丁版本。
- `sfly` SDK 不在 PyPI 上：控制面提供一个只含 `sfly` 的简单索引，项目里用 uv 的显式索引把 `sfly` 绑定到它，避免从 PyPI 镜像装到同名的其他包。

## 修订

「执行 `uv self update`」改为：控制面配置了 GitHub Release 镜像时，重新运行镜像上的 `astral-sh/uv/LatestRelease/uv-installer.sh`（与首次安装 uv 相同，`UV_DOWNLOAD_URL` 指向镜像），没有配置时才执行 `uv self update`。原因：`uv self update` 要用镜像时得设 `UV_INSTALLER_GITHUB_BASE_URL`，设了之后 uv 会去访问镜像主机上的 GitHub API（`api.<主机>/repos/astral-sh/uv/releases`），中科大 `github-release` 这类只镜像文件的站点上不存在；而 `uv self update` 内部本来也是下载并运行这个安装脚本。时机不变：Agent 安装后和自更新后的首次启动各一次，失败但旧 uv 可用时只告警。

单台机器可以在本机覆盖下发的镜像（#72）：Agent 的 `SFLY_INDEX_URL`、`SFLY_GITHUB_RELEASE_MIRROR`、`SFLY_PYTHON_INSTALL_MIRROR`（命令行 > 环境变量 > `agent.env` > 控制面下发），install.sh 写进 `agent.env`、`sfly init` 读取同样的来源；控制面仍只配置两项，Python 下载镜像只能在本机单独覆盖（默认从 GitHub Release 镜像推导）。原因：uv 把发行版名写进 User-Agent 且不能修改，中科大会拒绝个别发行版（如 Omarchy）的请求，这类机器要绕开，其他机器不受影响。
