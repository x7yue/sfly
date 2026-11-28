"""工作台的出网名单（deploy/workbench/firewall.py，#498）：名单从哪些变量来、写错了怎么报、
规则长什么样、授权从哪来到什么时候为止、启动时先写规则再应答就绪。
真的写规则、连不连得通在 compose 冒烟里（scripts/release/compose-smoke.sh）。"""

from __future__ import annotations

import importlib.util
import json
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "workbench" / "firewall.py"
spec = importlib.util.spec_from_file_location("firewall", SCRIPT)
assert spec is not None and spec.loader is not None
firewall = importlib.util.module_from_spec(spec)
sys.modules["firewall"] = firewall
spec.loader.exec_module(firewall)
Entry = firewall.Entry

OFFICIAL = [
    Entry(h, 443, cdn=True) for h in (*firewall.OFFICIAL_PYPI, *firewall.OFFICIAL_GITHUB_RELEASE)
]
NO_MIRRORS = {"SFLY_PYPI_MIRROR": "file:///p", "SFLY_GITHUB_RELEASE_MIRROR": "file:///g"}
GRACE = firewall.GRACE_SECONDS
KEEP = firewall.KEEP_SECONDS


def pairs(entries: list[object]) -> list[tuple[str, int, bool]]:
    return [(e.host, e.port, e.cdn) for e in entries]  # type: ignore[attr-defined]


# ---- 名单从哪些变量来 ----


def test_control_plane_and_mirrors_are_allowed_and_nothing_else() -> None:
    env = {
        "SFLY_WORKBENCH_URL": "http://sfly:8080",
        "SFLY_PUBLIC_URL": "https://SFLY.example.com",
        "SFLY_PUBLIC_GRPC_URL": "http://sfly.example.com:50051",
        "SFLY_PYPI_MIRROR": "https://user:pw@mirrors.example.com/pypi/simple",
        "SFLY_GITHUB_RELEASE_MIRROR": "http://mirror.internal:8000/github-release",
        "SFLY_PYTHON_INSTALL_MIRROR": "https://python.example.net/standalone/",
    }
    # 包镜像标成 cdn（放行一小时内解析到过的地址），控制面不是。主机名统一成小写。
    assert pairs(firewall.allowlist(env)) == [
        ("mirror.internal", 8000, True),
        ("mirrors.example.com", 443, True),
        ("python.example.net", 443, True),
        ("sfly", 8080, False),
        ("sfly.example.com", 443, False),
        ("sfly.example.com", 50051, False),
    ]


def test_without_a_grpc_url_the_gateway_is_the_public_host_on_50051() -> None:
    env = {
        "SFLY_WORKBENCH_URL": "http://sfly:8080",
        "SFLY_PUBLIC_URL": "http://sfly.example.com:8080",
        **NO_MIRRORS,
        "SFLY_PYPI_MIRROR": "/srv/pypi/simple",
        "SFLY_PYTHON_INSTALL_MIRROR": "FILE:///srv/python",
    }
    # file:// 和绝对路径（uv 的 --default-index 认）的镜像不出网，不放行任何地址。
    assert pairs(firewall.allowlist(env)) == [
        ("sfly", 8080, False),
        ("sfly.example.com", 8080, False),
        ("sfly.example.com", 50051, False),
    ]


def test_without_mirrors_uv_official_sources_are_allowed() -> None:
    allowed = firewall.allowlist({"SFLY_WORKBENCH_URL": "http://sfly:8080"})
    assert allowed == sorted({Entry("sfly", 8080), *OFFICIAL})


def test_extra_entries_are_host_port_pairs_separated_by_spaces_or_commas() -> None:
    env = {**NO_MIRRORS, "SFLY_WORKBENCH_EGRESS": " db.internal:5432,sut:9000  10.0.0.7:22 "}
    assert pairs(firewall.allowlist(env)) == [
        ("10.0.0.7", 22, False),
        ("db.internal", 5432, False),
        ("sut", 9000, False),
    ]


# ---- 写错了怎么报：真的运行脚本，以「名单写错」退出，不回显原文，没有 traceback ----

