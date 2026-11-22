# shellcheck shell=bash
# `pnpm linux` 里 cargo 的编译配置（#587）：被 entry.sh `source`，不单独运行。
#
# 调试信息只留行号表（`line-tables-only`）：panic 的回溯里还是 文件:行号，只是调试器看不到变量的类型信息。
# 带完整调试信息时每个测试可执行文件 100 多 MB，同一个工作区跑过 `--workspace`、`-p`、各个测试文件之后一个 target
# 长到几个 GB（卷里的磁盘占用，见 trim-target.sh）；这里的取值让同样的构建小得多、也快一些。
# 只在 `pnpm linux` 里设：CI 和本机直接跑 cargo 不受影响。调用者已经设了（宿主上 `export CARGO_PROFILE_DEV_DEBUG=true`
# 会经 run.sh 传进来）就不覆盖；想要完整的调试信息就设成 `true`。
# 配置变了之后，已有的 target 里的东西要整个重编一次（调试信息是编译指纹的一部分）。
export CARGO_PROFILE_DEV_DEBUG=${CARGO_PROFILE_DEV_DEBUG:-line-tables-only}
export CARGO_PROFILE_TEST_DEBUG=${CARGO_PROFILE_TEST_DEBUG:-line-tables-only}
