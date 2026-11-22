#!/usr/bin/env bash
# 工作区的 Rust 编译结果（卷里 /vol/<工作区>/target）超过上限时清掉一部分（#579）。
#
# cargo 不清自己 target 里的旧东西：同一个工作区跑过不同的 cargo 命令（`--workspace`、`-p`、clippy、各个测试文件……）
# 之后，每种参数组合各留一份带调试信息的测试可执行文件（一个 100 多 MB），两天里一个工作区长到 7.7 GB。
# 这里在每次运行开始时量一下：
# 1. 超过上限：先删增量编译的缓存（target/<profile>/incremental，只加快改动一个 crate 之后的重编，删了不影响其余）；
# 2. 还是超过：整个 target 删掉，这次运行从头编译（几分钟），之后重新长起来。
# 上限默认 5120 MB，用 SFLY_LINUX_TARGET_LIMIT_MB 改（entry.sh 在容器里调用，宿主上改 ~/.zshrc 之类里的环境变量即可）。
#
# 用法：trim-target.sh <target 目录> [上限 MB]
set -euo pipefail

dir=${1:?用法：trim-target.sh <target 目录> [上限 MB]}
limit=${2:-${SFLY_LINUX_TARGET_LIMIT_MB:-5120}}
case $dir in "" | / | .) echo "trim-target.sh：不删 $dir" >&2; exit 2 ;; esac
[[ -d $dir ]] || exit 0

size_mb() { echo $(($(du -sk "$dir" | cut -f1) / 1024)); }
before=$(size_mb)
((before > limit)) || exit 0

shopt -s nullglob
rm -rf -- "$dir"/*/incremental
after=$(size_mb)
if ((after <= limit)); then
	echo "pnpm linux：编译结果 ${before} MB 超过上限 ${limit} MB（SFLY_LINUX_TARGET_LIMIT_MB），已清掉增量编译的缓存，现在 ${after} MB" >&2
	exit 0
fi
rm -rf -- "$dir"
echo "pnpm linux：编译结果 ${before} MB 超过上限 ${limit} MB（SFLY_LINUX_TARGET_LIMIT_MB），清掉增量编译的缓存后还有 ${after} MB，已整个删掉：这次运行从头编译" >&2