MARK = "s3cr3tmark"
SCHEME = "要是 http://、https://、file:// 开头的地址或绝对路径"
PORT = "端口要在 1–65535 之间"
HOST = "主机名写得不对"
IPV4 = "IP 地址要写成四段十进制"
IPV6 = "不支持 IPv6 地址"
BAD = [
    # (变量, 值, 原因)
    ("SFLY_WORKBENCH_EGRESS", f"[{MARK}]:80", IPV6),
    ("SFLY_WORKBENCH_EGRESS", f"[{MARK}:80", IPV6),
    ("SFLY_WORKBENCH_EGRESS", "[fd00::1]:80", IPV6),
    ("SFLY_WORKBENCH_EGRESS", f"{MARK}", "要写成「主机:端口」"),
    ("SFLY_WORKBENCH_EGRESS", f"{MARK}:", PORT),
    ("SFLY_WORKBENCH_EGRESS", f"{MARK}:0", PORT),
    ("SFLY_WORKBENCH_EGRESS", f"{MARK}:65536", PORT),
    ("SFLY_WORKBENCH_EGRESS", f"{MARK}:http", PORT),
    ("SFLY_WORKBENCH_EGRESS", f"{MARK}:٣", PORT),
    ("SFLY_WORKBENCH_EGRESS", f":{MARK}", HOST),
    ("SFLY_WORKBENCH_EGRESS", f"https://{MARK}.example:443", HOST),
    ("SFLY_WORKBENCH_EGRESS", f"user@{MARK}.example:443", HOST),
    ("SFLY_WORKBENCH_EGRESS", f"{MARK}.example/x:443", HOST),
    # 数字写法的地址：getaddrinfo 会把它们解析成 127.0.0.1、1.2.0.3。
    ("SFLY_WORKBENCH_EGRESS", "2130706433:80", IPV4),
    ("SFLY_WORKBENCH_EGRESS", "0x7f.1:80", IPV4),
    ("SFLY_WORKBENCH_EGRESS", "1.2.3:80", IPV4),
    ("SFLY_WORKBENCH_EGRESS", f"{MARK}.300:80", IPV4),
    # 整段十六进制、八进制：标准库不查 DNS 就认作 192.0.2.1，不是四段十进制的写法。
    ("SFLY_WORKBENCH_EGRESS", "0xc0000201:80", IPV4),
    ("SFLY_WORKBENCH_EGRESS", "0XC0000201:80", IPV4),
    ("SFLY_WORKBENCH_EGRESS", "0300.0.2.1:80", IPV4),
    ("SFLY_PYPI_MIRROR", f"https://0xc0000201/{MARK}", IPV4),
    ("SFLY_PYPI_MIRROR", f"http://[{MARK}/simple", "地址写得不对"),
    ("SFLY_PYPI_MIRROR", f"https://[{MARK}]/simple", "地址写得不对"),
    ("SFLY_PYPI_MIRROR", f"https://[fd00::1]/{MARK}", IPV6),
    ("SFLY_PYPI_MIRROR", f"ftp://{MARK}@mirror.example/pypi", SCHEME),
    ("SFLY_PYPI_MIRROR", f"mirror.example/{MARK}", SCHEME),
    ("SFLY_GITHUB_RELEASE_MIRROR", f"https://user:{MARK}@mirror.example:99999/", PORT),
    ("SFLY_GITHUB_RELEASE_MIRROR", f"https://{MARK}@mirror.example:x/", PORT),
    ("SFLY_PUBLIC_URL", f"https://{MARK}:pw@/x", HOST),
    ("SFLY_PYTHON_INSTALL_MIRROR", f"https://bad host {MARK}/", HOST),
    ("SFLY_PUBLIC_GRPC_URL", f"http://0x7f.1:50051/{MARK}", IPV4),
]


@pytest.mark.parametrize(("name", "value", "reason"), BAD)
def test_a_bad_value_stops_the_firewall_with_only_its_name_and_reason(
    name: str, value: str, reason: str
) -> None:
    env = {"PATH": "/usr/bin:/bin", **NO_MIRRORS, name: value}
    if name == "SFLY_WORKBENCH_EGRESS":
        env[name] = f"ok.internal:80 {value}"
        name = "SFLY_WORKBENCH_EGRESS 第 2 条"
    result = subprocess.run(
        [sys.executable, "-I", str(SCRIPT)], env=env, capture_output=True, text=True, timeout=30
    )
    assert result.returncode == 1
    assert result.stderr == f"出网名单写错了，工作台不会起来：{name}：{reason}\n"
    assert MARK not in result.stdout + result.stderr
    assert "Traceback" not in result.stderr


