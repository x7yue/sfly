#!/usr/bin/python3 -I
"""工作台的出网名单（#498）：在工作台的网络命名空间里用 iptables 只放行名单，其余出站连接被拒。

compose 里由 `sfly-workbench-firewall` 运行（同一个工作台镜像，root，只加 NET_ADMIN），
网络命名空间归它，工作台用 `network_mode: service:sfly-workbench-firewall` 共用。
工作台本身没有 NET_ADMIN，改不了规则。

放行：回环（含 Docker 内置 DNS 127.0.0.11）、已建立连接的回包、名单里的「主机:端口」（TCP）。名单：
- 控制面：SFLY_WORKBENCH_URL、SFLY_PUBLIC_URL、SFLY_PUBLIC_GRPC_URL
  （空时取公开地址的主机加 50051）；
- 包镜像：SFLY_PYPI_MIRROR、SFLY_GITHUB_RELEASE_MIRROR；
  没设时放行 uv 的官方来源（OFFICIAL_*），和 install.sh 一致；
- SFLY_WORKBENCH_EGRESS：部署者写的「主机:端口」，空格或逗号分隔。
其余 TCP 回 RST，其余 IPv4 回 ICMP 不可达，IPv6 只放行回环。
主机名每 60 秒重新解析，整套规则用 iptables-restore 原子替换；
一小时内解析到过的地址都放行（CDN 每次给的地址不一样）。
第一次写好规则之后写 READY，健康检查看它。
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from collections.abc import Callable, Iterable, Mapping
from urllib.parse import urlsplit

READY = "/run/sfly-workbench-egress.ready"
GATEWAY_PORT = 50051
KEEP_SECONDS = 3600
REFRESH_SECONDS = 60
OFFICIAL_PYPI = ("pypi.org:443", "files.pythonhosted.org:443")
OFFICIAL_GITHUB_RELEASE = (
    "astral.sh:443",
    "releases.astral.sh:443",
    "github.com:443",
    "objects.githubusercontent.com:443",
    "release-assets.githubusercontent.com:443",
)

Entry = tuple[str, int]


def url_entry(url: str) -> Entry | None:
    """URL 的主机和端口；file:// 之类没有主机的不算（不出网）。"""
    parts = urlsplit(url.strip())
    if parts.hostname is None:
        return None
    default = 443 if parts.scheme == "https" else 80
    return parts.hostname, parts.port or default


def entry(text: str) -> Entry:
    host, sep, port = text.strip().rpartition(":")
    if not sep or not host or not port.isascii() or not port.isdigit() or not 0 < int(port) < 65536:
        raise ValueError(f"SFLY_WORKBENCH_EGRESS 里的「{text}」不是「主机:端口」")
    return host.strip("[]"), int(port)


def allowlist(env: Mapping[str, str]) -> list[Entry]:
    found: list[Entry | None] = []
    for name in ("SFLY_WORKBENCH_URL", "SFLY_PUBLIC_URL", "SFLY_PUBLIC_GRPC_URL"):
        found.append(url_entry(env.get(name, "")))
    public = url_entry(env.get("SFLY_PUBLIC_URL", ""))
    if not env.get("SFLY_PUBLIC_GRPC_URL", "").strip() and public is not None:
        found.append((public[0], GATEWAY_PORT))
    for name, official in (
        ("SFLY_PYPI_MIRROR", OFFICIAL_PYPI),
        ("SFLY_GITHUB_RELEASE_MIRROR", OFFICIAL_GITHUB_RELEASE),
    ):
        mirror = env.get(name, "").strip()
        found.extend([url_entry(mirror)] if mirror else [entry(e) for e in official])
    extra = env.get("SFLY_WORKBENCH_EGRESS", "").replace(",", " ").split()
    found.extend(entry(e) for e in extra)
    return sorted({e for e in found if e is not None})


def resolve(host: str, port: int) -> set[str]:
    infos = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)
    return {str(info[4][0]) for info in infos}


def ipv4_rules(allowed: Iterable[tuple[str, int]]) -> str:
    lines = [
        "*filter",
        ":OUTPUT DROP [0:0]",
        "-A OUTPUT -o lo -j ACCEPT",
        "-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
        *(f"-A OUTPUT -p tcp -d {ip} --dport {port} -j ACCEPT" for ip, port in sorted(allowed)),
        "-A OUTPUT -p tcp -j REJECT --reject-with tcp-reset",
        "-A OUTPUT -j REJECT --reject-with icmp-port-unreachable",
        "COMMIT",
    ]
    return "\n".join(lines) + "\n"


IPV6_RULES = (
    "\n".join(
        [
            "*filter",
            ":OUTPUT DROP [0:0]",
            "-A OUTPUT -o lo -j ACCEPT",
            "-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
            "-A OUTPUT -p tcp -j REJECT --reject-with tcp-reset",
            "-A OUTPUT -j REJECT",
            "COMMIT",
        ]
    )
    + "\n"
)


class Firewall:
    """记着每个名单项最近一小时解析到过的地址，每一轮重新解析、整套重写规则。"""

    def __init__(
        self,
        entries: list[Entry],
        lookup: Callable[[str, int], set[str]] = resolve,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.entries = entries
        self.lookup = lookup
        self.clock = clock
        self.seen: dict[tuple[str, int], float] = {}

    def allowed(self) -> set[tuple[str, int]]:
        now = self.clock()
        for host, port in self.entries:
            try:
                addresses = self.lookup(host, port)
            except OSError as error:
                print(f"出网名单：解析不了 {host}（{error}），这一轮没有新地址", file=sys.stderr)
                continue
            for ip in addresses:
                self.seen[(ip, port)] = now
        self.seen = {k: t for k, t in self.seen.items() if now - t <= KEEP_SECONDS}
        return set(self.seen)


def apply(command: str, rules: str) -> None:
    subprocess.run([command], input=rules, text=True, check=True)


def main() -> int:
    entries = allowlist(os.environ)
    print("出网名单：" + " ".join(f"{h}:{p}" for h, p in entries), flush=True)
    firewall = Firewall(entries)
    apply("ip6tables-restore", IPV6_RULES)
    while True:
        apply("iptables-restore", ipv4_rules(firewall.allowed()))
        if not os.path.exists(READY):
            with open(READY, "w") as ready:
                ready.write("ok\n")
            print("出网名单：规则已写好", flush=True)
        time.sleep(REFRESH_SECONDS)


if __name__ == "__main__":
    sys.exit(main())
