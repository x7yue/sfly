# Agent 二进制随控制面镜像发布，由控制面提供下载和安装脚本

控制面镜像带上同版本的 x86_64 和 aarch64 musl Agent 二进制，控制面提供下载地址和一键安装脚本 `install.sh`（识别架构、下载并校验 sha256、写入 `~/.sfly/agent.env`、注册 systemd 服务；`--dev` 时再安装开发用的 `sfly` CLI）。测试机和开发机通常访问不到 GitHub，而它们一定能访问控制面；这与 SDK wheel 由控制面提供（ADR 0010）是同一个思路，也是 Agent 自更新（ADR 0014）的下载来源。这修订了 ADR 0010 中「镜像里不带 Agent」的做法；Release 附件里仍然保留 Agent，供首次部署或离线分发。

## Considered Options

- **只放 Release 附件**：内网机器要先从别处拿到附件再拷过去，自更新也没有可用的下载来源。
- **由控制面在运行时从 GitHub 或镜像站拉取**：控制面不一定能访问外网，版本也可能和控制面对不上。

## Consequences

- 镜像增大约 20 MB。
- 安装脚本由控制面生成，信任边界与自更新相同：都信任控制面。
