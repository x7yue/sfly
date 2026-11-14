#!/usr/bin/env bash
# Rust 的格式与 clippy（`pnpm lint:rust`）。
# Agent 只在 Linux 上编译（文件监视用 inotify）。在 macOS 等其他系统上，按本机架构的 Linux musl 目标检查库和可执行文件：
# 推送前的钩子在这些机器上也能跑。测试和 bench 的代码在别的系统上编译不了（criterion 依赖的 alloca 要 Linux 的 C 交叉编译器），
# 由 CI 的 rust job 检查；本机要检查用 `pnpm linux pnpm lint:rust`。
set -euo pipefail
cd "$(dirname "$0")/.."

cargo fmt --all --check
if [[ $(uname -s) == Linux ]]; then
	exec cargo clippy --workspace --all-targets --locked -- -D warnings
fi

arch=$(uname -m)
target=${arch/arm64/aarch64}-unknown-linux-musl
if command -v rustup >/dev/null; then rustup target add "$target" >/dev/null; fi
echo "lint:rust：$(uname -s) 上只检查 $target 的库和可执行文件，测试代码由 CI 检查（本机：pnpm linux pnpm lint:rust）" >&2
exec cargo clippy --workspace --lib --bins --locked --target "$target" -- -D warnings