def test_rules_drop_by_default_and_accept_loopback_replies_and_the_allowlist() -> None:
    rules = firewall.ipv4_rules({("172.18.0.3", 8080), ("10.0.0.7", 22)}).splitlines()
    assert rules == [
        "*filter",
        ":OUTPUT DROP [0:0]",
        "-A OUTPUT -o lo -j ACCEPT",
        "-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
        "-A OUTPUT -p tcp -d 10.0.0.7 --dport 22 -j ACCEPT",
        "-A OUTPUT -p tcp -d 172.18.0.3 --dport 8080 -j ACCEPT",
        "-A OUTPUT -p tcp -j REJECT --reject-with tcp-reset",
        "-A OUTPUT -j REJECT --reject-with icmp-port-unreachable",
        "COMMIT",
    ]
    assert ":OUTPUT DROP [0:0]" in firewall.IPV6_RULES
    assert "-A OUTPUT -p tcp -j REJECT --reject-with tcp-reset" in firewall.IPV6_RULES


# ---- 授权：放行的每个地址都来自期限内某次成功的解析 ----

FAIL = None  # 这一轮解析失败（DNS 一时不通）
Round = tuple[float, dict[str, set[str] | None]]


def check_rounds(entries: list[Any], rounds: list[Round]) -> list[set[tuple[str, int]]]:
    """每一轮之后断言：放行的每个地址都来自期限内某次成功的解析（普通项：它最近一次成功的解析）。"""
    answers: dict[str, set[str] | None] = {}

    def lookup(host: str, port: int) -> set[str]:
        answer = answers[host]
        if answer is None:
            raise OSError("Temporary failure in name resolution")
        return set(answer)

    now = [0.0]
    grants = firewall.Grants(entries, lookup, lambda: now[0])
    successes: list[tuple[float, Any, set[str]]] = []
    results = []
    for at, this_round in rounds:
        now[0] = at
        answers.clear()
        answers.update(this_round)
        allowed = grants.allowed()
        successes += [(at, e, ips) for e in entries if (ips := this_round[e.host]) is not None]
        for ip, port in allowed:
            sources = []
            for entry in (e for e in entries if e.port == port):
                own = [(t, ips) for t, e, ips in successes if e == entry]
                if entry.cdn:
                    sources += [t for t, ips in own if ip in ips and at - t < KEEP]
                elif own and ip in own[-1][1] and at - own[-1][0] < GRACE:
                    sources.append(own[-1][0])
            assert sources, f"第 {at} 秒放行的 {ip}:{port} 不来自期限内的成功解析"
        results.append(allowed)
    return results


def test_an_ordinary_entry_follows_successful_resolutions_and_a_failure_renews_nothing() -> None:
    got = check_rounds(
        [Entry("sfly", 8080)],
        [
            (0, {"sfly": {"172.18.0.3"}}),
            # 换了地址：旧地址马上撤销（它可能分给了别的服务）。
            (60, {"sfly": {"172.18.0.4"}}),
            # 一时解析不了：不续期，宽限期内照旧放行……
            (120, {"sfly": FAIL}),
            (60 + GRACE - 1, {"sfly": FAIL}),
            # ……过了宽限期就撤销，不再沿用。
            (60 + GRACE, {"sfly": FAIL}),
            # 恢复之后重新放行。
            (60 + GRACE + 60, {"sfly": {"172.18.0.4"}}),
            # 名字不存在（服务删了）是成功的空结果：马上撤销，不等宽限期。
            (60 + GRACE + 120, {"sfly": set()}),
        ],
    )
    assert got == [
        {("172.18.0.3", 8080)},
        {("172.18.0.4", 8080)},
        {("172.18.0.4", 8080)},
        {("172.18.0.4", 8080)},
        set(),
        {("172.18.0.4", 8080)},
        set(),
    ]


def test_a_mirror_keeps_addresses_seen_within_an_hour_and_a_failure_renews_nothing() -> None:
    cdn = "cdn.example.com"
    got = check_rounds(
        [Entry(cdn, 443, cdn=True)],
        [
            (0, {cdn: {"1.1.1.1"}}),
            (1800, {cdn: {"2.2.2.2"}}),
            (3000, {cdn: FAIL}),
            (KEEP, {cdn: FAIL}),
            (1800 + KEEP, {cdn: FAIL}),
            (1800 + KEEP + 60, {cdn: {"3.3.3.3"}}),
        ],
    )
    assert got == [
        {("1.1.1.1", 443)},
        {("1.1.1.1", 443), ("2.2.2.2", 443)},
        {("1.1.1.1", 443), ("2.2.2.2", 443)},
        {("2.2.2.2", 443)},
        set(),
        {("3.3.3.3", 443)},
    ]


