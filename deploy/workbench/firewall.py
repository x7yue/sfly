#!/usr/bin/python3 -I
"""工作台的出网名单（#498）：在工作台的网络命名空间里用 iptables 只放行名单，其余出站连接被拒。

信任关系：部署者写的环境变量可信，但会写错（还可能误填凭据），所以严格校验、报错不回显原文；
成功的 DNS 解析是授权的唯一来源，而且有期限；工作台里的模型这三样（变量、解析、规则）都改不了。

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
主机只认 IPv4 地址（四段十进制）和域名，不认 IPv6。
写错时只报变量名、第几条和原因，退出，工作台不会起来。
其余 TCP 回 RST，其余 IPv4 回 ICMP 不可达；IPv6 不允许主动新建非回环连接。

授权（Grants）：每个放行的地址都有到期时间，只有成功的解析能加入或续期，解析失败什么都不续。
每 60 秒解析一轮，整套规则用 iptables-restore 原子替换。控制面和 SFLY_WORKBENCH_EGRESS：
这次结果里没有的地址立刻撤销，有的续 GRACE_SECONDS；名字不存在是成功的空结果，全部撤销。
包镜像（CDN，每次给的地址不一样）：只续这次见到的，KEEP_SECONDS，不删别的。
"""

from __future__ import annotations

import ipaddress
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
GRACE_SECONDS = 180
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
LABEL = re.compile(r"[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?")
PORT = re.compile(r"[0-9]{1,5}")
NOT_FOUND = {getattr(socket, n) for n in ("EAI_NONAME", "EAI_NODATA") if hasattr(socket, n)}


@dataclass(frozen=True, order=True)
class Entry:
    host: str
    port: int
    #: 包镜像：放行 KEEP_SECONDS 内解析到过的地址；别的只放行最近一次成功解析到的。
    cdn: bool = False


class Invalid(ValueError):
    """名单写错了。消息里只有变量名、第几条和原因，没有原文。"""


def endpoint(text: str, url: bool, cdn: bool = False) -> Entry | str | None:
    """部署者写的一项（URL 或「主机:端口」）的名单项；写错时是原因（不含原文）；不出网时是 None。

    库函数的错在这里转成原因，调用方只看返回值。"""
    text = text.strip()
    default = 0
    if url:
        if text.startswith("/"):
            return None
        try:
            parts = urlsplit(text)
        except ValueError:
            return "地址写得不对"
        scheme = parts.scheme.lower()
        if scheme == "file":
            return None
        if scheme not in ("http", "https"):
            return "要是 http://、https://、file:// 开头的地址或绝对路径"
        default = 443 if scheme == "https" else 80
        text = parts.netloc.rpartition("@")[2]
    if text.startswith("["):
        return "不支持 IPv6 地址"
    host, sep, port = text.rpartition(":")
    if not sep:
        if not url:
            return "要写成「主机:端口」"
        host, port = text, str(default)
    host = host.lower()
    labels = host.split(".")
    if labels[-1].isascii() and labels[-1].isdigit():
        try:
            ipaddress.IPv4Address(host)
        except ValueError:
            return "IP 地址要写成四段十进制"
    elif len(host) > 253 or not all(LABEL.fullmatch(label) for label in labels):
        return "主机名写得不对"
    if not PORT.fullmatch(port) or not 0 < int(port) < 65536:
        return "端口要在 1–65535 之间"
    return Entry(host, int(port), cdn)


def allowlist(env: Mapping[str, str]) -> list[Entry]:
    found: list[Entry] = []

    def add(name: str, text: str, url: bool, cdn: bool = False) -> Entry | None:
        result = endpoint(text, url, cdn)
        if isinstance(result, str):
            raise Invalid(f"{name}：{result}")
        if result is not None:
            found.append(result)
        return result

    public = None
    for name in ("SFLY_WORKBENCH_URL", "SFLY_PUBLIC_URL", "SFLY_PUBLIC_GRPC_URL"):
        if env.get(name, "").strip():
            entry = add(name, env[name], url=True)
            public = entry if name == "SFLY_PUBLIC_URL" else public
    if not env.get("SFLY_PUBLIC_GRPC_URL", "").strip() and public is not None:
        found.append(Entry(public.host, GATEWAY_PORT))
    for name, official in (
        ("SFLY_PYPI_MIRROR", OFFICIAL_PYPI),
        ("SFLY_GITHUB_RELEASE_MIRROR", OFFICIAL_GITHUB_RELEASE),
        ("SFLY_PYTHON_INSTALL_MIRROR", ()),
    ):
        if env.get(name, "").strip():
            add(name, env[name], url=True, cdn=True)
        else:
            found.extend(Entry(host, 443, cdn=True) for host in official)
    items = env.get("SFLY_WORKBENCH_EGRESS", "").replace(",", " ").split()
    for index, item in enumerate(items, 1):
        add(f"SFLY_WORKBENCH_EGRESS 第 {index} 条", item, url=False)
    return sorted(set(found))


def resolve(host: str, port: int) -> set[str]:
    """IPv4 地址。名字不存在是成功的空结果；别的失败（DNS 一时不通）抛 OSError。"""
    try:
        infos = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)
    except socket.gaierror as error:
        if error.errno in NOT_FOUND:
            return set()
        raise
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


class Grants:
    """授权表：（名单项, 地址）→ 到期时间。放行的是没到期的。"""

    def __init__(
        self,
        entries: list[Entry],
        lookup: Callable[[str, int], set[str]] = resolve,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.entries = entries
        self.lookup = lookup
        self.clock = clock
        self.expiry: dict[tuple[Entry, str], float] = {}

    def allowed(self) -> set[tuple[str, int]]:
        now = self.clock()
        for entry in self.entries:
            try:
                addresses = self.lookup(entry.host, entry.port)
            except OSError as error:
                print(f"出网名单：这一轮解析不了 {entry.host}（{error}），不续期", file=sys.stderr)
                continue
            if not entry.cdn:
                for key in [k for k in self.expiry if k[0] == entry and k[1] not in addresses]:
                    del self.expiry[key]
            term = KEEP_SECONDS if entry.cdn else GRACE_SECONDS
            for ip in addresses:
                self.expiry[(entry, ip)] = now + term
        self.expiry = {key: until for key, until in self.expiry.items() if until > now}
        return {(ip, entry.port) for entry, ip in self.expiry}


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
    grants: Grants,
    write: Callable[[str, str], None] = apply,
    ready: Callable[[], None] = serve_ready,
    wait: Callable[[float], None] = time.sleep,
    rounds: int | None = None,
) -> None:
    """先只放行回环，再写完整的规则，然后才应答就绪；之后每 REFRESH_SECONDS 秒重写一次。"""
    write("ip6tables-restore", IPV6_RULES)
    write("iptables-restore", ipv4_rules(()))
    write("iptables-restore", ipv4_rules(grants.allowed()))
    ready()
    print("出网名单：规则已写好", flush=True)
    done = 0
    while rounds is None or done < rounds:
        wait(REFRESH_SECONDS)
        write("iptables-restore", ipv4_rules(grants.allowed()))
        done += 1


def main() -> int:
    try:
        entries = allowlist(os.environ)
    except Invalid as error:
        print(f"出网名单写错了，工作台不会起来：{error}", file=sys.stderr)
        return 1
    print("出网名单：" + " ".join(f"{e.host}:{e.port}" for e in entries), flush=True)
    run(Grants(entries))
    return 0


if __name__ == "__main__":
    sys.exit(main())
