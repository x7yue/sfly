#!/usr/bin/python3 -I
"""工作台的出网名单（#498）：在工作台的网络命名空间里用 iptables 只放行名单，其余出站连接被拒。

compose 里由 `sfly-workbench-firewall` 运行（同一个工作台镜像，root，只加 NET_ADMIN），
网络命名空间归它，工作台用 `network_mode: service:sfly-workbench-firewall` 共用。
工作台本身没有 NET_ADMIN，改不了规则。

启动顺序：先写只放行回环的 IPv6、IPv4 规则，再解析名单、写完整的 IPv4 规则，
最后才在 127.0.0.1:READY_PORT 上应答。这个端口在共用的网络命名空间里，工作台的入口脚本
连得上它才往下走（entrypoint.sh 的 SFLY_WORKBENCH_REQUIRE_FIREWALL）：不论 compose 起、
Docker 按 restart 策略恢复还是手工 docker start，本次的规则写好之前工作台不运行。健康检查也看它。

放行：回环（含 Docker 内置 DNS 127.0.0.11）、已建立连接的回包、名单里的「主机:端口」（TCP）。名单：
- 控制面：SFLY_WORKBENCH_URL、SFLY_PUBLIC_URL、SFLY_PUBLIC_GRPC_URL
  （空时取公开地址的主机加 50051）；
- 包镜像：SFLY_PYPI_MIRROR、SFLY_GITHUB_RELEASE_MIRROR（没设时放行 uv 的官方来源 OFFICIAL_*，
  和 install.sh 一致）、SFLY_PYTHON_INSTALL_MIRROR；只认 http、https，file:// 和绝对路径的不出网；
- SFLY_WORKBENCH_EGRESS：部署者写的「主机:端口」，空格或逗号分隔。
写错时只报变量名、第几条和原因（不回显原值：可能误填了凭据），退出，工作台不会起来。
其余 TCP 回 RST，其余 IPv4 回 ICMP 不可达；IPv6 不允许主动新建非回环连接。
主机名每 60 秒重新解析，整套规则用 iptables-restore 原子替换：控制面和 SFLY_WORKBENCH_EGRESS
只放行当前解析到的地址（解析失败时沿用上一次的）；包镜像（CDN，每次给的地址不一样）放行一小时内解析到过的。
"""

from __future__ import annotations

import os
import re
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit

READY_PORT = 47123
GATEWAY_PORT = 50051
KEEP_SECONDS = 3600
REFRESH_SECONDS = 60
OFFICIAL_PYPI = ("pypi.org", "files.pythonhosted.org")
OFFICIAL_GITHUB_RELEASE = (
    "astral.sh",
    "releases.astral.sh",
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
)
LABEL = r"[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?"
HOST = re.compile(rf"{LABEL}(?:\.{LABEL})*")
IPV6 = re.compile(r"[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*")
HOST_PORT = re.compile(
    rf"(?:(?P<host>{HOST.pattern})|\[(?P<ipv6>{IPV6.pattern})\]):(?P<port>[0-9]{{1,5}})"
)


@dataclass(frozen=True, order=True)
class Entry:
    host: str
    port: int
    #: 包镜像：放行一小时内解析到过的地址；别的只放行当前解析到的。
    cdn: bool = False


class Invalid(ValueError):
    """名单写错了。消息里只有变量名、第几条和原因，没有原值。"""


def url_entry(name: str, url: str, cdn: bool) -> Entry | None:
    """URL 的主机和端口；file:// 和绝对路径（PyPI 镜像认）不出网（None）；写得不对时报错。"""
    parts = urlsplit(url.strip())
    scheme = parts.scheme.lower()
    if scheme == "file" or not scheme and url.strip().startswith("/"):
        return None
    if scheme not in ("http", "https"):
        raise Invalid(f"{name}：要是 http://、https://、file:// 开头的地址或绝对路径")
    host = parts.hostname or ""
    try:
        port = parts.port
    except ValueError:
        port = 0
    if not (HOST.fullmatch(host) or IPV6.fullmatch(host)):
        raise Invalid(f"{name}：主机名写得不对")
    if port == 0:
        raise Invalid(f"{name}：端口要在 1–65535 之间")
    return Entry(host, port or (443 if scheme == "https" else 80), cdn)