def test_a_mirror_whose_name_no_longer_exists_is_revoked_at_once() -> None:
    cdn = "mirror.internal"
    got = check_rounds(
        [Entry(cdn, 443, cdn=True), Entry("other.internal", 443, cdn=True)],
        [
            (0, {cdn: {"10.0.0.1"}, "other.internal": {"10.0.0.9"}}),
            (60, {cdn: {"10.0.0.2"}, "other.internal": {"10.0.0.9"}}),
            # 名字不存在（权威的否定）：这个名单项自己的地址全部撤销，不等一小时；
            # 别的名单项不受影响。
            (120, {cdn: set(), "other.internal": {"10.0.0.9"}}),
            (180, {cdn: {"10.0.0.3"}, "other.internal": {"10.0.0.9"}}),
        ],
    )
    assert got == [
        {("10.0.0.1", 443), ("10.0.0.9", 443)},
        {("10.0.0.1", 443), ("10.0.0.2", 443), ("10.0.0.9", 443)},
        {("10.0.0.9", 443)},
        {("10.0.0.3", 443), ("10.0.0.9", 443)},
    ]


def test_terms_start_when_a_lookup_returns_and_expiry_is_judged_when_the_round_ends() -> None:
    # 旧授权第 180 秒到期；刷新在第 179 秒开始，解析慢、第 181 秒才失败返回：
    # 这一轮的规则里不能再有它。
    now = [0.0]
    answers: list[set[str] | None] = [{"172.18.0.3"}, None, {"172.18.0.3"}]

    def lookup(host: str, port: int) -> set[str]:
        answer = answers.pop(0)
        now[0] += 2
        if answer is None:
            raise OSError("Temporary failure in name resolution")
        return answer

    grants = firewall.Grants([Entry("sfly", 8080)], lookup, lambda: now[0])
    now[0] = -2  # 第一次解析在第 0 秒返回：期限到第 180 秒。
    assert grants.allowed() == {("172.18.0.3", 8080)}
    now[0] = 179
    assert grants.allowed() == set()
    # 成功的解析按返回的时刻续期：第 300 秒开始、第 302 秒返回，期限到第 482 秒。
    now[0] = 300
    assert grants.allowed() == {("172.18.0.3", 8080)}
    assert grants.expiry == {(Entry("sfly", 8080), "172.18.0.3"): 302 + GRACE}


def test_entries_sharing_a_port_are_granted_independently() -> None:
    # 同一个端口的两项：一项撤销不影响另一项解析到的地址。
    got = check_rounds(
        [Entry("a.internal", 443), Entry("b.internal", 443)],
        [
            (0, {"a.internal": {"10.0.0.1"}, "b.internal": {"10.0.0.2"}}),
            (60, {"a.internal": set(), "b.internal": {"10.0.0.2"}}),
        ],
    )
    assert got[-1] == {("10.0.0.2", 443)}


def raising(code: int) -> Callable[..., object]:
    def getaddrinfo(*_: object) -> object:
        raise socket.gaierror(code, "x")

    return getaddrinfo


