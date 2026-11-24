#!/usr/bin/env bash
# 把数据库地址里指向本机的主机名（127.0.0.1、localhost、[::1]，有没有用户名密码、有没有端口都行）换成 host.docker.internal，
# 给 macOS 上的 Docker Desktop 用：容器里的 `--network host` 指的是它的虚拟机、不是这台电脑（见 e2e-docker.sh）。
# 只换主机名那一段：别的主机名（db.example.com、localhost.example.com）、路径和查询参数里的 localhost 原样不动。
# 用法：bash scripts/docker-host-url.sh <地址>
set -euo pipefail
printf '%s' "$1" | sed -E 's#(://([^/@]*@)?)(127\.0\.0\.1|localhost|\[::1\])([:/?]|$)#\1host.docker.internal\4#'