def egress_entries(text: str) -> list[Entry]:
    found: list[Entry] = []
    for index, item in enumerate(text.replace(",", " ").split(), 1):
        match = HOST_PORT.fullmatch(item)
        if not match or not 0 < int(match["port"]) < 65536:
            raise Invalid(
                f"SFLY_WORKBENCH_EGRESS 第 {index} 条：要写成「主机:端口」，端口在 1–65535 之间"
            )
        found.append(Entry(match["host"] or match["ipv6"], int(match["port"])))
    return found


def allowlist(env: Mapping[str, str]) -> list[Entry]:
    found: list[Entry | None] = []
    for name in ("SFLY_WORKBENCH_URL", "SFLY_PUBLIC_URL", "SFLY_PUBLIC_GRPC_URL"):
        url = env.get(name, "").strip()
        found.append(url_entry(name, url, cdn=False) if url else None)
    public = found[1]
    if not env.get("SFLY_PUBLIC_GRPC_URL", "").strip() and public is not None:
        found.append(Entry(public.host, GATEWAY_PORT))
    for name, official in (
        ("SFLY_PYPI_MIRROR", OFFICIAL_PYPI),
        ("SFLY_GITHUB_RELEASE_MIRROR", OFFICIAL_GITHUB_RELEASE),
        ("SFLY_PYTHON_INSTALL_MIRROR", ()),
    ):
        mirror = env.get(name, "").strip()
        if mirror:
            found.append(url_entry(name, mirror, cdn=True))
        else:
            found.extend(Entry(host, 443, cdn=True) for host in official)
    found.extend(egress_entries(env.get("SFLY_WORKBENCH_EGRESS", "")))
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
    """每一轮重新解析：控制面和部署者写的项放行这一轮解析到的（解析失败时沿用上一次的），包镜像放行一小时内解析到过的。"""

    def __init__(
        self,
        entries: list[Entry],
        lookup: Callable[[str, int], set[str]] = resolve,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.entries = entries
        self.lookup = lookup
        self.clock = clock
        self.current: dict[Entry, set[str]] = {}
        self.seen: dict[tuple[str, int], float] = {}

    def allowed(self) -> set[tuple[str, int]]:
        now = self.clock()
        for entry in self.entries:
            try:
                self.current[entry] = self.lookup(entry.host, entry.port)
            except OSError as error:
                print(
                    f"出网名单：解析不了 {entry.host}（{error}），沿用上一次的地址", file=sys.stderr
                )
                continue
            if entry.cdn:
                for ip in self.current[entry]:
                    self.seen[(ip, entry.port)] = now
        self.seen = {k: t for k, t in self.seen.items() if now - t <= KEEP_SECONDS}
        exact = {(ip, e.port) for e, ips in self.current.items() if not e.cdn for ip in ips}
        return exact | set(self.seen)


class Ready(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok\n")

    def log_message(self, format: str, *args: object) -> None:
        pass


def serve_ready() -> None:
    server = HTTPServer(("127.0.0.1", READY_PORT), Ready)
    threading.Thread(target=server.serve_forever, daemon=True).start()


def apply(command: str, rules: str) -> None:
    subprocess.run([command], input=rules, text=True, check=True)


def run(
    firewall: Firewall,
    write: Callable[[str, str], None] = apply,
    ready: Callable[[], None] = serve_ready,
    wait: Callable[[float], None] = time.sleep,
    rounds: int | None = None,
) -> None:
    """先只放行回环，再写完整的规则，然后才应答就绪；之后每 REFRESH_SECONDS 秒重写一次。"""
    write("ip6tables-restore", IPV6_RULES)
    write("iptables-restore", ipv4_rules(()))
    write("iptables-restore", ipv4_rules(firewall.allowed()))
    ready()
    print("出网名单：规则已写好", flush=True)
    done = 0
    while rounds is None or done < rounds:
        wait(REFRESH_SECONDS)
        write("iptables-restore", ipv4_rules(firewall.allowed()))
        done += 1


def main() -> int:
    try:
        entries = allowlist(os.environ)
    except Invalid as error:
        print(f"出网名单写错了，工作台不会起来：{error}", file=sys.stderr)
        return 1
    print("出网名单：" + " ".join(f"{e.host}:{e.port}" for e in entries), flush=True)
    run(Firewall(entries))
    return 0


if __name__ == "__main__":
    sys.exit(main())
