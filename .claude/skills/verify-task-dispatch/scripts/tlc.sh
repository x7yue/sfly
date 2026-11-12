#!/usr/bin/env bash
# 用固定版本的 TLC 跑一个配置：tlc.sh <模型.tla> <配置.cfg> [输出文件]
# 第一次运行时用 mise 安装 Java（Temurin 21），下载 tla2tools 1.8.0 并校验 sha256，都放在仓库之外。
# 退出码就是 TLC 的退出码：0 = 没有违例，12 = 不变式被违反，其它 = 模型或工具错误。
set -uo pipefail

JAVA=java@temurin-21.0.13+9.0.LTS
JAR_DIR=${SFLY_FORMAL_CACHE:-$HOME/.cache/sfly-formal}
JAR=$JAR_DIR/tla2tools-1.8.0.jar
JAR_SHA256=e1f11b75c4b5bc4478ba0ac5cb6ae28e40a01b0016bc33e0aa97da22dfdbcd7f
export TMPDIR=${TMPDIR:-$HOME/.t}
mkdir -p "$TMPDIR" "$JAR_DIR"

model=$(realpath "$1") cfg=$(realpath "$2") out=${3:-/dev/stdout}
[[ $out == /dev/stdout ]] || out=$(realpath -m "$out")
if [[ ! -f $JAR ]] || [[ $(sha256sum "$JAR" | cut -d' ' -f1) != "$JAR_SHA256" ]]; then
	curl -fsSL -o "$JAR.part" https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar || exit 2
	[[ $(sha256sum "$JAR.part" | cut -d' ' -f1) == "$JAR_SHA256" ]] || { echo "tla2tools.jar 的 sha256 不对" >&2; rm -f "$JAR.part"; exit 2; }
	mv "$JAR.part" "$JAR"
fi
mise where "$JAVA" >/dev/null 2>&1 || mise install "$JAVA" >&2 || exit 2

meta=$(mktemp -d "$TMPDIR/tlc-XXXXXX")
cd "$(dirname "$model")" || exit 2
mise exec "$JAVA" -- java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC \
	-workers auto -cleanup -metadir "$meta" -config "$cfg" "$(basename "$model")" >"$out" 2>&1
code=$?
rm -rf "$meta" ./*_TTrace_*
exit $code
