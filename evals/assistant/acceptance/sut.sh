#!/bin/sh
# 骨架验收（#553）的被测机：普通 Agent sut-01（不是开发方式），加上评测集的示例 HTTP 服务（http://sut:9000）。
# 用工作台镜像（里面有 curl 和 python3），以 root 运行：示例服务把访问日志写在 /var/log/demo-svc/。
# Agent 凭据经环境变量 SFLY_SUT_TOKEN 交给 install.sh（它写进 agent.env），不进命令行参数。
set -eu
mkdir -p /var/log/demo-svc
python3 /accept/demo_svc.py --port 9000 >>/var/log/demo-svc/stdout.log 2>&1 &
if [ ! -x "$HOME/.sfly/bin/sfly-agent" ]; then
	curl -fsSLq "$SFLY_SUT_URL/install.sh" | SFLY_TOKEN="$SFLY_SUT_TOKEN" sh -s -- --name sut-01 --no-service
fi
unset SFLY_SUT_TOKEN
exec "$HOME/.sfly/bin/sfly-agent"