def test_a_missing_name_is_an_empty_answer_and_other_failures_raise(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(firewall.socket, "getaddrinfo", raising(socket.EAI_NONAME))
    assert firewall.resolve("gone.internal", 80) == set()
    monkeypatch.setattr(firewall.socket, "getaddrinfo", raising(socket.EAI_AGAIN))
    with pytest.raises(OSError):
        firewall.resolve("flaky.internal", 80)


# ---- 启动顺序 ----


def test_startup_writes_deny_rules_then_the_allowlist_and_only_then_answers_ready() -> None:
    events: list[str] = []

    def resolving(host: str, port: int) -> set[str]:
        events.append(f"resolve {host}")
        return {"172.18.0.3"}

    def write(command: str, rules: str) -> None:
        allowed = [line for line in rules.splitlines() if "--dport" in line]
        events.append(f"{command} {len(allowed)}")

    grants = firewall.Grants([Entry("sfly", 8080)], resolving)
    firewall.run(
        grants, write, lambda: events.append("ready"), lambda _: events.append("wait"), rounds=1
    )
    assert events == [
        # 两种地址族先只放行回环（解析名单要时间，这期间什么也出不去）。
        "ip6tables-restore 0",
        "iptables-restore 0",
        "resolve sfly",
        "iptables-restore 1",
        # 完整的规则写好之后才应答就绪；工作台入口等的就是它。
        "ready",
        "wait",
        "resolve sfly",
        "iptables-restore 1",
    ]


def test_a_failing_rule_write_never_answers_ready() -> None:
    def write(command: str, rules: str) -> None:
        raise firewall.subprocess.CalledProcessError(1, command)

    ready: list[str] = []
    with pytest.raises(firewall.subprocess.CalledProcessError):
        firewall.run(firewall.Grants([]), write, lambda: ready.append("ready"), rounds=0)
    assert ready == []


# ---- 探测（#498）：测量方是出网名单这个进程，只接受控制面的连接 ----


def listening() -> tuple[socket.socket, int]:
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen()
    return server, server.getsockname()[1]


def closed_port() -> int:
    server, port = listening()
    server.close()
    return port


def test_dial_tells_open_closed_and_unmeasured_apart(monkeypatch: pytest.MonkeyPatch) -> None:
    # 回环段的数字地址是 error（会连到工作台自己），这里经域名 localhost 连本机的端口。
    server, port = listening()
    try:
        assert firewall.dial(f"localhost:{port}") == "open"
        assert firewall.dial(f"localhost:{closed_port()}") == "closed"
    finally:
        server.close()

    def failing(error: OSError) -> Callable[..., object]:
        def connect(*_: object) -> object:
            raise error

        return connect

    for error, result in (
        (TimeoutError(), "closed"),
        (OSError(firewall.errno.EHOSTUNREACH, "x"), "closed"),
        (OSError(firewall.errno.ENETUNREACH, "x"), "closed"),
        (OSError(firewall.errno.EMFILE, "x"), "error"),
        (OSError(firewall.errno.ENOBUFS, "x"), "error"),
        (socket.gaierror(socket.EAI_NONAME, "x"), "error"),
    ):
        monkeypatch.setattr(firewall.socket, "create_connection", failing(error))
        assert firewall.dial("10.0.0.9:50052") == result


def test_a_batch_mixing_good_and_bad_targets_keeps_count_and_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 目标是别的项目的 Agent 自报的地址，什么文字都可能有：坏的记 error、不去连，好的照常测。
    dialed: list[tuple[str, int]] = []

    def connect(address: tuple[str, int], timeout: float) -> socket.socket:
        dialed.append(address)
        if address[0] == "closed.internal":
            raise ConnectionRefusedError
        return socket.socket()

    monkeypatch.setattr(firewall.socket, "create_connection", connect)
    targets = [
        "open.internal:50052",
        f"{'a' * 64}.internal:50052",  # 标签超长（IDNA 编码会抛 UnicodeError）
        "a..b:50052",  # 空标签
        "[fd00::1]:50052",  # IPv6
        "fd00::1:50052",
        "open.internal:70000",  # 端口越界
        "0x7f.1:50052",  # 数字写法的地址
        "2130706433:50052",
        "127.0.0.1:50052",  # 回环段：会连到工作台自己
        "127.8.9.10:50052",
        "closed.internal:50052",
        "10.0.0.9:50052",
        "",
    ]
    assert [firewall.dial(t) for t in targets] == [
        "open",
        *["error"] * 9,
        "closed",
        "open",
        "error",
    ]
    assert dialed == [("open.internal", 50052), ("closed.internal", 50052), ("10.0.0.9", 50052)]


def post(port: int, body: bytes, headers: dict[str, str] | None = None) -> tuple[int, object]:
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/probe", data=body, method="POST", headers=headers or {}
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def raw(port: int, data: bytes = b"", wait: float = 30) -> bytes:
    """连上去（可选发一点），读到对面关为止；`wait` 秒内对面没关就抛 TimeoutError。"""
    with socket.create_connection(("127.0.0.1", port), wait) as conn:
        if data:
            conn.sendall(data)
        chunks = []
        try:
            while chunk := conn.recv(65536):
                chunks.append(chunk)
        except ConnectionResetError:
            pass  # 对面没读就关了：我们发的字节它没收
        return b"".join(chunks)


@pytest.fixture
def probe_server() -> Any:
    """一个探测服务和它认的来源（测试里改它：控制面在不在本机）。"""
    sources: set[str] = {"127.0.0.1"}
    server = firewall.serve_probe(lambda: set(sources), port=0)
    yield server, sources
    server.shutdown()
    server.server_close()


def test_the_probe_answers_the_control_plane_in_order(probe_server: Any) -> None:
    server, _ = probe_server
    port = server.server_address[1]
    listener, open_port = listening()
    try:
        targets = [f"localhost:{open_port}", f"localhost:{closed_port()}", "x", "127.0.0.1:1"]
        assert post(port, json.dumps({"targets": targets}).encode()) == (
            200,
            {"results": ["open", "closed", "error", "error"]},
        )
    finally:
        listener.close()
    too_many = json.dumps({"targets": ["x:1"] * (firewall.PROBE_MAX_TARGETS + 1)}).encode()
    assert post(port, too_many)[0] == 400
    assert post(port, b"not json")[0] == 400
    assert post(port, b'{"targets": [1]}')[0] == 400


@pytest.mark.parametrize(
    "length",
    ["+15", "1_5", "١٥", "-1", "0x0f", "1 5", "", "0", "99999999999", "9" * 19, "9" * 5000],
)
def test_a_bad_length_header_is_a_plain_400(probe_server: Any, length: str) -> None:
    server, _ = probe_server
    body = b'{"targets": []}'
    request = (
        b"POST /probe HTTP/1.1\r\nHost: x\r\nConnection: close\r\n"
        + f"Content-Length: {length}\r\n\r\n".encode()
        + body
    )
    assert raw(server.server_address[1], request).startswith(b"HTTP/1.0 400")


def test_a_length_header_with_surrounding_spaces_is_read(probe_server: Any) -> None:
    server, _ = probe_server
    request = (
        b"POST /probe HTTP/1.1\r\nHost: x\r\nConnection: close\r\n"
        b"Content-Length:  15 \r\n\r\n" + b'{"targets": []}'
    )
    assert raw(server.server_address[1], request).startswith(b"HTTP/1.0 200")


def test_other_sources_are_closed_before_any_byte_is_read(probe_server: Any) -> None:
    server, sources = probe_server
    port = server.server_address[1]
    # 来源不在授权表里（比如工作台自己）：一个字节也不发，连接也马上被关；没有任何应答。
    # 两秒内就被关（放进来的话，没发完的请求要等十秒的读取期限）。
    sources.clear()
    assert raw(port, wait=2) == b""
    assert raw(port, b"POST /probe HTTP/1.1\r\n", wait=2) == b""
    # 之后控制面的请求照常得到应答。
    sources.add("127.0.0.1")
    assert post(port, b'{"targets": []}') == (200, {"results": []})


def test_a_slow_request_times_out_and_the_next_is_answered(
    probe_server: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    server, _ = probe_server
    monkeypatch.setattr(firewall.Probe, "timeout", 0.5)
    port = server.server_address[1]
    # 只发半个请求头就不动了：读请求的期限到了就关掉，不一直占着唯一的处理线程。
    assert raw(port, b"POST /probe HTTP/1.1\r\nContent-") == b""
    assert post(port, b'{"targets": []}') == (200, {"results": []})


def test_the_probe_port_is_taken_before_ready_is_answered() -> None:
    events: list[str] = []
    start = firewall.serving(
        lambda: set(), lambda _allowed: events.append("probe"), lambda: events.append("ready")
    )
    start()
    assert events == ["probe", "ready"]

    # 探测端口绑不上（被占了）：抛错，不应答就绪（进程退出，容器按 restart 策略重来）。
    taken = socket.socket()
    taken.bind(("0.0.0.0", 0))
    taken.listen()
    port = taken.getsockname()[1]
    events.clear()
    try:
        bind = firewall.serving(
            lambda: set(),
            lambda allowed: firewall.serve_probe(allowed, port=port),
            lambda: events.append("ready"),
        )
        with pytest.raises(OSError):
            bind()
        assert events == []
    finally:
        taken.close()


def test_the_control_plane_sources_come_from_the_grants_table() -> None:
    sfly = Entry("sfly", 8080)
    now = [0.0]
    grants = firewall.Grants([sfly], lambda host, port: {"172.18.0.3"}, lambda: now[0])
    assert grants.granted(sfly) == set()
    grants.allowed()
    assert grants.granted(sfly) == {"172.18.0.3"}
    assert grants.granted(Entry("other", 8080)) == set()
    assert grants.granted(None) == set()
    now[0] = GRACE  # 到期了：不再认它，哪怕还没到下一轮。
    assert grants.granted(sfly) == set()


def test_the_batch_size_matches_the_control_plane() -> None:
    # 控制面按这个数分批（apps/server/src/sessions/workbench-exposure.ts）。
    source = (SCRIPT.parents[2] / "apps/server/src/sessions/workbench-exposure.ts").read_text()
    assert f"PROBE_BATCH = {firewall.PROBE_MAX_TARGETS:_}" in source
